/**
 * The index artifact: `data/indices/`.
 *
 * Two things are being tested and they are not the numbers. The first is that this is the
 * one index that **accumulates** rather than being rebuilt, so the rules that keep a
 * published history append-only are the whole subject. The second is that `latest.json`
 * reports what was recorded rather than what the page is showing now, which is the
 * difference between a consumer's levels agreeing with the history and quietly not.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { INDICES_DIRECTORY, INDICES_LATEST_PATH, indexPath, writeIndices } from "../src/lib/indices.js";
import type { IndexLevel } from "../src/sources/sharesansar-index.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "nepse-indices-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** One index's level, with everything a caller does not care about held constant. */
function level(key: string, close: number): IndexLevel {
  return {
    key,
    name: `${key} index`,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    change: 1.5,
    percentChange: 0.25,
    turnover: 1234.5,
  };
}

/** One page's worth of levels, with each index given a distinct close. */
function session(date: string, keys: string[]): { date: string; indices: IndexLevel[] } {
  return { date, indices: keys.map((key, index) => level(key, 100 + index)) };
}

const read = (key: string): string[] =>
  readFileSync(path.join(root, indexPath(key)), "utf8")
    .split("\r\n")
    .filter((line) => line !== "");

const latest = (): unknown => JSON.parse(readFileSync(path.join(root, INDICES_LATEST_PATH), "utf8"));

describe("writeIndices", () => {
  it("writes one file per index, each with its header and its row", async () => {
    await writeIndices(root, session("2026-10-07", ["nepse", "banking"]));

    expect(read("nepse")).toEqual([
      "date,open,high,low,close,change,percentChange,turnover",
      "2026-10-07,99,101,98,100,1.5,0.25,1234.5",
    ]);
    expect(read("banking")).toHaveLength(2);
  });

  it("appends a new session beneath the one before it", async () => {
    await writeIndices(root, session("2026-10-06", ["nepse"]));
    const outcome = await writeIndices(root, session("2026-10-07", ["nepse"]));

    expect(outcome.appended).toEqual(["nepse"]);
    expect(outcome.written).toBe(1);
    expect(read("nepse")).toHaveLength(3);
    expect(read("nepse")[1]).toMatch(/^2026-10-06,/);
    expect(read("nepse")[2]).toMatch(/^2026-10-07,/);
  });

  it("writes nothing when the session is already recorded", async () => {
    // This is what makes a re-run, a retried workflow and a holiday all free.
    await writeIndices(root, session("2026-10-07", ["nepse", "banking"]));
    const before = read("nepse");

    const outcome = await writeIndices(root, session("2026-10-07", ["nepse", "banking"]));

    expect(outcome.appended).toEqual([]);
    expect(outcome.written).toBe(0);
    expect(outcome.unchanged).toBe(2);
    expect(read("nepse")).toEqual(before);
  });

  it("does not rewrite history when the page serves an older session", async () => {
    await writeIndices(root, session("2026-10-07", ["nepse"]));

    const outcome = await writeIndices(root, session("2026-10-06", ["nepse"]));

    expect(outcome.appended).toEqual([]);
    expect(read("nepse")[1]).toMatch(/^2026-10-07,/);
  });

  it("keeps the recorded figures when the page restates a session", async () => {
    // A correction the source makes to a past session is not picked up: what was published
    // stays published, the same rule the daily archive follows. The consequence is that
    // latest.json must report the recorded close, not the page's, or the level a consumer
    // reads there would disagree with the history it names.
    await writeIndices(root, { date: "2026-10-07", indices: [level("nepse", 100)] });
    await writeIndices(root, { date: "2026-10-07", indices: [level("nepse", 999)] });

    const published = latest() as { indices: Record<string, { close: number }> };

    expect(read("nepse")[1]).toContain(",100,");
    expect(published.indices.nepse?.close).toBe(100);
  });

  it("names the session its figures are from, even when the page is behind the file", async () => {
    // A page serving an older session appends nothing, so every entry comes off disk. The
    // date has to come off disk with them, or latest.json would label this week's levels
    // with last week's session.
    await writeIndices(root, session("2026-10-07", ["nepse"]));
    await writeIndices(root, session("2026-10-06", ["nepse"]));

    expect((latest() as { date: string }).date).toBe("2026-10-07");
  });

  it("dates each entry from the row it actually holds", async () => {
    // The entries can disagree, and only in the mixed case: `banking` is ahead of the page
    // while `nepse` is behind it. One date for the whole file would then label `nepse`'s
    // figures with `banking`'s session.
    await writeIndices(root, session("2026-10-08", ["banking"]));
    await writeIndices(root, session("2026-10-06", ["nepse"]));

    await writeIndices(root, session("2026-10-07", ["nepse", "banking"]));

    const published = latest() as {
      date: string;
      indices: Record<string, { date: string }>;
    };

    expect(published.date).toBe("2026-10-08");
    expect(published.indices.nepse?.date).toBe("2026-10-07");
    expect(published.indices.banking?.date).toBe("2026-10-08");
  });

  it("lists the page's indices and no others", async () => {
    // A retired index stops appearing here while its file keeps the history. That is the
    // honest answer rather than a fault: a retired level is not a stale one, and carrying
    // its last value forward would present it as current.
    await writeIndices(root, session("2026-10-06", ["nepse", "banking"]));
    await writeIndices(root, session("2026-10-07", ["nepse"]));

    const published = latest() as { indices: Record<string, unknown> };

    expect(Object.keys(published.indices)).toEqual(["nepse"]);
    expect(read("banking")).toHaveLength(2);
  });

  it("writes latest.json byte-identically on an unchanged run", async () => {
    // The file is rewritten on every run, so a timestamp or an unstable key order would make
    // it differ every day and the daily job would commit on days the market never opened.
    await writeIndices(root, session("2026-10-07", ["nepse", "banking"]));
    const first = readFileSync(path.join(root, INDICES_LATEST_PATH), "utf8");

    const outcome = await writeIndices(root, session("2026-10-07", ["nepse", "banking"]));

    expect(outcome.latestChanged).toBe(false);
    expect(readFileSync(path.join(root, INDICES_LATEST_PATH), "utf8")).toBe(first);
  });

  it("writes nothing at all on a dry run", async () => {
    const outcome = await writeIndices(root, session("2026-10-07", ["nepse"]), { dryRun: true });

    expect(outcome.written).toBe(1);
    expect(outcome.appended).toEqual(["nepse"]);
    expect(existsSync(path.join(root, INDICES_DIRECTORY))).toBe(false);
  });

  it("refuses a damaged file instead of appending to it", async () => {
    const target = path.join(root, indexPath("nepse"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "date,open,high,low,close\r\n2026-10-07,1,2,3,4\r\n");

    await expect(writeIndices(root, session("2026-10-08", ["nepse"]))).rejects.toThrow(
      /unexpected header/,
    );
  });

  it("writes nothing at all when any file is damaged", async () => {
    // The rule everywhere else in this repository is that nothing is written on a doubt, and
    // one loop that validated and wrote each file in turn broke it here: a damaged file found
    // halfway left the indices before it appended, the ones after it untouched, and
    // latest.json not rendered at all. The daily job runs this with `continue-on-error`, so
    // that half state would have been committed.
    await writeIndices(root, session("2026-10-06", ["aaa", "bbb", "ccc"]));
    const before = read("aaa");

    const target = path.join(root, indexPath("bbb"));
    writeFileSync(target, "date,open,high,low,close\r\n2026-10-07,1,2,3,4\r\n");

    await expect(writeIndices(root, session("2026-10-07", ["aaa", "bbb", "ccc"]))).rejects.toThrow(
      /unexpected header/,
    );

    expect(read("aaa")).toEqual(before);
    expect(existsSync(path.join(root, indexPath("ccc")))).toBe(true);
    expect(read("ccc")).toHaveLength(2);
    expect((latest() as { date: string }).date).toBe("2026-10-06");
  });

  it("treats an empty file as no file", async () => {
    // Appending to a 0-byte file would write a headerless one, which the next run would then
    // refuse as damaged, breaking this index until someone deleted it by hand.
    const target = path.join(root, indexPath("nepse"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "");

    await writeIndices(root, session("2026-10-07", ["nepse"]));

    expect(read("nepse")[0]).toBe("date,open,high,low,close,change,percentChange,turnover");
    expect(read("nepse")).toHaveLength(2);
  });

  it("refuses a file whose last row is not the width it claims", async () => {
    const target = path.join(root, indexPath("nepse"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(
      target,
      "date,open,high,low,close,change,percentChange,turnover\r\n2026-10-07,1,2,3,4\r\n",
    );

    await expect(writeIndices(root, session("2026-10-08", ["nepse"]))).rejects.toThrow(
      /5 columns, expected 8/,
    );
  });

  it("refuses a key that would not be a usable file name", () => {
    expect(() => indexPath("../escape")).toThrow(/not a usable index key/);
  });
});

describe("the real archive", () => {
  const archiveRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

  it("has index files that match what a rebuild would produce", async () => {
    // Accumulating rather than derived, so this cannot assert the files are rebuildable —
    // only that every session the page is showing is already recorded, which is what a
    // second run of the daily job would find.
    const page = JSON.parse(readFileSync(path.join(archiveRoot, INDICES_LATEST_PATH), "utf8")) as {
      date: string;
      indices: Record<string, { name: string; close: number | null }>;
    };

    for (const key of Object.keys(page.indices)) {
      const rows = readFileSync(path.join(archiveRoot, indexPath(key)), "utf8")
        .split(/\r?\n/)
        .filter((line) => line !== "");

      expect(rows.at(-1), `${key} does not end at the published session`).toMatch(
        new RegExp(`^${page.date},`),
      );
    }

    expect(Object.keys(page.indices).length).toBeGreaterThan(10);
  });
});
