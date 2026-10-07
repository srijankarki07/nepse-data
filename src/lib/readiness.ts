/**
 * Waiting for a session to be published, and for it to stop moving.
 *
 * ## Why the hour of slack is gone
 *
 * The daily job used to run at a fixed hour chosen to be safely after the close, on the
 * reasoning that an hour is long enough for the figures to be final. That reasoning is
 * sound and it is also the wrong trade: it makes every session at least an hour late, to
 * cover a wait that is usually minutes. Worse, it cannot be made short enough to matter,
 * because the *source's* publishing moment is not knowable in advance and does not move
 * with our clock.
 *
 * So this module inverts it. The job is triggered just after the close and then **waits
 * for the source** rather than guessing when the source will be ready. A session that
 * appears a minute after the bell is archived a minute after the bell; one that appears
 * forty minutes later is still archived the moment it lands, without anyone having to
 * revise a cron expression.
 *
 * ## Why "published" is not the same as "final"
 *
 * A table that has just appeared may still be filling in, and the archive is append-only
 * in spirit: a day, once written, is a historical record, and a later run that disagrees
 * with it is a bug report rather than a correction (see `lib/archive.ts`). Fetching at the
 * earliest possible moment is therefore only safe if the earliest possible moment is not
 * trusted. That is the confirm step: the page is read again after `confirmMs`, and the two
 * readings are compared as **CSV**, the canonical byte form of a session
 * (`lib/serialize.ts`). Raw HTML differs between two responses for reasons that have
 * nothing to do with the figures, so comparing it would confirm nothing.
 *
 * A page that never holds still is reported as `unsettled` and is **never written**. A
 * moving table is not a session; committing one would put a figure into the archive that
 * the source itself had not finished saying.
 *
 * Byte-stability is still not enough on its own, and the gap is worth naming plainly: a
 * table can stop changing before it has finished arriving. `IncompleteSessionError`
 * covers that, and records the measurements its floor was set from.
 *
 * ## Why a date that is not today is not an error
 *
 * The page reports whatever session it last had, which on a closed day is the previous
 * one. "The market was shut" and "the source has not published yet" are the same
 * observation from here, and both resolve to a session that is already archived: its
 * write is a no-op, so the run commits nothing. `stale` is the ordinary outcome on a
 * holiday, not a failure.
 *
 * The one thing this module will not do is invent a date from the clock. The date it
 * waits for comes from the caller, and the date it returns comes from the page.
 */

import { snapshotToCsv } from "./serialize.js";
import type { FetchedSession } from "../sources/sharesansar.js";

/**
 * The pause between attempts.
 *
 * Thirty seconds because the thing being waited for is a web page being republished, not
 * a job being scheduled: the poll only has to be finer than the target ("within half an
 * hour of the close"), and a tighter one spends requests to learn nothing. A 45-minute
 * budget is 90 attempts at this interval.
 */
export const POLL_INTERVAL_MS = 30_000;

/**
 * The default completeness floor: half the newest archived session's scrip count.
 *
 * The measurements behind the number are in `IncompleteSessionError` below. It is a
 * constant rather than a literal at the call site so the two cannot drift apart.
 */
export const MIN_COMPLETENESS = 0.5;

export interface ReadinessOptions {
  /** The session being waited for, as `YYYY-MM-DD`: Kathmandu's today, from `kathmanduToday`. */
  target: string;
  /** How long to keep trying before giving up. Zero means read once and decide. */
  budgetMs: number;
  /** The pause between attempts. */
  intervalMs: number;
  /** How long the page must hold still before it is believed. Zero disables the check. */
  confirmMs: number;
  /**
   * How many scrips the newest archived session holds, or `null` when the archive is empty.
   *
   * The comparator for the completeness floor below. Passed in rather than read here so
   * this module keeps knowing nothing about the disk.
   */
  baselineRows: number | null;
  /** Refuse a session with fewer than this fraction of `baselineRows`. Zero disables it. */
  minCompleteness: number;
}

/**
 * A session that is too small to be the day's trading, judged against the last one.
 *
 * ## Why the row floor does not already cover this
 *
 * `MIN_PLAUSIBLE_ROWS` (50) is calibrated against a *truncated response*, where the page
 * stops mid-table. A table that is still being published is a different shape: it is
 * internally consistent, it can be perfectly stable for the minutes you happen to be
 * watching it, and against a market of ~344 scrips a 120-row page clears 50 with room to
 * spare. Byte-stability cannot see it either: a table that has stopped changing is not
 * the same as a table that has finished.
 *
 * So the only evidence left is size, relative to what a session looked like yesterday.
 * Measured across the 177 sessions of 2026: min 261, median 344, max 383 rows, and the
 * largest legitimate day-over-day fall is 261 against 329, a ratio of 0.79, on
 * `2026-03-09`, a real and complete session. A floor of 0.5 clears every real session on
 * record by 29 points, which is the margin that makes it safe to refuse.
 *
 * Deliberately not higher. A floor near the observed worst case would have refused a real
 * day, and a scraper that refuses real days is worse than one that occasionally keeps a
 * short one.
 */
export class IncompleteSessionError extends Error {
  /** Scrips parsed from the page. */
  readonly rows: number;
  /** Scrips in the newest archived session, the thing it was measured against. */
  readonly baseline: number;

  constructor(date: string, rows: number, baseline: number, ratio: number) {
    super(
      `The ${date} session holds ${rows} scrips against ${baseline} in the newest ` +
        `archived session, below the ${Math.round(ratio * 100)}% floor. Refusing to ` +
        `archive a session that looks half-published. Nothing was written. If the market ` +
        `really was that thin, re-run with --min-completeness 0, or archive the day with ` +
        `\`pnpm backfill --from ${date} --to ${date} --min-rows ${rows}\`.`,
    );
    this.name = "IncompleteSessionError";
    this.rows = rows;
    this.baseline = baseline;
  }
}

/** Injected so the loop is tested in milliseconds without a network, a clock or a disk. */
export interface ReadinessDeps {
  fetchSession: () => Promise<FetchedSession>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
}

/**
 * One of the three ways the wait can end.
 *
 * `attempts` and `waitedMs` are carried on all three so the caller can report how close
 * to the deadline it got, which is the only evidence available that the budget is set
 * anywhere near right.
 */
export type Readiness =
  /** The target session is published and held still. Write it. */
  | { kind: "ready"; session: FetchedSession; attempts: number; waitedMs: number }
  /** The budget ran out while the page still reported an older session. A closed day, usually. */
  | { kind: "stale"; session: FetchedSession; attempts: number; waitedMs: number }
  /** The target session appeared but would not hold still. Never write this. */
  | { kind: "unsettled"; last: FetchedSession; attempts: number; waitedMs: number };

/** `3m12s`, for a log line. Seconds alone stop being readable somewhere around the budget. */
export function formatElapsed(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/**
 * Waits until `options.target` is the session the page reports, and holds still.
 *
 * A failure to fetch is not fatal while the budget lasts: a transient error tells us
 * nothing about whether the session has been published, so it is retried like any other
 * "not yet". Only when the budget is spent does the last error become the outcome, and
 * then it is thrown rather than dressed up as `stale`: a source that is unreachable is
 * not a market that was shut, and the difference is the whole reason this archive is
 * trusted.
 */
export async function awaitSession(
  options: ReadinessOptions,
  deps: ReadinessDeps,
): Promise<Readiness> {
  const start = deps.now();
  const deadline = start + options.budgetMs;
  const elapsed = (): number => deps.now() - start;

  let attempts = 0;
  let announced = false;
  let shortAnnounced = false;

  for (;;) {
    attempts++;

    let session: FetchedSession;
    try {
      session = await deps.fetchSession();
    } catch (error) {
      if (deps.now() >= deadline) throw error;
      await deps.sleep(options.intervalMs);
      continue;
    }

    const reported = session.snapshot.date;

    if (reported !== options.target) {
      if (!announced) {
        deps.log(
          `Waiting for the ${options.target} session; the source reports ${reported}. ` +
            `Budget ${formatElapsed(options.budgetMs)}.`,
        );
        announced = true;
      }

      if (deps.now() >= deadline) {
        return { kind: "stale", session, attempts, waitedMs: elapsed() };
      }

      await deps.sleep(options.intervalMs);
      continue;
    }

    // Checked before the confirm read rather than after: a table that is plainly still
    // filling in does not need a second request to prove it, so a table caught here costs
    // one request per poll instead of two.
    const baseline = options.baselineRows;
    const floor = baseline === null ? 0 : baseline * options.minCompleteness;

    if (baseline !== null && session.snapshot.rows.length < floor) {
      // Said once, not once per poll: a table that takes ten minutes to fill would
      // otherwise write the same sentence twenty times and bury everything else.
      if (!shortAnnounced) {
        deps.log(
          `${reported} holds ${session.snapshot.rows.length} scrips against ${baseline} ` +
            `in the newest archived session. Waiting for it to fill.`,
        );
        shortAnnounced = true;
      }

      if (deps.now() >= deadline) {
        throw new IncompleteSessionError(
          reported,
          session.snapshot.rows.length,
          baseline,
          options.minCompleteness,
        );
      }

      await deps.sleep(options.intervalMs);
      continue;
    }

    if (options.confirmMs === 0) {
      return { kind: "ready", session, attempts, waitedMs: elapsed() };
    }

    // Deliberately not "after Ns": on the first attempt nothing was waited for, and on a
    // later one the elapsed time is the whole poll, not the discovery. Saying what the
    // source reports is the part that is true either way.
    deps.log(
      `The source now reports ${reported}. ` +
        `Confirming it holds still for ${formatElapsed(options.confirmMs)}.`,
    );

    await deps.sleep(options.confirmMs);

    let confirmed: FetchedSession;
    try {
      confirmed = await deps.fetchSession();
    } catch (error) {
      if (deps.now() >= deadline) throw error;
      await deps.sleep(options.intervalMs);
      continue;
    }

    if (snapshotToCsv(confirmed.snapshot) === snapshotToCsv(session.snapshot)) {
      return { kind: "ready", session, attempts, waitedMs: elapsed() };
    }

    // The table moved while we were watching it. Whatever it settles on is the session;
    // what it said in between is not, and must not reach the archive.
    deps.log(`${reported} is still moving. Waiting for it to settle.`);

    if (deps.now() >= deadline) {
      return { kind: "unsettled", last: confirmed, attempts, waitedMs: elapsed() };
    }

    await deps.sleep(options.intervalMs);
  }
}
