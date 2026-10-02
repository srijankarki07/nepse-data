/**
 * The commands this repository runs.
 *
 * `scrape` fetches the current session. The GitHub Action calls it daily and commits
 * the result; running it by hand does the same thing.
 *
 * `backfill` fetches past sessions, one request per calendar day, for the history the
 * archive would otherwise only begin accumulating today. See `backfill.ts`.
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
import { MANIFEST_PATH, SESSIONS_PATH, writeManifest, writeSessionsIndex } from "./lib/manifest.js";
import { snapshotPath } from "./lib/paths.js";
import { snapshotToCsv } from "./lib/serialize.js";
import { SYMBOLS_PATH, mergeSymbols } from "./lib/symbols.js";
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
    --dry-run           Parse and report without writing anything.

  backfill              Fetch past sessions; one request per calendar day.
    --from YYYY-MM-DD   First day (required).
    --to YYYY-MM-DD     Last day, inclusive (default: yesterday in Kathmandu).
    --min-rows N        Refuse a session with fewer scrips (default ${MIN_HISTORICAL_ROWS}).
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

async function scrapeCommand(dryRun: boolean): Promise<number> {
  const { snapshot, names } = await fetchTodaySession();
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

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0];

  if (command === undefined || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command === undefined ? 2 : 0;
  }

  switch (command) {
    case "scrape": {
      const { flags } = parseFlags(argv.slice(1), { "--dry-run": "boolean" });
      return scrapeCommand(flags.has("--dry-run"));
    }
    case "backfill":
      return backfillCommand(argv.slice(1));
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
