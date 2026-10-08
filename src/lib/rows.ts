/**
 * Reading back what has been archived.
 *
 * ## Why a reader exists at all
 *
 * `csv.ts` only writes. Nothing else in this repository needs to read a session's contents
 * back: the manifest and the session list are built from filenames, the backfill compares
 * bytes, and the scraper never looks at the past. The derived indexes under `data/series/`
 * and `data/closes/` are the first thing that has to understand a session file as data, so
 * this is where that begins.
 *
 * It is one module rather than one per index because the two must agree about what a valid
 * row is. A second copy of "eight columns, a real date, the date the filename claims" would
 * be a second opinion, and the two would drift the first time either changed.
 *
 * ## A bad row is a failure, not something to skip
 *
 * The files under `data/daily/` were written by this repository, so a malformed one means
 * the archive is damaged. Skipping it would produce an index that is quietly missing a
 * session, which is the kind of error nothing downstream can detect — every consumer would
 * simply see a market that did not trade. So the walk stops and says which file and line.
 */

import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import { COLUMNS } from "./serialize.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_PATTERN = /^\d{4}$/;
const FIELD_COUNT = COLUMNS.length;

/** One row of one session file, with the session it belongs to. */
export interface ArchivedRow {
  /** The date the row carries, which has been checked against the filename. */
  date: string;
  /** The ticker as the archive spells it, trimmed and not otherwise altered. */
  symbol: string;
  /** The eight fields, unparsed, in `COLUMNS` order. */
  fields: string[];
  /** The row exactly as the archive wrote it, without its line terminator. */
  line: string;
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
 * Walks every archived row, oldest session first, handing each to `visit`.
 *
 * The visitor may be async. A caller that can finish a unit of work and release it when the
 * date changes (the per-year closes file is exactly that) should not have to hold the whole
 * archive in memory to do it.
 */
export async function forEachArchivedRow(
  root: string,
  visit: (row: ArchivedRow) => void | Promise<void>,
): Promise<void> {
  for (const file of await sessionFiles(root)) {
    const relative = path.relative(root, file);
    const expectedDate = path.basename(file, ".csv");
    const lines = (await readFile(file, "utf8")).split(/\r?\n/);

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

      await visit({ date, symbol, fields, line });
    }
  }
}
