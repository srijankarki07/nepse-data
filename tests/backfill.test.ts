/**
 * The sweep.
 *
 * Everything here runs against injected dependencies, so a 105-minute job is tested in
 * milliseconds and none of it touches the network. What is being tested is the control
 * flow — what is skipped, what is written, what stops the run — rather than the parsing,
 * which `sharesansar.test.ts` covers against real captures.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_CONSECUTIVE_FAILURES,
  MAX_CONSECUTIVE_REPEATS,
  REQUEST_DELAY_MS,
  exitCodeFor,
  formatSummary,
  runBackfill,
  type BackfillDeps,
  type BackfillOptions,
} from "../src/backfill.js";
import { snapshotToCsv } from "../src/lib/serialize.js";
import type { DaySnapshot } from "../src/types.js";

// `S.No` leads, as it does on the real page. That is not cosmetic: the closed-day row
// is a single `colspan` cell, and without a column before `Symbol` that cell lands in
// the symbol position and parses as a ticker called "NO RECORD FOUND.".
const HEADER =
  "<tr><th>S.No</th><th>Symbol</th><th>Open</th><th>High</th><th>Low</th><th>Close</th>" +
  "<th>Vol</th><th>Turnover</th></tr>";

/**
 * A dated fragment carrying `count` scrips.
 *
 * The symbols carry the date, so that two days of the same length do not accidentally
 * produce identical tables — which the sweep would correctly read as the endpoint
 * serving one session under many dates, and abort on.
 */
function fragment(date: string, count: number): string {
  const tag = date.slice(5).replace("-", "");

  const rows = Array.from(
    { length: count },
    (_, index) =>
      `<tr><td>${index + 1}</td><td>S${tag}${String(index).padStart(2, "0")}</td>` +
      `<td>1</td><td>2</td><td>1</td><td>2</td><td>3</td><td>4</td></tr>`,
  ).join("");

  return (
    `<h5>As of : <span class="text-org">${date}</span></h5>` +
    `<table id="headFixed"><thead>${HEADER}</thead><tbody>${rows}</tbody></table>`
  );
}

/** A dated fragment for a day the market did not trade. */
function closedFragment(date: string): string {
  return (
    `<h5>As of : <span class="text-org">${date}</span></h5>` +
    `<table id="headFixed"><thead>${HEADER}</thead>` +
    `<tbody><tr><td colspan="19"> No Record Found.</td></tr></tbody></table>` +
    `<h4>Total number of Compaines: 0</h4>`
  );
}

interface Harness {
  deps: BackfillDeps;
  fetched: string[];
  written: DaySnapshot[];
  sleeps: number[];
  logs: string[];
}

/**
 * A sweeper wired to nothing.
 *
 * `responses` maps a date to the fragment it returns, or to an `Error` to be thrown —
 * which is how a transient failure is simulated without a network.
 */
function harness(options: {
  responses: Map<string, string | Error>;
  archived?: readonly string[];
  writeFails?: boolean;
  log?: boolean;
}): Harness {
  const fetched: string[] = [];
  const written: DaySnapshot[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];

  const onDisk = new Set(options.archived ?? []);

  const deps: BackfillDeps = {
    fetchDated: async (date) => {
      fetched.push(date);
      const response = options.responses.get(date);
      if (response === undefined) throw new Error(`no response queued for ${date}`);
      if (response instanceof Error) throw response;
      return response;
    },
    isArchived: async (date) => onDisk.has(date),
    write: async (snapshot) => {
      if (options.writeFails === true) throw new Error("ENOSPC");
      written.push(snapshot);
      onDisk.add(snapshot.date);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (line) => {
      if (options.log === true) console.log(line);
      logs.push(line);
    },
  };

  return { deps, fetched, written, sleeps, logs };
}

const baseOptions: BackfillOptions = {
  from: "2024-06-10",
  to: "2024-06-14",
  minRows: 1,
  dryRun: false,
};

describe("runBackfill", () => {
  it("archives a session with the bytes the serializer produces", async () => {
    const responses = new Map<string, string | Error>([
      ["2024-06-10", fragment("2024-06-10", 3)],
      ["2024-06-11", fragment("2024-06-11", 2)],
      ["2024-06-12", fragment("2024-06-12", 4)],
      ["2024-06-13", fragment("2024-06-13", 2)],
      ["2024-06-14", fragment("2024-06-14", 1)],
    ]);
    const test = harness({ responses });

    const summary = await runBackfill(baseOptions, test.deps);

    expect(summary.archived).toHaveLength(5);
    expect(test.written[0]?.date).toBe("2024-06-10");
    expect(summary.archived[0]).toEqual({ date: "2024-06-10", rows: 3 });
    // Byte-for-byte what the archive format says, not just "something was written".
    expect(snapshotToCsv(test.written[0] as DaySnapshot)).toContain("2024-06-10,S061000,");
  });

  it("never asks the network about a day already on disk", async () => {
    // The property the whole resume story rests on: a re-run costs nothing.
    const responses = new Map<string, string | Error>([
      ["2024-06-11", fragment("2024-06-11", 2)],
    ]);
    const test = harness({
      responses,
      archived: ["2024-06-10", "2024-06-12", "2024-06-13", "2024-06-14"],
    });

    const summary = await runBackfill(baseOptions, test.deps);

    expect(test.fetched).toEqual(["2024-06-11"]);
    expect(summary.skipped).toEqual([
      "2024-06-10",
      "2024-06-12",
      "2024-06-13",
      "2024-06-14",
    ]);
    expect(summary.archived).toEqual([{ date: "2024-06-11", rows: 2 }]);
  });

  it("treats a day the market did not trade as an outcome, not a failure", async () => {
    const responses = new Map<string, string | Error>([
      ["2024-06-10", closedFragment("2024-06-10")],
    ]);
    const test = harness({ responses, archived: ["2024-06-11", "2024-06-12", "2024-06-13", "2024-06-14"] });

    const summary = await runBackfill(baseOptions, test.deps);

    expect(summary.noSession).toEqual(["2024-06-10"]);
    expect(summary.failed).toHaveLength(0);
    expect(test.written).toHaveLength(0);
    expect(exitCodeFor(summary)).toBe(0);
  });

  it("refuses a day below the floor rather than writing it", async () => {
    const responses = new Map<string, string | Error>([
      ["2024-06-10", fragment("2024-06-10", 2)],
    ]);
    const test = harness({ responses });
    const options: BackfillOptions = { ...baseOptions, to: "2024-06-10", minRows: 10 };

    const summary = await runBackfill(options, test.deps);

    expect(summary.refused).toHaveLength(1);
    expect(summary.refused[0]?.rows).toBe(2);
    expect(test.written).toHaveLength(0);
    // Unresolved, so the run is red — but the day is recoverable, and says how.
    expect(exitCodeFor(summary)).toBe(1);
  });

  it("steps over one bad day and carries on", async () => {
    const responses = new Map<string, string | Error>([
      ["2024-06-10", fragment("2024-06-10", 2)],
      ["2024-06-11", new Error("socket hang up")],
      ["2024-06-12", fragment("2024-06-12", 2)],
      ["2024-06-13", fragment("2024-06-13", 2)],
      ["2024-06-14", fragment("2024-06-14", 2)],
    ]);
    const test = harness({ responses });

    const summary = await runBackfill(baseOptions, test.deps);

    expect(summary.failed).toEqual([{ date: "2024-06-11", message: "socket hang up" }]);
    expect(summary.archived.map((entry) => entry.date)).toEqual([
      "2024-06-10",
      "2024-06-12",
      "2024-06-13",
      "2024-06-14",
    ]);
  });

  it("aborts after too many consecutive failures rather than repeating them", async () => {
    // Five identical failures is not five bad days; it is the site being down, and
    // thousands more requests would only prove it again.
    const responses = new Map<string, string | Error>();
    const days = ["2024-06-10", "2024-06-11", "2024-06-12", "2024-06-13", "2024-06-14"];
    for (const day of days) responses.set(day, new Error("503"));

    const test = harness({ responses });
    const options: BackfillOptions = { ...baseOptions, to: "2024-06-20" };

    await expect(runBackfill(options, test.deps)).rejects.toThrow(/in a row failed/);
    expect(test.fetched).toHaveLength(MAX_CONSECUTIVE_FAILURES);
  });

  it("resets the consecutive count when a day succeeds", async () => {
    const responses = new Map<string, string | Error>([
      ["2024-06-10", new Error("503")],
      ["2024-06-11", new Error("503")],
      ["2024-06-12", fragment("2024-06-12", 2)],
      ["2024-06-13", new Error("503")],
      ["2024-06-14", new Error("503")],
    ]);
    const test = harness({ responses });

    const summary = await runBackfill(baseOptions, test.deps);

    expect(summary.failed).toHaveLength(4);
    expect(summary.archived).toHaveLength(1);
  });

  it("refuses a day that repeats another's table, without stopping the sweep", async () => {
    // Measured against the real source, not invented: 2011-06-20 has no data, and the
    // endpoint serves 2011-06-19's table under a 2011-06-20 heading. It has to be caught
    // — but it cost a first sweep the whole second half of 2011 to abort on it, and the
    // days either side were perfectly good.
    const table = fragment("2024-06-10", 2);
    const responses = new Map<string, string | Error>([
      ["2024-06-10", table],
      ["2024-06-11", table.replaceAll("2024-06-10", "2024-06-11")],
      ["2024-06-12", fragment("2024-06-12", 3)],
      ["2024-06-13", fragment("2024-06-13", 3)],
      ["2024-06-14", fragment("2024-06-14", 3)],
    ]);
    const test = harness({ responses });

    const summary = await runBackfill(baseOptions, test.deps);

    expect(summary.repeated).toEqual([{ date: "2024-06-11", matches: "2024-06-10" }]);
    // Not written — the guard's whole purpose — but the days after it still are.
    expect(test.written.map((snapshot) => snapshot.date)).not.toContain("2024-06-11");
    expect(summary.archived.map((entry) => entry.date)).toEqual([
      "2024-06-10",
      "2024-06-12",
      "2024-06-13",
      "2024-06-14",
    ]);
    expect(exitCodeFor(summary)).toBe(1);
  });

  it("stops when the repeats run consecutively, which is the endpoint failing", async () => {
    // One day served from the day before is a hole in the source. Ten in a row is the
    // endpoint answering every date with one session, and then nothing is worth fetching.
    const table = fragment("2024-06-10", 2);
    const responses = new Map<string, string | Error>();
    const options: BackfillOptions = { ...baseOptions, from: "2024-06-10", to: "2024-06-30" };

    for (const day of [
      "2024-06-10",
      "2024-06-11",
      "2024-06-12",
      "2024-06-13",
      "2024-06-14",
      "2024-06-15",
      "2024-06-16",
      "2024-06-17",
      "2024-06-18",
      "2024-06-19",
      "2024-06-20",
    ]) {
      responses.set(day, table.replaceAll("2024-06-10", day));
    }

    const test = harness({ responses });

    await expect(runBackfill(options, test.deps)).rejects.toThrow(/already seen/);
    // The first day establishes the table; the next MAX_CONSECUTIVE_REPEATS are refusals.
    expect(test.fetched).toHaveLength(MAX_CONSECUTIVE_REPEATS + 1);
  });

  it("resets the repeat count when a genuinely new session appears", async () => {
    const table = fragment("2024-06-10", 2);
    const responses = new Map<string, string | Error>([
      ["2024-06-10", table],
      ["2024-06-11", table.replaceAll("2024-06-10", "2024-06-11")],
      ["2024-06-12", fragment("2024-06-12", 3)],
      ["2024-06-13", table.replaceAll("2024-06-10", "2024-06-13")],
      ["2024-06-14", fragment("2024-06-14", 4)],
    ]);
    const test = harness({ responses });

    const summary = await runBackfill(baseOptions, test.deps);

    expect(summary.repeated.map((entry) => entry.date)).toEqual(["2024-06-11", "2024-06-13"]);
    expect(summary.archived).toHaveLength(3);
  });

  it("does not confuse two holidays with each other", async () => {
    // Every closed day shares the same header-only table, so digesting them would abort
    // on the second holiday of every sweep.
    const responses = new Map<string, string | Error>([
      ["2024-06-10", closedFragment("2024-06-10")],
      ["2024-06-11", closedFragment("2024-06-11")],
    ]);
    const test = harness({ responses });
    const options: BackfillOptions = { ...baseOptions, to: "2024-06-11" };

    const summary = await runBackfill(options, test.deps);
    expect(summary.noSession).toEqual(["2024-06-10", "2024-06-11"]);
  });

  it("writes nothing at all under --dry-run", async () => {
    const responses = new Map<string, string | Error>([
      ["2024-06-10", fragment("2024-06-10", 2)],
    ]);
    const test = harness({ responses });
    const options: BackfillOptions = { ...baseOptions, to: "2024-06-10", dryRun: true };

    const summary = await runBackfill(options, test.deps);

    expect(test.written).toHaveLength(0);
    expect(summary.archived).toHaveLength(1);
    expect(test.logs.join("\n")).toContain("would write");
  });

  it("pauses between requests, but not for days it skipped", async () => {
    const responses = new Map<string, string | Error>([
      ["2024-06-11", fragment("2024-06-11", 2)],
      ["2024-06-12", fragment("2024-06-12", 2)],
      ["2024-06-13", fragment("2024-06-13", 2)],
    ]);
    const test = harness({ responses, archived: ["2024-06-10", "2024-06-14"] });

    await runBackfill(baseOptions, test.deps);

    // Three requests, two pauses — the first is not delayed, and the two skipped days
    // cost nothing, or a resumed sweep would be slower than a fresh one for no reason.
    expect(test.fetched).toHaveLength(3);
    expect(test.sleeps).toEqual([REQUEST_DELAY_MS, REQUEST_DELAY_MS]);
  });

  it("reports each day's outcome as it goes", async () => {
    const responses = new Map<string, string | Error>([
      ["2024-06-10", fragment("2024-06-10", 2)],
      ["2024-06-11", closedFragment("2024-06-11")],
      ["2024-06-12", new Error("503")],
    ]);
    const test = harness({ responses, archived: ["2024-06-13", "2024-06-14"] });

    await runBackfill(baseOptions, test.deps);
    const output = test.logs.join("\n");

    expect(output).toContain("2024-06-10  archived");
    expect(output).toContain("2024-06-11  no session");
    expect(output).toContain("2024-06-12  FAILED");
    expect(output).toContain("2024-06-13  skipped");
  });
});

describe("formatSummary", () => {
  it("reports per-year scrip counts, which is how a bad floor shows itself", async () => {
    const responses = new Map<string, string | Error>([
      ["2011-06-10", fragment("2011-06-10", 4)],
      ["2011-06-11", fragment("2011-06-11", 6)],
      ["2011-06-12", fragment("2011-06-12", 8)],
    ]);
    const test = harness({ responses });
    const options: BackfillOptions = { from: "2011-06-10", to: "2011-06-12", minRows: 1, dryRun: false };

    const summary = await runBackfill(options, test.deps);
    const output = formatSummary(summary, options);

    // min 4, median 6, max 8 — a year whose minimum sits far below its median is the
    // shape of a truncated response that still cleared the floor.
    expect(output).toContain("min 4, median 6, max 8");
    expect(output).toContain("archived    3 sessions, 18 rows");
  });

  it("prints the exact command that would recover a refused day", async () => {
    const responses = new Map<string, string | Error>([
      ["2024-06-10", fragment("2024-06-10", 3)],
    ]);
    const test = harness({ responses });
    const options: BackfillOptions = { ...baseOptions, to: "2024-06-10", minRows: 10 };

    const summary = await runBackfill(options, test.deps);

    expect(formatSummary(summary, options)).toContain(
      "pnpm backfill --from 2024-06-10 --to 2024-06-10 --min-rows 3",
    );
  });
});
