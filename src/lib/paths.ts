/**
 * Where a day's file lives.
 *
 * ## One file per trading day, nested by year
 *
 * `data/daily/2026/2026-09-30.csv` holds every scrip the source listed that session.
 *
 * **Daily files, not per-symbol files.** The obvious alternative — one file per ticker,
 * appended to each day — is how the community repositories this archive replaces ended
 * up at several hundred megabytes: every commit rewrites every file, so git stores a
 * full new blob of each, and the history grows with the *archive* rather than with the
 * data. A daily file is written once and never touched again, so the same information
 * costs a small fraction of that and the diffs stay readable.
 *
 * **Nested by year** because a single directory would reach several thousand files
 * within a decade, which is unpleasant to browse and slow in the GitHub UI. A year's
 * worth is a couple of hundred files, which is fine.
 *
 * The date is repeated inside the file as a column as well as in the name. That is
 * deliberate redundancy: every file under `data/daily/` can be concatenated into one
 * valid dataset, without the reader having to recover the date from a path — which is
 * the difference between a directory of files and a dataset.
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
