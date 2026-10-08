/**
 * The commands this repository runs.
 *
 * `scrape` fetches the current session. The GitHub Action calls it daily and commits
 * the result; running it by hand does the same thing.
 *
 * `backfill` fetches past sessions, one request per calendar day, for the history the
 * archive would otherwise only begin accumulating today. See `backfill.ts`.
 *
 * ## `scrape` can be told to wait for the session instead of assuming it
 *
 * `--wait N` gives it a budget in minutes and it polls the source until the day's session
 * appears, which is what lets the punctual trigger fire at the close rather than an hour
 * after it. `--confirm N` makes it read twice before writing, and `--min-completeness`
 * refuses a session too small to be a full one. All three are off or harmless by default,
 * so an unadorned `pnpm scrape` behaves as it always has. See `lib/readiness.ts`.
 *
 * ## Running `scrape` twice in a day does nothing
 *
 * The file is compared before it is written, and an identical one is left alone. That
 * is what makes a re-run, a retried workflow, or a manual dispatch safe — and it is
 * also what makes a holiday a no-op, because the source keeps reporting the previous
 * session and that file already exists.
 *
 * ## Nothing is written on a doubt
 *
 * The parser refuses a page with no date or too few rows, and this refuses to write
 * over an existing file when the content differs *unless* the discrepancy is stated.
 * The archive is append-only in spirit: a day, once written, is a historical record,
 * and a later run that disagrees with it is a fact about the scraper rather than a
 * correction of the past.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  exitCodeFor,
  formatSummary,
  runBackfill,
  type BackfillOptions,
} from "./backfill.js";
import { archivedCsv, writeSnapshot } from "./lib/archive.js";
import { isRealDay, kathmanduToday, previousDay } from "./lib/dates.js";
import {
  MANIFEST_PATH,
  SESSIONS_PATH,
  buildManifest,
  writeManifest,
  writeSessionsIndex,
} from "./lib/manifest.js";
import { snapshotPath } from "./lib/paths.js";
import {
  MIN_COMPLETENESS,
  POLL_INTERVAL_MS,
  awaitSession,
  formatElapsed,
} from "./lib/readiness.js";
import { snapshotToCsv } from "./lib/serialize.js";
import { CLOSES_DIRECTORY, writeCloses } from "./lib/closes.js";
import { INDICES_DIRECTORY, INDICES_LATEST_PATH, writeIndices } from "./lib/indices.js";
import { SERIES_DIRECTORY, writeSeries } from "./lib/series.js";
import { SYMBOLS_PATH, mergeSymbols } from "./lib/symbols.js";
import { fetchMarketPage, parseMarketPage } from "./sources/sharesansar-index.js";
import { MIN_HISTORICAL_ROWS, fetchTodaySession } from "./sources/sharesansar.js";
import { createPriceSession } from "./sources/sharesansar-session.js";
import type { DaySnapshot } from "./types.js";

/** Resolved from this file rather than `cwd`, so it runs from anywhere. */
const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * Named `scrape` rather than `fetch` on purpose.
 *
 * `pnpm fetch` is a **pnpm built-in** that populates the package store. It shadows a
 * script of the same name, exits 0, and prints nothing alarming — so the daily workflow
 * would have succeeded every day while this repository archived nothing at all. A
 * silent no-op that looks like a pass is the worst failure available here.
 *
 * `backfill` is not a pnpm built-in, so the same trap does not recur — but it is worth
 * checking before adding the next command, because the failure is invisible.
 */
const USAGE = `Usage: nepse-data <command> [options]

  scrape                Fetch the current session and write it to data/daily/.
    --wait N            Wait up to N minutes for today's session to appear
                        (default 0). A closed day spends the whole budget polling.
    --confirm N         Read again N seconds later and write only if the bytes match,
                        so a table that is still filling in is never archived
                        (default 60; 0 trusts the first reading).
    --min-completeness R
                        Refuse a session with fewer than this fraction of the newest
                        archived session's scrips (default ${MIN_COMPLETENESS}; 0 disables).
    --dry-run           Parse and report without writing anything.

  backfill              Fetch past sessions; one request per calendar day.
    --from YYYY-MM-DD   First day (required).
    --to YYYY-MM-DD     Last day, inclusive (default: yesterday in Kathmandu).
    --min-rows N        Refuse a session with fewer scrips (default ${MIN_HISTORICAL_ROWS}).
    --dry-run           Parse and report without writing anything.

  index                 Rebuild data/series/ and data/closes/ from the archive.
                        No network: it reads data/daily/ and rewrites what changed.
    --dry-run           Report what would change without writing anything.

  indices               Read the exchange's index levels and append them to
                        data/indices/, one file per index, plus latest.json.
                        One request. A session already recorded is left alone.
    --dry-run           Parse and report without writing anything.
`;

/** A mistake in how the command was called, as opposed to a failure while running. */
class UsageError extends Error {}

function describe(snapshot: DaySnapshot): string {
  const priced = snapshot.rows.filter((row) => row.close !== null).length;
  return `${snapshot.rows.length} scrips (${priced} with a close)`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How many scrips the newest archived session holds, or `null` when there is none.
 *
 * The yardstick the completeness floor measures against. Read from disk rather than from
 * a fetch, because the thing a new session is being compared to is the archive, and
 * because it is already there, so this costs no request.
 *
 * The count is the lines minus the header. The file is written CRLF-terminated, so the
 * trailing newline would otherwise be counted as a scrip.
 */
async function archivedRowCount(root: string, latest: string | null): Promise<number | null> {
  if (latest === null) return null;

  const csv = await archivedCsv(root, latest);
  if (csv === null) return null;

  return csv.split(/\r?\n/).filter((line) => line !== "").length - 1;
}

async function scrapeCommand(
  dryRun: boolean,
  waitMinutes: number,
  confirmSeconds: number,
  minCompleteness: number,
): Promise<number> {
  // Kathmandu's today, because the session being waited for is the one the exchange is
  // trading today. This decides only what we are willing to *wait for*; what the page
  // actually reports is what gets archived. See the note in `lib/dates.ts`.
  const target = kathmanduToday();

  // Read once, before the loop. The archive cannot move underneath a run, because the
  // concurrency group serialises writers, and it serves as both the completeness yardstick
  // and the floor that catches a source going backwards.
  const newest = (await buildManifest(REPO_ROOT)).latest;

  const readiness = await awaitSession(
    {
      target,
      budgetMs: waitMinutes * 60_000,
      intervalMs: POLL_INTERVAL_MS,
      confirmMs: confirmSeconds * 1_000,
      baselineRows: await archivedRowCount(REPO_ROOT, newest),
      minCompleteness,
    },
    {
      fetchSession: fetchTodaySession,
      sleep,
      now: () => Date.now(),
      log: (line) => console.log(line),
    },
  );

  if (readiness.kind === "unsettled") {
    // The one outcome that must never be written. A table that will not hold still is not
    // yet a session, and a day, once in the archive, is a historical record.
    throw new Error(
      `The source is still republishing the ${target} session after ` +
        `${formatElapsed(readiness.waitedMs)}. Nothing was written. Re-run once it settles.`,
    );
  }

  if (readiness.kind === "ready") {
    console.log(
      `Ready   ${target} after ${formatElapsed(readiness.waitedMs)} ` +
        `(${readiness.attempts} ${readiness.attempts === 1 ? "poll" : "polls"}, ` +
        `held still for ${confirmSeconds}s)`,
    );
  } else {
    // Either the market was shut or the session has not been published yet, and from here
    // they are the same observation: an older session, already archived, so the write
    // below is a no-op and the run commits nothing.
    console.log(
      `Waited  ${formatElapsed(readiness.waitedMs)}: the source still reports ` +
        `${readiness.session.snapshot.date}, so this is either a closed day or a session ` +
        `that has not been published yet.`,
    );
  }

  const { snapshot, names } = readiness.session;

  // A source that has gone *backwards* is the one thing a date comparison can catch and a
  // byte comparison cannot: the write below would find the old file identical and report a
  // quiet no-op, which looks exactly like a closed market. It is not one: the archive
  // already holds something newer. A source serving a stale session every day forever is
  // a failure worth being woken for, not a silence worth keeping.
  if (newest !== null && snapshot.date < newest) {
    throw new Error(
      `The source is reporting ${snapshot.date}, older than the newest archived session ` +
        `(${newest}). Nothing was written: the source has gone backwards, which is not a ` +
        `closed market. Check whether it is serving a stale cache before re-running.`,
    );
  }

  const csv = snapshotToCsv(snapshot);
  const relative = snapshotPath(snapshot.date);

  console.log(`Session ${snapshot.date}: ${describe(snapshot)}`);
  console.log(`Target  ${relative} (${csv.length} bytes)`);

  if (dryRun) {
    console.log("\n--dry-run: nothing written. First three rows:");
    console.log(
      csv
        .split("\r\n")
        .slice(0, 4)
        .map((line) => `  ${line}`)
        .join("\n"),
    );
    return 0;
  }

  const outcome = await writeSnapshot(REPO_ROOT, snapshot);

  // Rebuilt rather than patched, so it cannot drift from the archive. On an unchanged
  // day this writes identical bytes and the job still finds nothing to commit — which is
  // what makes a holiday a no-op. See the note in `lib/manifest.ts` about timestamps.
  const manifest = await writeManifest(REPO_ROOT);
  const dates = await writeSessionsIndex(REPO_ROOT);
  // Merged rather than rebuilt — a name cannot be recovered from the archive, so this is
  // the one index that accumulates. See `lib/symbols.ts`.
  const directory = await mergeSymbols(REPO_ROOT, names, snapshot.date);
  console.log(
    `Index   ${MANIFEST_PATH} + ${SESSIONS_PATH} — latest ${manifest.latest ?? "none"}, ` +
      `${dates.length} session dates`,
  );
  console.log(
    `        ${SYMBOLS_PATH} — ${Object.keys(directory).length} tickers, ` +
      `${names.size} seen today`,
  );

  if (outcome === "unchanged") {
    // The ordinary case on a re-run, a retry, and every holiday: the session the source
    // is showing has already been archived.
    console.log("Unchanged — already archived. Nothing to do.");
    return 0;
  }

  if (outcome === "rewritten") {
    // A day that is already archived and now parses differently. Worth saying out loud:
    // it means either the source revised its figures or this scraper changed its mind,
    // and both are worth seeing in a log rather than only in a diff.
    console.warn(
      `Replacing a file that already exists for ${snapshot.date}. ` +
        "A previous run recorded different figures for this session.",
    );
  }

  console.log(`${outcome === "written" ? "Wrote" : "Rewrote"} ${relative}`);
  return 0;
}

type FlagKind = "value" | "boolean";

/**
 * Reads `--name value`, `--name=value` and bare `--name` against a spec.
 *
 * Stricter than the `argv.includes` this replaced, deliberately: an unrecognised option
 * is an error rather than something ignored. A typo in a workflow's `run:` block would
 * otherwise sweep a two-hour range with default arguments and not mention it.
 */
function parseFlags(
  argv: readonly string[],
  spec: Readonly<Record<string, FlagKind>>,
): { values: Record<string, string>; flags: Set<string> } {
  const values: Record<string, string> = {};
  const flags = new Set<string>();

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === undefined) continue;

    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument : argument.slice(0, equals);
    const inline = equals === -1 ? undefined : argument.slice(equals + 1);

    const kind = spec[name];
    if (kind === undefined) throw new UsageError(`Unknown option "${name}".`);

    if (kind === "boolean") {
      if (inline !== undefined) throw new UsageError(`"${name}" does not take a value.`);
      flags.add(name);
      continue;
    }

    const value = inline ?? argv[++index];
    if (value === undefined) throw new UsageError(`"${name}" needs a value.`);
    values[name] = value;
  }

  return { values, flags };
}

const BACKFILL_FLAGS: Record<string, FlagKind> = {
  "--from": "value",
  "--to": "value",
  "--min-rows": "value",
  "--dry-run": "boolean",
};

const SCRAPE_FLAGS: Record<string, FlagKind> = {
  "--wait": "value",
  "--confirm": "value",
  "--min-completeness": "value",
  "--dry-run": "boolean",
};

const INDEX_FLAGS: Record<string, FlagKind> = {
  "--dry-run": "boolean",
};

const INDICES_FLAGS: Record<string, FlagKind> = {
  "--dry-run": "boolean",
};

/**
 * A fraction between 0 and 1.
 *
 * `0` is allowed and means "no floor", matching `--min-rows 1`: it is the documented way
 * to overrule a refusal for a day that genuinely traded thin. Above 1 is refused rather
 * than treated as a percentage, because `--min-completeness 80` silently meaning "8000%"
 * would refuse every session there will ever be.
 */
function parseCompleteness(raw: string): number {
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new UsageError(`--min-completeness "${raw}" is not a number between 0 and 1.`);
  }

  const value = Number(raw);
  if (value > 1) {
    throw new UsageError(`--min-completeness must be between 0 and 1, not ${value}.`);
  }

  return value;
}

/**
 * A whole number of units, bounded.
 *
 * Bounded because both of these are waits, and a wait has no natural ceiling: a typo in
 * `--wait` would hold a runner until the job's own timeout killed it, which reports as a
 * cancelled run rather than as the mistake it is. The ceilings are well clear of any
 * sensible value: 45 minutes is the longest wait the workflow asks for, and a confirm
 * longer than a few minutes means the gate is misconfigured rather than patient.
 */
function parseCount(name: string, raw: string, max: number, unit: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new UsageError(`${name} "${raw}" is not a whole number of ${unit}.`);
  }

  const value = Number(raw);
  if (value > max) throw new UsageError(`${name} must be at most ${max} ${unit}.`);

  return value;
}

function parseMinRows(raw: string): number {
  // `--min-rows 1` is allowed on purpose: it is the documented way to archive a day that
  // was refused for being small, which is the one case where an operator needs to
  // overrule the floor. Zero is not, because it would accept an empty table — the exact
  // thing the floor and the emptiness rule exist to keep out.
  if (!/^\d+$/.test(raw)) throw new UsageError(`--min-rows "${raw}" is not a positive integer.`);

  const value = Number(raw);
  if (value < 1) throw new UsageError("--min-rows must be at least 1.");

  return value;
}

async function backfillCommand(argv: readonly string[]): Promise<number> {
  const { values, flags } = parseFlags(argv, BACKFILL_FLAGS);

  const from = values["--from"];
  if (from === undefined) throw new UsageError("--from is required.");
  if (!isRealDay(from)) throw new UsageError(`--from "${from}" is not a real YYYY-MM-DD date.`);

  // Kathmandu's today, not the runner's. See the note in `lib/dates.ts`.
  const today = kathmanduToday();
  const to = values["--to"] ?? previousDay(today);

  if (!isRealDay(to)) throw new UsageError(`--to "${to}" is not a real YYYY-MM-DD date.`);

  if (to >= today) {
    // A day that has not closed yet comes back partial, and the daily job would then
    // find a file whose contents disagree and rewrite it — which is precisely what the
    // append-only rule exists to prevent. Today belongs to `scrape`.
    throw new UsageError(
      `--to ${to} is not before today in Kathmandu (${today}). ` +
        "A session that has not closed yet is still changing, so today is `scrape`'s job.",
    );
  }

  const minRows = parseMinRows(values["--min-rows"] ?? String(MIN_HISTORICAL_ROWS));
  const options: BackfillOptions = { from, to, minRows, dryRun: flags.has("--dry-run") };

  console.log(
    `Backfill ${from} → ${to}  (floor ${minRows} scrips, ` +
      `${options.dryRun ? "dry run" : "writing to data/daily/"})`,
  );
  console.log("");

  const session = createPriceSession();

  const summary = await runBackfill(options, {
    fetchDated: (date) => session.fetchDated(date),
    readArchived: (date) => archivedCsv(REPO_ROOT, date),
    write: async (snapshot) => {
      await writeSnapshot(REPO_ROOT, snapshot);
    },
    sleep,
    log: (line) => console.log(line),
  });

  console.log("");
  console.log(formatSummary(summary, options));

  if (!options.dryRun) {
    const manifest = await writeManifest(REPO_ROOT);
    const dates = await writeSessionsIndex(REPO_ROOT);
    console.log("");
    console.log(
      `Index   ${MANIFEST_PATH} + ${SESSIONS_PATH} — ${manifest.sessions} sessions, ` +
        `${dates.length} dates, latest ${manifest.latest ?? "none"}`,
    );
  }

  console.log("");
  console.log(
    `Requests issued: ${session.stats.requests} across ${session.stats.opens} session open(s).`,
  );

  return exitCodeFor(summary);
}

/**
 * Rebuilds the derived indexes, `data/series/` and `data/closes/`, from the archive.
 *
 * No network, no source, no options to get wrong. It lives in the daily job rather than in a
 * workflow of its own so that the indexes are never behind the archive: the run that writes
 * a session also writes the files that contain it. That also means a day the market did not
 * trade rewrites nothing, because every file's bytes are compared before it is written.
 *
 * One command rather than two, so a workflow cannot run half of it and commit an archive
 * whose two indexes disagree about which sessions exist.
 */
async function indexCommand(dryRun: boolean): Promise<number> {
  const started = Date.now();

  const series = await writeSeries(REPO_ROOT, { dryRun });
  console.log(
    `Series  ${SERIES_DIRECTORY} — ${series.symbols} tickers, ${series.rows} rows, ` +
      `${series.written} ${dryRun ? "to write" : "written"}, ${series.unchanged} already current`,
  );

  if (series.escaped.length > 0) {
    // Said out loud because these are the tickers whose file name is not their ticker, and
    // the list is short enough to check by eye.
    const shown = series.escaped.slice(0, 8).join(", ");
    const rest = series.escaped.length > 8 ? `, and ${series.escaped.length - 8} more` : "";
    console.log(`        ${series.escaped.length} escaped names: ${shown}${rest}`);
  }

  const closes = await writeCloses(REPO_ROOT, { dryRun });
  console.log(
    `Closes  ${CLOSES_DIRECTORY} — ${closes.dates} sessions across ` +
      `${closes.written + closes.unchanged} ${closes.written + closes.unchanged === 1 ? "year" : "years"}, ` +
      `${closes.written} ${dryRun ? "to write" : "written"}, ${closes.unchanged} already current`,
  );

  console.log(`        in ${formatElapsed(Date.now() - started)}`);
  return 0;
}

/**
 * Records the exchange's index levels for the newest session.
 *
 * ## Why this is its own command rather than part of `index`
 *
 * It is the one index step that touches the network. `index` derives the per-symbol and
 * per-year files from `data/daily/` and says so in its own note; folding a fetch into it
 * would make that false and would make every rebuild depend on ShareSansar being up.
 * Keeping them apart also keeps the failure legible: `index` failing means the archive is
 * damaged, while this failing usually means the source is unreachable or its markup moved.
 *
 * ## One request, and it appends
 *
 * The daily job already talks to this host for the session, so this adds a request rather
 * than a dependency. Appending is what makes it safe to run at any time: the page keeps
 * serving the session that is already recorded until a new one closes, so a re-run, a
 * retried workflow and a holiday all write nothing at all.
 */
async function indicesCommand(dryRun: boolean): Promise<number> {
  const page = parseMarketPage(await fetchMarketPage());
  const outcome = await writeIndices(REPO_ROOT, page, { dryRun });

  console.log(
    `Indices ${INDICES_DIRECTORY} — ${outcome.date}, ${outcome.indices} indices, ` +
      `${outcome.written} ${dryRun ? "to write" : "written"}, ${outcome.unchanged} already current`,
  );

  if (outcome.appended.length === 0) {
    // Said out loud because the two cases look identical in the counts above: a holiday
    // and a run that has already recorded the session both append nothing, and neither is
    // a failure.
    console.log(`        The page is still showing ${outcome.date}, which is already recorded.`);
  }

  console.log(
    `        ${INDICES_LATEST_PATH} ` +
      (outcome.latestChanged ? (dryRun ? "would change" : "updated") : "already current"),
  );

  return 0;
}

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0];

  if (command === undefined || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command === undefined ? 2 : 0;
  }

  switch (command) {
    case "scrape": {
      const { values, flags } = parseFlags(argv.slice(1), SCRAPE_FLAGS);

      // The defaults live here rather than in the workflow, so that a manual `pnpm scrape`
      // and a dispatched run behave the same way and the workflow only has to say how long
      // it is prepared to wait.
      const wait = parseCount("--wait", values["--wait"] ?? "0", 120, "minutes");
      const confirm = parseCount("--confirm", values["--confirm"] ?? "60", 600, "seconds");
      const completeness = parseCompleteness(
        values["--min-completeness"] ?? String(MIN_COMPLETENESS),
      );

      return scrapeCommand(flags.has("--dry-run"), wait, confirm, completeness);
    }
    case "backfill":
      return backfillCommand(argv.slice(1));
    case "index":
      return indexCommand(parseFlags(argv.slice(1), INDEX_FLAGS).flags.has("--dry-run"));
    case "indices":
      return indicesCommand(parseFlags(argv.slice(1), INDICES_FLAGS).flags.has("--dry-run"));
    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  // A usage mistake is not a crash, and printing a stack for it would bury the message.
  if (error instanceof UsageError) {
    console.error(`error: ${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
  } else {
    // Printed as one line with no stack: in a workflow log the message is the useful
    // part, and a stack trace from a parse failure buries it.
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
