/**
 * The per-symbol view of the archive.
 *
 * ## Why this exists at all
 *
 * The archive is shaped for "one session, every scrip": a consumer that wants the opposite
 * — one scrip, every session — has to fetch one file per trading day and throw away almost
 * all of it. Measured against the published archive, a year of one scrip cost **231
 * requests and 4.13 MB** to return 230 rows, about 10 KB of which were wanted.
 *
 * These files invert that. `data/series/NABIL.csv` holds one scrip's whole history in the
 * same eight columns, so the same query is **one request** of about 11 KB for a year, and
 * 157 KB for all fifteen.
 *
 * ## Why this does not contradict `paths.ts`
 *
 * `paths.ts` argues for daily files and against per-symbol ones, on the grounds that every
 * commit rewrites every file. That concern is real and was measured rather than assumed
 * over thirty simulated daily commits:
 *
 * | layout                  | .git per commit | files per commit |
 * | ----------------------- | --------------- | ---------------- |
 * | a daily file (as today) |          8.2 KB |                1 |
 * | one file per symbol     |         37.5 KB |             ~360 |
 *
 * So it is **4.5x** the history cost, not the several-hundred-megabytes the note feared:
 * about 9.4 MB a year. What does survive is that a daily commit now touches several hundred
 * files, so its diff is no longer reviewable line by line. That is the price, and it is
 * paid deliberately: it buys a year of one scrip in one request for every consumer of the
 * package, with no change on their side.
 *
 * Daily files stay the record. These are an **index over** them, rebuilt rather than
 * appended to, so they cannot drift from the archive — the same reasoning as the manifest.
 *
 * ## The file name is not the ticker
 *
 * Fourteen tickers in this archive contain a slash, because the source names a debenture
 * for the two years it covers: `GBILD86/87`, `NMBUR93/94`. A slash is a directory
 * separator, so `data/series/GBILD86/87.csv` would be a directory named `GBILD86` holding
 * a file `87.csv`, which is not a file any client can fetch. There are older artefacts
 * too: `NICAD 85/8` contains a space and `NIFRAUR85/` ends in a slash.
 *
 * So the name is the ticker with **every run of characters outside `A-Z0-9` replaced by a
 * single `-`**. Any ticker can then be named, and no ticker can escape its directory. The
 * client applies the identical rule, so the two agree by construction rather than by
 * convention; a test in the client asserts they do.
 *
 * That mapping is not injective in principle, so it is checked rather than trusted: two
 * tickers sharing one file would silently merge two companies' price histories into one,
 * which is the kind of error nothing downstream could detect.
 */

import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import { toCsv } from "./csv.js";
import { COLUMNS } from "./serialize.js";

/** Where the per-symbol files live. Alongside `daily/`, like the other indexes. */
export const SERIES_DIRECTORY = "data/series";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FIELD_COUNT = COLUMNS.length;
const DAY_PATTERN = /^\d{4}$/;

/** The header every series file starts with, identical to a session file's. */
const HEADER = toCsv(COLUMNS, []);

/**
 * A ticker as a file name: everything outside `A-Z`, `a-z`, `0-9` becomes one `-`.
 *
 * The result is upper-cased, because a ticker is upper-cased everywhere else here, and
 * because two spellings of one ticker must not become two files. Lower case is accepted
 * rather than refused: this function names files from rows that came off a scraped page,
 * and turning a lower-case ticker into an empty name would be a worse answer than a
 * correct one.
 *
 * Exported because the client has to build the same path from the same ticker, and the two
 * copies of this rule are the one thing that could silently disagree.
 */
export function seriesName(symbol: string): string {
  const name = symbol
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toUpperCase();

  if (name === "") {
    throw new Error(`"${symbol}" has no characters a file name can be made from`);
  }

  return name;
}

/** `data/series/NABIL.csv`, relative to the repository root. */
export function seriesPath(symbol: string): string {
  return path.join(SERIES_DIRECTORY, `${seriesName(symbol)}.csv`);
}

/** Every archived session file, oldest first, so rows arrive in date order. */
async function sessionFiles(root: string): Promise<string[]> {
  const daily = path.join(root, "data", "daily");

  let entries: Dirent[];
  try {
    entries = await readdir(daily, { withFileTypes: true });
  } catch {
    // No archive yet. Not an error: there is simply nothing to index.
    return [];
  }

  const files: string[] = [];
  // Filtered by directory rather than by name alone, because anything sitting under
  // `data/daily/` that is not a year of sessions is not this function's business.
  for (const year of entries
    .filter((entry) => entry.isDirectory() && DAY_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort()) {
    const inYear = await readdir(path.join(daily, year));
    for (const file of inYear.filter((entry) => entry.endsWith(".csv")).sort()) {
      files.push(path.join(daily, year, file));
    }
  }

  return files;
}

/**
 * Every row of every session, grouped by ticker and ordered by date.
 *
 * Rows are kept as the archive wrote them rather than re-serialized. They have just been
 * checked to hold exactly eight fields, which is what guarantees re-emitting them under the
 * same header reproduces them faithfully — a re-serialization would be a second writer to
 * keep in step with the first for no gain.
 *
 * A row that does not fit the format is a **failure**, not something to skip: the files
 * under `data/daily/` were written by this repository, so a malformed one means the archive
 * is damaged, and an index that quietly dropped the row would hide it.
 */
async function rowsBySymbol(root: string): Promise<Map<string, string[]>> {
  const byName = new Map<string, string[]>();
  const symbolOf = new Map<string, string>();

  for (const file of await sessionFiles(root)) {
    const text = await readFile(file, "utf8");
    const relative = path.relative(root, file);
    const expectedDate = path.basename(file, ".csv");
    const lines = text.split(/\r?\n/);

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (line === undefined || line === "") continue;
      if (index === 0 && line.startsWith("date,")) continue;

      const fields = line.split(",");
      if (fields.length !== FIELD_COUNT) {
        throw new Error(
          `${relative}:${index + 1} has ${fields.length} columns, expected ${FIELD_COUNT}. ` +
            "The archive is damaged, so no index was written.",
        );
      }

      const date = fields[0] ?? "";
      if (!DATE_PATTERN.test(date) || date !== expectedDate) {
        throw new Error(
          `${relative}:${index + 1} is dated "${date}", but the file is named for ` +
            `${expectedDate}. The archive is damaged, so no index was written.`,
        );
      }

      const symbol = (fields[1] ?? "").trim();
      if (symbol === "") continue;

      const name = seriesName(symbol);
      const already = symbolOf.get(name);
      if (already !== undefined && already !== symbol) {
        throw new Error(
          `"${symbol}" and "${already}" both want the file ${name}.csv. Two tickers in one ` +
            "file would merge their histories, so nothing was written.",
        );
      }
      symbolOf.set(name, symbol);

      const rows = byName.get(name);
      if (rows === undefined) byName.set(name, [line]);
      else rows.push(line);
    }
  }

  return byName;
}

export interface SeriesOutcome {
  /** How many tickers the archive has seen. */
  symbols: number;
  /** How many session rows went into them. */
  rows: number;
  /** Files whose bytes changed, which is what the daily commit will carry. */
  written: number;
  /** Files already holding exactly these bytes, which are left alone. */
  unchanged: number;
  /** Tickers whose name needed escaping, for the log to be honest about the odd ones. */
  escaped: string[];
}

/**
 * Rebuilds every series file from the archive, writing only what changed.
 *
 * Rebuilt rather than appended to, so it cannot drift: the same run after a backfill, a
 * hand-edited file, or a partial failure converges on the archive's contents. The cost is
 * reading the archive (about 65 MB, a few seconds) and the benefit is that this file is
 * never a second source of truth.
 *
 * Unchanged files are not written at all, which is what keeps the daily commit to the few
 * hundred symbols that actually traded rather than all of them — and what makes a re-run,
 * a retried workflow and a holiday all no-ops, exactly as for a session file.
 */
export async function writeSeries(
  root: string,
  options: { dryRun?: boolean } = {},
): Promise<SeriesOutcome> {
  const byName = await rowsBySymbol(root);

  let written = 0;
  let unchanged = 0;
  let rows = 0;
  const escaped: string[] = [];

  for (const [name, lines] of byName) {
    const csv = `${HEADER}${lines.join("\r\n")}\r\n`;
    rows += lines.length;
    if (name !== lines[0]?.split(",")[1]) escaped.push(name);

    const target = path.join(root, SERIES_DIRECTORY, `${name}.csv`);

    const existing = await readFile(target, "utf8").catch(() => null);
    if (existing === csv) {
      unchanged++;
      continue;
    }

    written++;

    // The count above is what a dry run reports, so the two cannot disagree about what a
    // real run would do.
    if (options.dryRun === true) continue;

    await mkdir(path.dirname(target), { recursive: true });

    const temp = `${target}.tmp`;
    try {
      await writeFile(temp, csv, "utf8");
      await rename(temp, target);
    } catch (error) {
      // Leave nothing behind: a stray .tmp would be swept up by the workflow's
      // `git add data` and committed as though it were part of the archive.
      await unlink(temp).catch(() => {});
      throw error;
    }
  }

  return { symbols: byName.size, rows, written, unchanged, escaped: escaped.sort() };
}