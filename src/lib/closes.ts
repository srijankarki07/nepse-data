/**
 * The per-year view of the whole market: `data/closes/<YEAR>.csv`.
 *
 * ## Why a second index, when `data/series/` exists
 *
 * They answer opposite questions. `data/series/` is one ticker across every session, which
 * is what a scrip's page needs. This is every ticker across one year, which is what an
 * index needs: the equal-weighted market index is the mean of each scrip's day-on-day price
 * ratio, so computing it means holding *every* scrip's close for each of ~230 dates. Per
 * symbol files cannot serve that — it would take one request per listed scrip, about 360 of
 * them, which is worse than the session files it replaces.
 *
 * Measured against the published archive, one year of the index cost **231 requests and
 * 4.13 MB**. It costs **one request and 454 KB** from here.
 *
 * ## Shape: one row per date, one column per ticker
 *
 * ```csv
 * date,ACLBSL,ADBL,...
 * 2026-09-30,870,307.5,...
 * 2026-10-01,878,309.9,...
 * ```
 *
 * The columns are the tickers listed at any point in that year, sorted; a scrip that did not
 * trade on a date has an empty field, which is the same "not published" the session files
 * use and is why empties are never zero.
 *
 * Wide rather than one row per date and ticker, because the whole point is to be small: the
 * long form is about 2.5x the bytes for the same facts, and the client wants, for each date,
 * exactly a ticker-to-close lookup, which is what a row already is.
 *
 * ## Only closes
 *
 * A consumer that wants a scrip's open, high, low, volume or turnover wants `data/series/`,
 * or the session file itself. This carries the one number the index arithmetic needs, which
 * is what keeps it under half a megabyte a year.
 *
 * Like `data/series/`, this is derived: rebuilt from `data/daily/` on every run, written
 * only where the bytes changed, and byte-stable so a holiday commits nothing.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { forEachArchivedRow } from "./rows.js";

/** Where the per-year files live. Alongside `daily/`, like the other indexes. */
export const CLOSES_DIRECTORY = "data/closes";

/** `data/closes/2026.csv`, relative to the repository root. */
export function closesPath(year: string): string {
  return path.join(CLOSES_DIRECTORY, `${year}.csv`);
}

/** `YYYY-MM-DD` to ticker to close, for one year, in the order the archive was read. */
type YearCloses = Map<string, Map<string, string>>;

/** One year's file, rendered from its dates. */
function renderYear(closes: YearCloses): string {
  const symbols = new Set<string>();
  for (const bySymbol of closes.values()) {
    for (const symbol of bySymbol.keys()) symbols.add(symbol);
  }

  // Sorted so the header is stable: an unsorted one would reshuffle the whole file the
  // first time a scrip was listed, and the diff would be useless for review.
  const columns = [...symbols].sort();
  const lines = [`date,${columns.join(",")}`];

  // Dates ascending. They were read that way, and `YYYY-MM-DD` sorts chronologically, so
  // the sort is a guarantee rather than a correction.
  for (const date of [...closes.keys()].sort()) {
    const bySymbol = closes.get(date);
    if (bySymbol === undefined) continue;
    lines.push(`${date},${columns.map((symbol) => bySymbol.get(symbol) ?? "").join(",")}`);
  }

  return `${lines.join("\r\n")}\r\n`;
}

export interface ClosesOutcome {
  /** Files written, which is what the daily commit will carry. Usually one. */
  written: number;
  /** Files already holding exactly these bytes. */
  unchanged: number;
  /** Sessions across every year. */
  dates: number;
}

/**
 * Rebuilds every year's closes file, writing only what changed.
 *
 * The archive is read once, in date order, and each year is rendered and released as soon as
 * the next one starts. That keeps memory to a single year rather than all sixteen, which
 * matters because this runs on every scrape.
 */
export async function writeCloses(
  root: string,
  options: { dryRun?: boolean } = {},
): Promise<ClosesOutcome> {
  let written = 0;
  let unchanged = 0;
  let dates = 0;

  let currentYear: string | null = null;
  let closes: YearCloses = new Map();

  const flush = async (year: string): Promise<void> => {
    if (closes.size === 0) return;

    const csv = renderYear(closes);
    const target = path.join(root, closesPath(year));

    const existing = await readFile(target, "utf8").catch(() => null);
    if (existing === csv) {
      unchanged++;
      return;
    }

    written++;

    // The count above is what a dry run reports, so the two cannot disagree about what a
    // real run would do.
    if (options.dryRun === true) return;

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
  };

  await forEachArchivedRow(root, async (row) => {
    const year = row.date.slice(0, 4);

    if (currentYear !== null && year !== currentYear) {
      await flush(currentYear);
      closes = new Map();
    }

    currentYear = year;
    let bySymbol = closes.get(row.date);
    if (bySymbol === undefined) {
      bySymbol = new Map();
      closes.set(row.date, bySymbol);
      dates++;
    }

    // `date,symbol,open,high,low,close,volume,turnover`: the close is the sixth field. A
    // missing one is left out rather than written as an empty cell, so that "this scrip did
    // not trade" and "this scrip traded but published no close" are the same absence here,
    // which is correct for a number nothing can be computed from either way.
    const close = (row.fields[5] ?? "").trim();
    if (close !== "") bySymbol.set(row.symbol, close);
  });

  if (currentYear !== null) await flush(currentYear);

  return { written, unchanged, dates };
}
