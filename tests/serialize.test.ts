/**
 * The archive's on-disk format.
 *
 * Kept separate from the parser's tests so a change to the file format fails here
 * rather than looking like a scraping problem. These are the properties a consumer
 * depends on, and the ones that would be expensive to change later because every
 * committed file already has them.
 */

import { describe, expect, it } from "vitest";

import { toCsv } from "../src/lib/csv.js";
import { COLUMNS, snapshotToCsv } from "../src/lib/serialize.js";
import type { DaySnapshot } from "../src/types.js";

function snapshot(overrides: Partial<DaySnapshot> = {}): DaySnapshot {
  return {
    date: "2026-09-30",
    rows: [
      { symbol: "AHPC", open: 500, high: 510, low: 495, close: 505, volume: 1000, turnover: 505_000 },
      { symbol: "NABIL", open: 566, high: 570, low: 563, close: 566, volume: 124_425, turnover: 70_423_999.2 },
    ],
    ...overrides,
  };
}

/** The lines of a rendered CSV, with the trailing terminator dropped. */
function lines(csv: string): string[] {
  return csv.replace(/\r\n$/, "").split("\r\n");
}

describe("the archive format", () => {
  it("leads with the header row a consumer parses against", () => {
    expect(lines(snapshotToCsv(snapshot()))[0]).toBe(COLUMNS.join(","));
  });

  it("repeats the date on every row", () => {
    // The redundancy is the point: it makes `cat data/daily/*/*.csv` a valid dataset
    // rather than a directory of files, so a consumer never recovers the date from a
    // path and the files are safe to concatenate in any order.
    const rows = lines(snapshotToCsv(snapshot())).slice(1);
    expect(rows).toHaveLength(2);
    expect(rows.every((line) => line.startsWith("2026-09-30,"))).toBe(true);
  });

  it("writes a missing value as an empty field, never a zero", () => {
    // A halted scrip has no high. Zero would be a claim it traded at nothing.
    const csv = snapshotToCsv(
      snapshot({
        rows: [
          { symbol: "HALT", open: null, high: null, low: null, close: null, volume: null, turnover: null },
        ],
      }),
    );

    // Eight columns, so seven separators — six empty fields after date and symbol.
    expect(lines(csv)[1]).toBe("2026-09-30,HALT,,,,,,");
  });

  it("keeps full precision on turnover", () => {
    // Turnover arrives with a decimal part; rounding it here would be lossy and
    // unrecoverable.
    const csv = snapshotToCsv(snapshot());
    expect(lines(csv)[2]).toContain("70423999.2");
  });

  it("terminates every line with CRLF", () => {
    const csv = snapshotToCsv(snapshot());
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv.split("\r\n").filter((line) => line !== "")).toHaveLength(3);
  });

  it("is byte-identical for the same snapshot", () => {
    // What makes re-running the day a no-op rather than a fresh commit.
    expect(snapshotToCsv(snapshot())).toBe(snapshotToCsv(snapshot()));
  });
});

describe("toCsv escaping", () => {
  it("quotes a field containing a comma", () => {
    expect(toCsv(["a"], [["x,y"]])).toContain('"x,y"');
  });

  it("doubles a quote inside a quoted field", () => {
    expect(toCsv(["a"], [['he said "hi"']])).toContain('"he said ""hi"""');
  });

  it("quotes a field with leading or trailing whitespace", () => {
    expect(toCsv(["a"], [[" padded "]])).toContain('" padded "');
  });

  it("leaves an ordinary field alone", () => {
    expect(toCsv(["a", "b"], [["1", "2"]])).toBe("a,b\r\n1,2\r\n");
  });
});
