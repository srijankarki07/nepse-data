/**
 * Turning a snapshot into the bytes that get committed.
 *
 * Kept apart from the scraper so the archive's format can be tested against a
 * hand-written snapshot — the parser's tests should not also be the writer's.
 */

import { type CsvValue, toCsv } from "./csv.js";
import type { DaySnapshot } from "../types.js";

/**
 * The archive's columns.
 *
 * `date` leads, and it is repeated on every row rather than being implied by the
 * filename. That redundancy is what makes the files safe to concatenate in any order:
 * a consumer never has to recover the date from a path, so the set of files reads as a
 * dataset rather than as a directory of files.
 *
 * A `null` is written as an empty field, not a zero. See `types.ts`.
 */
export const COLUMNS = [
  "date",
  "symbol",
  "open",
  "high",
  "low",
  "close",
  "volume",
  "turnover",
] as const;

/** Renders one session. Rows are sorted by symbol so the file is byte-stable. */
export function snapshotToCsv(snapshot: DaySnapshot): string {
  const rows: CsvValue[][] = snapshot.rows.map((row) => [
    snapshot.date,
    row.symbol,
    row.open,
    row.high,
    row.low,
    row.close,
    row.volume,
    row.turnover,
  ]);

  return toCsv(COLUMNS, rows);
}
