/**
 * The historical sweep: one request per calendar day, oldest to newest.
 *
 * ## Why a calendar day, not a trading day
 *
 * The endpoint has no range parameter — `fromdate`/`todate` are accepted and ignored —
 * so the only way to ask for the past is one day at a time. That also means the sweep
 * walks *every* day, including the roughly five-sevenths the market is shut, because
 * knowing which days traded requires asking. A holiday costs one request and returns
 * nothing; the alternative is a weekday rule that would silently drop the occasional
 * special session NEPSE has held on a Friday or Saturday.
 *
 * ## What makes it safe to stop and start
 *
 * This runs for hours, and something will interrupt it. Three things make that a
 * non-event: a day already on disk is skipped without a request, so a re-run resumes
 * rather than repeats; a week of consecutive failures aborts instead of grinding
 * through the remaining thousands; and nothing is written until a day has parsed
 * cleanly, so an interrupted run cannot leave a half-believed session behind.
 *
 * ## The guard that needs two responses to work
 *
 * The response heading echoes the date that was asked for, so a single response cannot
 * show whether the site actually went and fetched that day or quietly re-served the
 * present with the requested date written on it. Comparing the *table* across days can:
 * two different dates returning byte-identical prices is not something that happens
 * legitimately, and it is the signature of exactly that failure. The digest is of the
 * table rather than of the whole response, because the heading differs by construction
 * and would make every day unique — detecting nothing.
 */

import { createHash } from "node:crypto";

import { eachDay } from "./lib/dates.js";
import { extractTableById } from "./lib/html.js";
import {
  ImplausibleSessionError,
  TABLE_ID,
  parseBackfillDay,
} from "./sources/sharesansar.js";
import type { DaySnapshot } from "./types.js";

/**
 * The pause before each request, so a sweep is a courtesy rather than a flood.
 *
 * Slightly over a second: a full sweep is several thousand requests, and the difference
 * between this and no delay at all is the difference between a scrape the site would
 * barely notice and one that looks like an attack.
 */
export const REQUEST_DELAY_MS = 1_100;

/**
 * How many days in a row may fail before the sweep gives up.
 *
 * One bad day is a bad day — a transient 503, a single malformed response — and the
 * sweep should step over it. Five in a row is not five bad days; it is the site being
 * down, the network being gone, or authentication having broken in a way that will fail
 * every remaining day identically. Grinding through thousands of requests to prove that
 * helps nobody.
 */
export const MAX_CONSECUTIVE_FAILURES = 5;

export interface BackfillOptions {
  from: string;
  to: string;
  /** Below this many scrips a day is refused rather than archived. */
  minRows: number;
  dryRun: boolean;
}

/** Injected so the sweep can be tested without a network, a clock or a disk. */
export interface BackfillDeps {
  fetchDated: (date: string) => Promise<string>;
  isArchived: (date: string) => Promise<boolean>;
  write: (snapshot: DaySnapshot) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

export interface YearStats {
  archived: number;
  rows: number;
  noSession: number;
  skipped: number;
  refused: number;
  failed: number;
  minRows: number | null;
  medianRows: number | null;
  maxRows: number | null;
}

export interface BackfillSummary {
  archived: Array<{ date: string; rows: number }>;
  noSession: string[];
  skipped: string[];
  refused: Array<{ date: string; rows: number; message: string }>;
  failed: Array<{ date: string; message: string }>;
  years: Map<string, YearStats>;
}

/** Mutable during the run; the summary is built from it at the end. */
interface Accumulator {
  archived: Array<{ date: string; rows: number }>;
  noSession: string[];
  skipped: string[];
  refused: Array<{ date: string; rows: number; message: string }>;
  failed: Array<{ date: string; message: string }>;
  countsByYear: Map<string, number[]>;
}

function emptyAccumulator(): Accumulator {
  return {
    archived: [],
    noSession: [],
    skipped: [],
    refused: [],
    failed: [],
    countsByYear: new Map(),
  };
}

function yearOf(date: string): string {
  return date.slice(0, 4);
}

function tally(accumulator: Accumulator, date: string, rows: number): void {
  const year = yearOf(date);
  const counts = accumulator.countsByYear.get(year) ?? [];
  counts.push(rows);
  accumulator.countsByYear.set(year, counts);
}

/** The middle of a sorted list, averaging the two middles when the length is even. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;

  const lower = sorted[middle - 1] ?? 0;
  const upper = sorted[middle] ?? 0;
  return (lower + upper) / 2;
}

/**
 * A digest of the response's *table* alone, or `null` when there is no table.
 *
 * Deliberately not a digest of the whole response: the heading names the requested date,
 * so every day would differ by construction and the comparison would detect nothing.
 * See the note at the top of this file.
 */
export function tableDigest(html: string): string | null {
  const table = extractTableById(html, TABLE_ID);
  if (table === null) return null;

  return createHash("sha256").update(JSON.stringify(table)).digest("hex");
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Walks the range and archives every session it finds.
 *
 * Throws only on the two conditions that make continuing pointless: too many
 * consecutive failures, and two different days returning an identical table.
 */
export async function runBackfill(
  options: BackfillOptions,
  deps: BackfillDeps,
): Promise<BackfillSummary> {
  const days = eachDay(options.from, options.to);
  const accumulator = emptyAccumulator();

  // Digest of a session's table, to the first date that produced it.
  const digests = new Map<string, string>();

  let issued = 0;
  let consecutiveFailures = 0;

  for (const date of days) {
    // Cheapest and most valuable check first: no network, no delay, and it is what
    // makes a resumed run finish in seconds rather than hours.
    if (await deps.isArchived(date)) {
      accumulator.skipped.push(date);
      deps.log(`${date}  skipped     already on disk`);
      continue;
    }

    // Delayed by requests *issued* rather than by loop index, so a run of skipped days
    // cannot compress the pause into a burst.
    if (issued > 0) await deps.sleep(REQUEST_DELAY_MS);
    issued++;

    let html: string;
    try {
      html = await deps.fetchDated(date);
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures++;
      const message = toError(error).message;
      accumulator.failed.push({ date, message });
      deps.log(`${date}  FAILED      ${message}`);

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        throw new Error(
          `${consecutiveFailures} days in a row failed, most recently ${date} (${message}). ` +
            "That is not a bad day, so the sweep is stopping rather than repeating it " +
            "several thousand more times. Re-run to resume from here.",
        );
      }
      continue;
    }

    let snapshot: DaySnapshot | null;
    try {
      snapshot = parseBackfillDay(html, date, options.minRows);
    } catch (error) {
      if (error instanceof ImplausibleSessionError) {
        // Real data, just less of it than the floor allows — an operator can re-run this
        // one day with a lower floor, so it is reported as a decision rather than a fault.
        accumulator.refused.push({ date, rows: error.rows, message: error.message });
        deps.log(`${date}  REFUSED     ${error.rows} scrips, below the floor of ${options.minRows}`);
      } else {
        accumulator.failed.push({ date, message: toError(error).message });
        deps.log(`${date}  FAILED      ${toError(error).message}`);
      }
      continue;
    }

    if (snapshot === null) {
      accumulator.noSession.push(date);
      deps.log(`${date}  no session  the market did not trade`);
      continue;
    }

    // Outside the parse try on purpose: a repeated table is a systematic break, not a
    // bad day, and must propagate rather than be recorded and stepped over.
    const digest = tableDigest(html);
    if (digest !== null) {
      const previous = digests.get(digest);
      if (previous !== undefined && previous !== date) {
        throw new Error(
          `${previous} and ${date} returned an identical table. The endpoint is serving ` +
            "one session under many dates, so nothing from this sweep can be trusted.",
        );
      }
      digests.set(digest, date);
    }

    if (!options.dryRun) {
      try {
        await deps.write(snapshot);
      } catch (error) {
        consecutiveFailures++;
        accumulator.failed.push({ date, message: toError(error).message });
        deps.log(`${date}  FAILED      could not write: ${toError(error).message}`);

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          throw new Error(
            `${consecutiveFailures} days in a row could not be written, most recently ` +
              `${date}. The sweep is stopping rather than repeating it.`,
          );
        }
        continue;
      }
    }

    tally(accumulator, date, snapshot.rows.length);
    accumulator.archived.push({ date, rows: snapshot.rows.length });
    deps.log(
      `${date}  ${options.dryRun ? "would write" : "archived   "} ${snapshot.rows.length} scrips`,
    );
  }

  return summarise(accumulator);
}

/** Rolls the accumulator into the per-year report. */
function summarise(accumulator: Accumulator): BackfillSummary {
  const years = new Map<string, YearStats>();

  const touched = new Set<string>([
    ...accumulator.countsByYear.keys(),
    ...accumulator.skipped.map(yearOf),
    ...accumulator.noSession.map(yearOf),
    ...accumulator.refused.map((entry) => yearOf(entry.date)),
    ...accumulator.failed.map((entry) => yearOf(entry.date)),
  ]);

  for (const year of [...touched].sort()) {
    const counts = accumulator.countsByYear.get(year) ?? [];

    years.set(year, {
      archived: counts.length,
      rows: counts.reduce((total, count) => total + count, 0),
      noSession: accumulator.noSession.filter((date) => yearOf(date) === year).length,
      skipped: accumulator.skipped.filter((date) => yearOf(date) === year).length,
      refused: accumulator.refused.filter((entry) => yearOf(entry.date) === year).length,
      failed: accumulator.failed.filter((entry) => yearOf(entry.date) === year).length,
      minRows: counts.length === 0 ? null : Math.min(...counts),
      medianRows: counts.length === 0 ? null : median(counts),
      maxRows: counts.length === 0 ? null : Math.max(...counts),
    });
  }

  return {
    archived: accumulator.archived,
    noSession: accumulator.noSession,
    skipped: accumulator.skipped,
    refused: accumulator.refused,
    failed: accumulator.failed,
    years,
  };
}

/**
 * The report at the end of a sweep.
 *
 * The per-year scrip counts are not decoration. They are the evidence for the floor:
 * a year whose minimum sits far below its median is the signature of a truncated
 * response that still cleared the floor, and it is visible here without any extra
 * machinery having to exist for it.
 */
export function formatSummary(summary: BackfillSummary, options: BackfillOptions): string {
  const lines: string[] = [];

  lines.push(`Backfill ${options.from} → ${options.to} (floor ${options.minRows} scrips)`);
  lines.push("");

  for (const [year, stats] of summary.years) {
    const scrips =
      stats.minRows === null
        ? "none archived"
        : `min ${stats.minRows}, median ${stats.medianRows}, max ${stats.maxRows}`;

    lines.push(`  ${year}`);
    lines.push(`    archived    ${stats.archived} sessions, ${stats.rows} rows`);
    lines.push(`    no session  ${stats.noSession} days`);
    lines.push(`    skipped     ${stats.skipped} days`);
    lines.push(`    refused     ${stats.refused} days`);
    lines.push(`    failed      ${stats.failed} days`);
    lines.push(`    scrips/day  ${scrips}`);
  }

  if (summary.refused.length > 0) {
    lines.push("");
    lines.push("Refused days parsed, but below the floor. Re-run each with a floor that fits:");

    for (const entry of summary.refused) {
      lines.push(
        `  pnpm backfill --from ${entry.date} --to ${entry.date} --min-rows ${entry.rows}`,
      );
    }
  }

  if (summary.failed.length > 0) {
    lines.push("");
    lines.push("Failed days — re-run the range to pick them up:");

    for (const entry of summary.failed) {
      lines.push(`  ${entry.date}  ${entry.message}`);
    }
  }

  lines.push("");
  lines.push(
    `Archived ${summary.archived.length}, skipped ${summary.skipped.length}, ` +
      `no session ${summary.noSession.length}, refused ${summary.refused.length}, ` +
      `failed ${summary.failed.length}.`,
  );

  return lines.join("\n");
}

/**
 * Non-zero when anything was left unresolved.
 *
 * A refused or failed day is an unfinished job, and this repository's position is that
 * an unresolved day should be loud rather than a line in a log nobody reads. Exit 0
 * means every day in the range is accounted for: archived, already on disk, or
 * confirmed by the source to have had no session.
 */
export function exitCodeFor(summary: BackfillSummary): 0 | 1 {
  return summary.refused.length > 0 || summary.failed.length > 0 ? 1 : 0;
}
