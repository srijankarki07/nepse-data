/**
 * Turning a snapshot into the bytes that get committed.
 *
 * Kept apart from the scraper so the archive's format can be tested against a
 * hand-written snapshot — the parser's tests should not also be the writer's.
 */

import { createHash } from "node:crypto";

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

/**
 * A digest of a session's *content*, with the date column removed.
 *
 * Two different sessions cannot legitimately have the same prices, so an identical
 * fingerprint means one session's figures have been filed under two dates. That is what
 * an endpoint serving one session under many date headings looks like, and it is
 * invisible in any single response — which is the whole reason this exists.
 *
 * The date column is dropped because it is precisely the field two files of the same
 * session would differ by. Dropping it is also what makes the fingerprint comparable
 * between a snapshot parsed from a response and a file read back off disk: both are
 * produced by `snapshotToCsv`, so the same session fingerprints identically either way.
 * That matters more than it first appears — a guard that could only compare against days
 * fetched *in the same run* silently stops working the moment a sweep is resumed, which
 * is the normal case, and it let a duplicate through exactly once before this.
 *
 * The date is the first field and is never quoted, so the first comma ends it.
 */
export function sessionFingerprint(csv: string): string {
  const body = csv
    .split("\r\n")
    .slice(1) // the header row
    .filter((line) => line !== "")
    .map((line) => line.slice(line.indexOf(",") + 1))
    .join("\n");

  return createHash("sha256").update(body).digest("hex");
}
