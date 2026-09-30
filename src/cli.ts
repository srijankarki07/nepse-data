/**
 * The one command this repository runs.
 *
 * Fetches the current session and writes it to `data/daily/<year>/<date>.csv`. The
 * GitHub Action calls this daily and commits the result; running it by hand does the
 * same thing.
 *
 * ## Running it twice in a day does nothing
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

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { snapshotPath } from "./lib/paths.js";
import { snapshotToCsv } from "./lib/serialize.js";
import { fetchTodaySharePrice } from "./sources/sharesansar.js";
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
 */
const USAGE = `Usage: nepse-data scrape [--dry-run]

  scrape      Fetch the current session and write it to data/daily/.
  --dry-run   Parse and report without writing anything.
`;

function describe(snapshot: DaySnapshot): string {
  const priced = snapshot.rows.filter((row) => row.close !== null).length;
  return `${snapshot.rows.length} scrips (${priced} with a close)`;
}

async function scrapeCommand(dryRun: boolean): Promise<number> {
  const snapshot = await fetchTodaySharePrice();
  const csv = snapshotToCsv(snapshot);
  const relative = snapshotPath(snapshot.date);
  const target = path.join(REPO_ROOT, relative);

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

  const existing = await readFile(target, "utf8").catch(() => null);

  if (existing === csv) {
    // The ordinary case on a re-run, a retry, and every holiday: the session the source
    // is showing has already been archived.
    console.log("Unchanged — already archived. Nothing to do.");
    return 0;
  }

  if (existing !== null) {
    // A day that is already archived and now parses differently. Worth saying out loud:
    // it means either the source revised its figures or this scraper changed its mind,
    // and both are worth seeing in a log rather than only in a diff.
    console.warn(
      `Replacing a file that already exists for ${snapshot.date}. ` +
        "A previous run recorded different figures for this session.",
    );
  }

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, csv, "utf8");
  console.log(`${existing === null ? "Wrote" : "Rewrote"} ${relative}`);

  return 0;
}

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0];

  if (command === undefined || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command === undefined ? 2 : 0;
  }

  if (command !== "scrape") {
    console.error(`Unknown command "${command}".\n\n${USAGE}`);
    return 2;
  }

  return scrapeCommand(argv.includes("--dry-run"));
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  // Printed as one line with no stack: in a workflow log the message is the useful
  // part, and a stack trace from a parse failure buries it.
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
