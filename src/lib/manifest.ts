/**
 * The index a consumer reads before anything else.
 *
 * ## Why an index exists at all
 *
 * The archive is a directory tree of daily files, and a directory tree is not enumerable
 * over the transports this data is actually read through. `raw.githubusercontent.com` and
 * jsDelivr serve *files* — neither will list a directory. So a client that wants "the
 * latest prices" has no way to discover which date to ask for, and one that wants a
 * historical range has no way to know which dates exist.
 *
 * This file answers both, in about three hundred bytes. It is the difference between a
 * dataset and a directory of files.
 *
 * ## It carries no timestamp, deliberately
 *
 * The obvious field to add is "generated at". It would also break the daily job. Every
 * run rewrites this file, so a timestamp would make it differ on every run — including
 * the runs where nothing happened, which is every holiday and every re-dispatch. The job
 * compares before committing and would find a change every single day, commit it, and
 * thereby lose the property that a non-trading day is a no-op. That is the same class of
 * failure as `pnpm fetch` shadowing the scrape command: something that looks like it is
 * working while quietly doing the wrong thing. Freshness is a property of the latest
 * session's date, which is already here, and which only moves when the market does.
 *
 * ## It is derived, never maintained
 *
 * The manifest is rebuilt from the filenames on disk rather than updated as sessions are
 * written. A file that must be kept in step with the archive is a file that can drift out
 * of step with it, and the failure would be a consumer reading a date that does not
 * exist — or missing one that does. Deriving it costs one directory walk and cannot be
 * wrong. Only names are read, never contents, so it stays cheap as the archive grows.
 */

import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { isRealDay } from "./dates.js";

/** Where a consumer looks first. Alongside `daily/`, not inside it. */
export const MANIFEST_FILE = "latest.json";
export const MANIFEST_PATH = `data/${MANIFEST_FILE}`;

export interface ArchiveManifest {
  /** The most recent session archived, or `null` when the archive is empty. */
  latest: string | null;
  /**
   * The session before `latest`, for a day change.
   *
   * `null` only when the archive holds a single session. It is *not* "yesterday": the
   * market is closed two days in seven and for holidays, so the previous session is
   * found by looking, not by subtracting a day.
   */
  previous: string | null;
  /** How many sessions the archive holds. */
  sessions: number;
  /** Sessions per year, keyed by year. Sorted, so the file's diff is stable. */
  years: Record<string, number>;
}

/** Every archived session date, sorted ascending. Named by its filename. */
export async function archivedDates(root: string): Promise<string[]> {
  const daily = path.join(root, "data", "daily");

  let years: string[];
  try {
    years = await readdir(daily);
  } catch {
    return [];
  }

  const dates: string[] = [];

  for (const year of years) {
    let names: string[];
    try {
      names = await readdir(path.join(daily, year));
    } catch {
      continue;
    }

    for (const name of names) {
      if (!name.endsWith(".csv")) continue;

      const date = name.slice(0, -4);
      // A name that is not a date is not part of the archive. Checked rather than assumed,
      // because a stray file would otherwise become the manifest's `latest` and send every
      // consumer to a URL that 404s.
      if (isRealDay(date)) dates.push(date);
    }
  }

  return dates.sort();
}

/** Builds the manifest from what is on disk. */
export async function buildManifest(root: string): Promise<ArchiveManifest> {
  const dates = await archivedDates(root);

  const years: Record<string, number> = {};
  for (const date of dates) {
    const year = date.slice(0, 4);
    years[year] = (years[year] ?? 0) + 1;
  }

  return {
    latest: dates.at(-1) ?? null,
    previous: dates.at(-2) ?? null,
    sessions: dates.length,
    years,
  };
}

/**
 * Rebuilds the manifest and writes it, returning what was written.
 *
 * Written with a trailing newline so the file is a well-formed text file and its diff is
 * a line diff. The key order is fixed by construction, so an unchanged archive produces
 * byte-identical output and the caller's "did anything change" check keeps working.
 */
export async function writeManifest(root: string): Promise<ArchiveManifest> {
  const manifest = await buildManifest(root);

  await writeFile(
    path.join(root, MANIFEST_PATH),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  return manifest;
}
