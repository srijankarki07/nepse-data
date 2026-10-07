/**
 * Waiting for a session, and refusing one that will not hold still.
 *
 * Everything runs against an injected clock and an injected sleep, so a 45-minute wait is
 * exercised in microseconds, and more importantly deterministically. A loop whose
 * deadline is real time cannot be tested at its boundary without either waiting for the
 * boundary or reaching into the runtime to fake it, and the boundary is the only part
 * worth testing.
 *
 * The clock here advances *because* of the sleep, which is exactly the contract the
 * production loop relies on: `sleep(ms)` moves `now()` by `ms`. A harness where those two
 * disagreed would let a loop that never terminates pass.
 */

import { describe, expect, it } from "vitest";

import {
  IncompleteSessionError,
  MIN_COMPLETENESS,
  awaitSession,
  formatElapsed,
  type Readiness,
  type ReadinessDeps,
  type ReadinessOptions,
} from "../src/lib/readiness.js";
import type { FetchedSession } from "../src/sources/sharesansar.js";

const TARGET = "2026-10-07";
const PREVIOUS = "2026-10-06";

/** The page's reply: the session it reports, how many scrips, and a close to tell replies apart. */
function table(date: string, rows: number, close = 2): FetchedSession {
  return {
    snapshot: {
      date,
      rows: Array.from({ length: rows }, (_, index) => ({
        symbol: `S${String(index).padStart(3, "0")}`,
        open: 1,
        high: 2,
        low: 1,
        close,
        volume: 3,
        turnover: 4,
      })),
    },
    names: new Map<string, string>(),
  };
}

/** One scrip, which is all the date-and-movement cases need. */
function page(date: string, close = 2): FetchedSession {
  return table(date, 1, close);
}

/**
 * Replies are consumed in order and the last one repeats.
 *
 * Repetition rather than exhaustion is what makes the budget cases expressible: "the page
 * reports the previous session, forever" is one entry, not ninety.
 */
type Reply = FetchedSession | Error;

interface Harness {
  deps: ReadinessDeps;
  options: ReadinessOptions;
  sleeps: number[];
  logs: string[];
  fetches: () => number;
}

function harness(replies: Reply[], options: Partial<ReadinessOptions> = {}): Harness {
  const sleeps: number[] = [];
  const logs: string[] = [];
  let clock = 0;
  let issued = 0;

  const deps: ReadinessDeps = {
    fetchSession: async () => {
      const reply = replies[Math.min(issued, replies.length - 1)];
      issued++;
      if (reply === undefined) throw new Error("the harness ran out of replies");
      if (reply instanceof Error) throw reply;
      return reply;
    },
    // The clock moves because of the sleep. See the note at the top of this file.
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    log: (line) => {
      logs.push(line);
    },
  };

  return {
    deps,
    // Spelled out rather than spread over a `Partial`, so an override that is deliberately
    // `null` (an empty archive) cannot be confused with one that was simply not given.
    options: {
      target: options.target ?? TARGET,
      budgetMs: options.budgetMs ?? 60_000,
      intervalMs: options.intervalMs ?? 10_000,
      confirmMs: options.confirmMs ?? 5_000,
      baselineRows: options.baselineRows ?? null,
      minCompleteness: options.minCompleteness ?? 0,
    },
    sleeps,
    logs,
    fetches: () => issued,
  };
}

/**
 * Asserts the outcome's kind and narrows it, so the field access below is checked.
 *
 * A matcher proves nothing to the compiler, so without this every test that reads
 * `result.session` would need a non-null assertion, which is the one thing that would
 * let a `stale` result be read as though it were `ready`.
 */
function narrow<K extends Readiness["kind"]>(
  result: Readiness,
  kind: K,
): Extract<Readiness, { kind: K }> {
  expect(result.kind).toBe(kind);
  return result as Extract<Readiness, { kind: K }>;
}

describe("awaitSession", () => {
  it("reads twice and reports ready when the page already holds the target", async () => {
    const test = harness([page(TARGET)]);

    const result = await awaitSession(test.options, test.deps);

    expect(result.kind).toBe("ready");
    // One read to see the session, one to confirm it has not moved since.
    expect(test.fetches()).toBe(2);
    expect(test.sleeps).toEqual([5_000]);
  });

  it("waits through the previous session until the target appears", async () => {
    const test = harness([
      page(PREVIOUS),
      page(PREVIOUS),
      page(PREVIOUS),
      page(TARGET),
      page(TARGET),
    ]);

    const result = await awaitSession(test.options, test.deps);

    expect(result.kind).toBe("ready");
    // Four polls, and the last one's confirm read makes five requests. `attempts` counts
    // polls rather than requests, so the two numbers differing here is the point.
    expect(result.attempts).toBe(4);
    expect(test.fetches()).toBe(5);
    // Three polls at the interval, then the confirm pause, never the interval.
    expect(test.sleeps).toEqual([10_000, 10_000, 10_000, 5_000]);
  });

  it("spends exactly its budget on a day the market was shut", async () => {
    const test = harness([page(PREVIOUS)]);

    const result = narrow(await awaitSession(test.options, test.deps), "stale");

    expect(result.session.snapshot.date).toBe(PREVIOUS);
    expect(result.waitedMs).toBe(60_000);
    expect(test.sleeps.reduce((total, ms) => total + ms, 0)).toBe(60_000);
  });

  it("keeps waiting when the table moves under the confirm read, and returns the settled one", async () => {
    const test = harness([page(TARGET, 2), page(TARGET, 9), page(TARGET, 9)]);

    const result = narrow(await awaitSession(test.options, test.deps), "ready");

    expect(result.session.snapshot.rows[0]?.close).toBe(9);
    expect(test.sleeps).toEqual([5_000, 10_000, 5_000]);
    expect(test.logs.join("\n")).toContain("still moving");
  });

  it("refuses a session that never holds still, and offers nothing to write", async () => {
    const test = harness(
      [page(TARGET, 1), page(TARGET, 2), page(TARGET, 3), page(TARGET, 4)],
      { budgetMs: 15_000, intervalMs: 5_000 },
    );

    const result = await awaitSession(test.options, test.deps);

    expect(result.kind).toBe("unsettled");
    // Structural, not a convention: only `ready` carries a `session`, so a caller cannot
    // write a moving table even by accident.
    expect("session" in result).toBe(false);
  });

  it("retries a fetch that fails while the budget lasts", async () => {
    const test = harness([new Error("socket hang up"), page(TARGET)]);

    const result = await awaitSession(test.options, test.deps);

    expect(result.kind).toBe("ready");
    expect(test.sleeps).toEqual([10_000, 5_000]);
  });

  it("throws rather than calling an unreachable source a closed market", async () => {
    const test = harness([new Error("ECONNREFUSED")], { budgetMs: 10_000 });

    await expect(awaitSession(test.options, test.deps)).rejects.toThrow("ECONNREFUSED");
  });

  it("reads once and stops when the budget is zero and the source is behind", async () => {
    // The backstop's case: GitHub's cron firing at 01:01 Kathmandu the next morning sees
    // the previous session. That is a holiday or a recovery, never a reason to wait.
    const test = harness([page(PREVIOUS)], { budgetMs: 0, confirmMs: 60_000 });

    const result = await awaitSession(test.options, test.deps);

    expect(result.kind).toBe("stale");
    expect(test.fetches()).toBe(1);
    expect(test.sleeps).toEqual([]);
  });

  it("trusts the first reading when the confirm is disabled", async () => {
    const test = harness([page(TARGET)], { confirmMs: 0 });

    const result = await awaitSession(test.options, test.deps);

    expect(result.kind).toBe("ready");
    expect(test.fetches()).toBe(1);
    expect(test.sleeps).toEqual([]);
  });

  it("lets the confirm read finish even if it runs past the budget", async () => {
    // Deliberate: the confirm is the check that makes an early fetch safe, so truncating
    // it to save a second would defeat the thing being waited for.
    const test = harness([page(TARGET)], { budgetMs: 1_000, confirmMs: 5_000 });

    const result = await awaitSession(test.options, test.deps);

    expect(result.kind).toBe("ready");
    expect(result.waitedMs).toBe(5_000);
  });

  it("announces the wait once rather than on every attempt", async () => {
    const test = harness([page(PREVIOUS), page(PREVIOUS), page(PREVIOUS), page(TARGET)], {
      budgetMs: 30_000,
    });

    await awaitSession(test.options, test.deps);

    const waiting = test.logs.filter((line) => line.includes("Waiting for"));
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toContain(PREVIOUS);
  });
});

describe("the completeness floor", () => {
  // The numbers here are the archive's, not invented: over the 177 sessions of 2026 the
  // thinnest is 261 rows against 329 the session before it, and the floor clears that
  // worst real ratio of 0.79 by 29 points.
  const YESTERDAY = 344;
  const THINNEST_REAL_DAY = 261;

  it("keeps polling a table that is still filling in, then accepts the full one", async () => {
    const test = harness([table(TARGET, 120), table(TARGET, 340), table(TARGET, 340)], {
      baselineRows: YESTERDAY,
      minCompleteness: MIN_COMPLETENESS,
      budgetMs: 120_000,
    });

    const result = narrow(await awaitSession(test.options, test.deps), "ready");

    expect(result.session.snapshot.rows).toHaveLength(340);
    // The short read costs one request, not a confirm pair. The floor is checked before
    // the second read precisely so a still-filling table is cheap to wait out.
    expect(test.fetches()).toBe(3);
    expect(test.sleeps).toEqual([10_000, 5_000]);
  });

  it("refuses a table that stays short for the whole budget, and writes nothing", async () => {
    const test = harness([table(TARGET, 120)], {
      baselineRows: YESTERDAY,
      minCompleteness: MIN_COMPLETENESS,
      budgetMs: 20_000,
    });

    await expect(awaitSession(test.options, test.deps)).rejects.toBeInstanceOf(
      IncompleteSessionError,
    );
  });

  it("says once that it is waiting for a short table to fill", async () => {
    const test = harness([table(TARGET, 120), table(TARGET, 120), table(TARGET, 340)], {
      baselineRows: YESTERDAY,
      minCompleteness: MIN_COMPLETENESS,
      budgetMs: 120_000,
    });

    await awaitSession(test.options, test.deps);

    // Once, not once per poll: a table that takes ten minutes to fill would otherwise
    // write the same sentence twenty times and bury everything else in the log.
    expect(test.logs.filter((line) => line.includes("Waiting for it to fill"))).toHaveLength(1);
  });

  it("names both counts and the override, so the refusal is actionable", async () => {
    const test = harness([table(TARGET, 120)], {
      baselineRows: YESTERDAY,
      minCompleteness: MIN_COMPLETENESS,
      budgetMs: 0,
    });

    // Budget zero makes this the backstop's case: a single read that is short is refused
    // on the spot rather than waited on.
    await expect(awaitSession(test.options, test.deps)).rejects.toThrow(
      /holds 120 scrips against 344 .*--min-completeness 0/,
    );
  });

  it("accepts the thinnest day the archive has actually seen", async () => {
    // 2026-03-09 fell to 261 against 329. A floor set anywhere near the observed worst
    // case would have refused a real session, which is why it is 0.5 and not 0.8.
    const test = harness([table(TARGET, THINNEST_REAL_DAY)], {
      baselineRows: 329,
      minCompleteness: MIN_COMPLETENESS,
    });

    expect(narrow(await awaitSession(test.options, test.deps), "ready").session.snapshot.rows)
      .toHaveLength(THINNEST_REAL_DAY);
  });

  it("has no floor to apply when the archive is empty", async () => {
    const test = harness([page(TARGET)], {
      baselineRows: null,
      minCompleteness: MIN_COMPLETENESS,
    });

    expect(narrow(await awaitSession(test.options, test.deps), "ready").kind).toBe("ready");
  });

  it("can be switched off, for a day that really did trade thin", async () => {
    const test = harness([table(TARGET, 10)], {
      baselineRows: YESTERDAY,
      minCompleteness: 0,
    });

    expect(narrow(await awaitSession(test.options, test.deps), "ready").session.snapshot.rows)
      .toHaveLength(10);
  });
});

describe("formatElapsed", () => {
  it("stays in seconds until a minute has passed, then pads them", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(59_400)).toBe("59s");
    expect(formatElapsed(60_000)).toBe("1m00s");
    expect(formatElapsed(192_000)).toBe("3m12s");
  });
});
