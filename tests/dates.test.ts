/**
 * Calendar days, and the Kathmandu boundary.
 *
 * The timezone tests are the ones that matter. Everything else here is arithmetic that
 * would fail loudly on first use; the rollover would fail *silently*, by filing a
 * partial session under a date the exchange had not finished trading.
 */

import { describe, expect, it } from "vitest";

import { eachDay, isRealDay, kathmanduToday } from "../src/lib/dates.js";

describe("isRealDay", () => {
  it("accepts a plain date", () => {
    expect(isRealDay("2024-06-13")).toBe(true);
  });

  it("rejects a day that does not exist in that month", () => {
    // The pattern alone admits this, which is why the round-trip through Date exists.
    expect(isRealDay("2021-02-30")).toBe(false);
    expect(isRealDay("2021-04-31")).toBe(false);
  });

  it("rejects an impossible month", () => {
    expect(isRealDay("2021-13-01")).toBe(false);
    expect(isRealDay("2021-00-10")).toBe(false);
  });

  it("handles February in a leap year and outside one", () => {
    expect(isRealDay("2024-02-29")).toBe(true);
    expect(isRealDay("2023-02-29")).toBe(false);
  });

  it("rejects anything not shaped like a date", () => {
    expect(isRealDay("13/06/2024")).toBe(false);
    expect(isRealDay("2024-6-13")).toBe(false);
    expect(isRealDay("")).toBe(false);
    expect(isRealDay("today")).toBe(false);
  });
});

describe("eachDay", () => {
  it("is inclusive at both ends", () => {
    expect(eachDay("2024-06-10", "2024-06-13")).toEqual([
      "2024-06-10",
      "2024-06-11",
      "2024-06-12",
      "2024-06-13",
    ]);
  });

  it("returns the one day of a single-day range", () => {
    expect(eachDay("2024-06-13", "2024-06-13")).toEqual(["2024-06-13"]);
  });

  it("crosses a month boundary", () => {
    expect(eachDay("2024-06-30", "2024-07-02")).toEqual([
      "2024-06-30",
      "2024-07-01",
      "2024-07-02",
    ]);
  });

  it("crosses a year boundary", () => {
    expect(eachDay("2024-12-31", "2025-01-01")).toEqual(["2024-12-31", "2025-01-01"]);
  });

  it("includes the leap day rather than skipping it", () => {
    expect(eachDay("2024-02-28", "2024-03-01")).toEqual([
      "2024-02-28",
      "2024-02-29",
      "2024-03-01",
    ]);
  });

  it("refuses a range that ends before it starts", () => {
    expect(() => eachDay("2024-06-14", "2024-06-10")).toThrow(/before it starts/);
  });

  it("refuses a date that does not exist", () => {
    expect(() => eachDay("2021-02-30", "2021-03-01")).toThrow(/not a real/);
  });
});

describe("kathmanduToday", () => {
  it("has already rolled over just after 18:15 UTC", () => {
    // The bug this function exists to prevent: 18:20 UTC is 00:05 the next day in
    // Kathmandu, so a UTC-based "today" is a day behind every evening.
    expect(kathmanduToday(new Date("2026-09-30T18:20:00Z"))).toBe("2026-10-01");
  });

  it("has not yet rolled over just before 18:15 UTC", () => {
    expect(kathmanduToday(new Date("2026-09-30T18:00:00Z"))).toBe("2026-09-30");
  });

  it("matches the UTC date in the middle of the UTC day", () => {
    expect(kathmanduToday(new Date("2026-09-30T09:45:00Z"))).toBe("2026-09-30");
  });

  it("is ahead of UTC in the first hours of the UTC day", () => {
    // 00:30 UTC is already 06:15 in Kathmandu, but the same calendar day.
    expect(kathmanduToday(new Date("2026-09-30T00:30:00Z"))).toBe("2026-09-30");
    // 23:30 UTC is 05:15 the *next* day — the other direction of the same boundary.
    expect(kathmanduToday(new Date("2026-09-30T23:30:00Z"))).toBe("2026-10-01");
  });
});
