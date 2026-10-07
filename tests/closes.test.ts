/**
 * The per-year closes index: `data/closes/`.
 *
 * The shape is the thing being tested, not just the numbers: one row per date and one column
 * per ticker is what makes the file small enough to replace 231 requests, and what lets a
 * client read a date straight into a ticker-to-close lookup.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CLOSES_DIRECTORY, closesPath, writeCloses } from "../src/lib/closes.js";
import { COLUMNS } from "../src/lib/serialize.js";

const HEADER = COLUMNS.join(",");

/** One session file's bytes. `close` may be an empty string to mean "not published". */
function session(date: string, scrips: Record<string, string>): string {
  const rows = Object.entries(scrips).map(([symbol, close]) =>
    [date, symbol, close, close, close, close, "1000", "50000"].join(","),
  );
  return `${[HEADER, ...rows].join("\r\n")}\r\n`;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "nepse-closes-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function archive(date: string, scrips: Record<string, string>): void {
  const target = path.join(root, "data", "daily", date.slice(0, 4));
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, `${date}.csv`), session(date, scrips));
}

const read = (year: string) =>
  readFileSync(path.join(root, closesPath(year)), "utf8")
    .split("\r\n")
    .filter((line) => line !== "");

describe("writeCloses", () => {
  it("writes one row per date and one column per ticker", async () => {
    archive("2026-10-01", { NABIL: "566", ADBL: "308" });
    archive("2026-09-30", { NABIL: "570", ADBL: "307.5" });

    await writeCloses(root);

    expect(read("2026")).toEqual([
      "date,ADBL,NABIL",
      "2026-09-30,307.5,570",
      "2026-10-01,308,566",
    ]);
  });

  it("leaves an empty field for a scrip that did not trade that day", async () => {
    // Empty rather than zero, the same rule as everywhere else here: a zero close is a
    // claim that it traded at nothing, and a scrip that did not trade is not that.
    archive("2026-09-30", { NABIL: "570" });
    archive("2026-10-01", { NABIL: "566", ADBL: "308" });

    await writeCloses(root);

    expect(read("2026")[1]).toBe("2026-09-30,,570");
  });

  it("leaves a halted scrip's cell empty on the day it published no close", async () => {
    archive("2026-09-30", { NABIL: "570", HALTED: "10" });
    archive("2026-10-01", { NABIL: "566", HALTED: "" });

    await writeCloses(root);

    expect(read("2026")).toEqual([
      "date,HALTED,NABIL",
      "2026-09-30,10,570",
      "2026-10-01,,566",
    ]);
  });

  it("gives no column to a scrip that published no close all year", async () => {
    // It contributes nothing to a mean of day-on-day ratios, which is what this file exists
    // to feed, and the site's arithmetic skips it for the same reason. A column of 230 empty
    // cells would be bytes spent saying nothing.
    archive("2026-10-01", { NABIL: "566", HALTED: "" });

    await writeCloses(root);

    expect(read("2026")).toEqual(["date,NABIL", "2026-10-01,566"]);
  });

  it("writes a file per year, each with its own columns", async () => {
    archive("2025-12-31", { NABIL: "500" });
    archive("2026-01-01", { NABIL: "510", NEWSCRIP: "100" });

    const outcome = await writeCloses(root);

    expect(outcome.written).toBe(2);
    expect(read("2025")).toEqual(["date,NABIL", "2025-12-31,500"]);
    // A scrip listed for the first time in 2026 is a column in 2026 and not a stray line in
    // 2025, which is what a single flat file would have produced.
    expect(read("2026")).toEqual(["date,NABIL,NEWSCRIP", "2026-01-01,510,100"]);
  });

  it("leaves files whose bytes have not changed alone", async () => {
    archive("2026-10-01", { NABIL: "566" });

    const first = await writeCloses(root);
    const second = await writeCloses(root);

    expect(first.written).toBe(1);
    expect(second.written).toBe(0);
    expect(second.unchanged).toBe(1);
  });

  it("rewrites only the year a new session belongs to", async () => {
    archive("2025-12-31", { NABIL: "500" });
    archive("2026-10-01", { NABIL: "566" });
    await writeCloses(root);

    archive("2026-10-02", { NABIL: "570" });
    const outcome = await writeCloses(root);

    expect(outcome.written).toBe(1);
    expect(outcome.unchanged).toBe(1);
    expect(read("2026")).toHaveLength(3);
    expect(read("2025")).toHaveLength(2);
  });

  it("writes nothing at all on a dry run", async () => {
    archive("2026-10-01", { NABIL: "566" });

    const outcome = await writeCloses(root, { dryRun: true });

    expect(outcome.written).toBe(1);
    expect(existsSync(path.join(root, CLOSES_DIRECTORY))).toBe(false);
  });

  it("counts the sessions it saw, across every year", async () => {
    archive("2025-12-31", { NABIL: "500" });
    archive("2026-10-01", { NABIL: "566" });
    archive("2026-10-02", { NABIL: "570" });

    expect((await writeCloses(root)).dates).toBe(3);
  });

  it("does nothing, successfully, when there is no archive yet", async () => {
    await expect(writeCloses(root)).resolves.toEqual({ written: 0, unchanged: 0, dates: 0 });
  });

  it("refuses a damaged row instead of writing a wrong index", async () => {
    mkdirSync(path.join(root, "data", "daily", "2026"), { recursive: true });
    writeFileSync(
      path.join(root, "data", "daily", "2026", "2026-10-01.csv"),
      `${HEADER}\r\n2026-10-01,NABIL,1,2,3,4,5\r\n`,
    );

    await expect(writeCloses(root)).rejects.toThrow(/has 7 columns, expected 8/);
    expect(existsSync(path.join(root, CLOSES_DIRECTORY))).toBe(false);
  });
});

describe("the real archive", () => {
  const archiveRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

  it("has closes that match what a rebuild would produce", async () => {
    // Derived, so a committed file that cannot be rebuilt means it is stale or hand-edited.
    // Nothing is written: a dry run over the real archive must find every year current.
    const outcome = await writeCloses(archiveRoot, { dryRun: true });

    expect(outcome.written, `${outcome.written} closes files are out of date`).toBe(0);
    expect(outcome.unchanged).toBeGreaterThan(10);
    expect(outcome.dates).toBeGreaterThan(3_000);
  });

  it("covers every year the archive holds sessions for", async () => {
    const manifest = JSON.parse(
      readFileSync(path.join(archiveRoot, "data", "latest.json"), "utf8"),
    ) as { years: Record<string, number> };

    for (const year of Object.keys(manifest.years)) {
      expect(
        existsSync(path.join(archiveRoot, closesPath(year))),
        `no closes file for ${year}`,
      ).toBe(true);
    }
  });
});
