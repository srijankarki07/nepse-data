/**
 * Where a day's file lives.
 *
 * ## One file per trading day, nested by year
 *
 * `data/daily/2026/2026-09-30.csv` holds every scrip the source listed that session.
 *
 * **Daily files are the record.** They are written once and never touched again, so git
 * keeps them cheaply and a day's diff is one file. A consumer that wants one scrip across
 * every session is served by the index under `data/series/` instead — see `series.ts`,
 * which is derived from these files and explains what it costs.
 *
 * **Nested by year** because a single directory would reach several thousand files
 * within a decade, which is unpleasant to browse and slow in the GitHub UI. A year's
 * worth is a couple of hundred files, which is fine.
 *
 * The date is repeated inside the file as a column as well as in the name. That is
 * deliberate redundancy: every file under `data/daily/` can be concatenated into one
 * valid dataset, without the reader having to recover the date from a path — which is
 * the difference between a directory of files and a dataset.
 *
 * ## This used to argue against per-symbol files, and was overruled by a measurement
 *
 * The note here read that per-symbol files are how the repositories this one replaces
 * reached several hundred megabytes, because every commit rewrites every file. Rebuilding
 * both layouts side by side over thirty simulated sessions puts a number on that:
 *
 * | layout                  | .git per commit | files per commit |
 * | ----------------------- | --------------- | ---------------- |
 * | a daily file (as above) |          8.2 KB |                1 |
 * | one file per symbol     |         37.5 KB |             ~360 |
 *
 * So it is 4.5x, about **9.4 MB a year**, not several hundred megabytes — worth paying to
 * turn a year of one scrip from 231 requests and 4.13 MB into one request. The real cost
 * is not the bytes but the review: a daily commit now touches several hundred files, so
 * its diff is no longer readable line by line. The reasoning is kept here rather than
 * deleted because the concern was legitimate and the answer is a number, not a shrug.
 */

import path from "node:path";

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Rejects anything that is not a plain `YYYY-MM-DD` date. */
export function assertDay(date: string): string {
  if (!DAY_PATTERN.test(date)) {
    throw new Error(`"${date}" is not a YYYY-MM-DD date`);
  }
  return date;
}

/** `data/daily/2026/2026-09-30.csv`, relative to the repository root. */
export function snapshotPath(date: string): string {
  const day = assertDay(date);
  return path.join("data", "daily", day.slice(0, 4), `${day}.csv`);
}
