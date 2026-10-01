/**
 * Invariants that hold across the whole archive, rather than within one session.
 *
 * Every other test in this directory checks one file at a time, or one response. These
 * check the *set* — the properties that only break when two sessions are wrong together,
 * which is exactly the class of bug that got past everything else: a resumed sweep wrote
 * `2011-06-20.csv` containing `2011-06-19`'s prices, and no per-session test could have
 * noticed, because each file on its own was perfectly well formed.
 *
 * They run against `data/`, so they also fail if a hand-edit or a bad merge corrupts the
 * archive later. On a fresh clone with no data yet they pass trivially, which is correct:
 * an empty archive has no invariants to violate.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { COLUMNS, sessionFingerprint } from "../src/lib/serialize.js";

const DAILY = path.join(
  path.resolve(fileURLToPath(new URL("..", import.meta.url))),
  "data",
  "daily",
);

/** Every `data/daily/<year>/<date>.csv`, walked by hand so no dependency is needed. */
function archivedSessions(): Array<{ date: string; file: string; csv: string }> {
  let years: string[];
  try {
    years = readdirSync(DAILY);
  } catch {
    return [];
  }

  const sessions: Array<{ date: string; file: string; csv: string }> = [];

  for (const year of years) {
    const directory = path.join(DAILY, year);
    if (!statSync(directory).isDirectory()) continue;

    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".csv")) continue;

      const file = path.join(directory, name);
      sessions.push({ date: name.replace(/\.csv$/, ""), file, csv: readFileSync(file, "utf8") });
    }
  }

  return sessions.sort((a, b) => (a.date < b.date ? -1 : 1));
}

const sessions = archivedSessions();

describe("the archive as a set", () => {
  it("has files to check", () => {
    // Guards against the whole suite silently passing because the walk found nothing —
    // a broken path would otherwise look identical to a healthy archive.
    expect(sessions.length).toBeGreaterThan(0);
  });

  it("holds no two sessions with identical prices", () => {
    // The invariant the duplicate guard exists to protect, checked across everything
    // rather than only what one run happened to see. Two dates cannot legitimately carry
    // the same figures for a whole market; when they do, one of them was filed wrongly.
    const byFingerprint = new Map<string, string[]>();

    for (const { date, csv } of sessions) {
      const key = sessionFingerprint(csv);
      byFingerprint.set(key, [...(byFingerprint.get(key) ?? []), date]);
    }

    const duplicated = [...byFingerprint.values()].filter((dates) => dates.length > 1);

    expect(duplicated).toEqual([]);
  });

  it("names every row with the date in its filename", () => {
    // The date is repeated on each row so the files can be concatenated without reading
    // paths. That redundancy is only worth having if it is true.
    const wrong = sessions.filter(({ date, csv }) =>
      csv
        .split("\r\n")
        .slice(1)
        .filter((line) => line !== "")
        .some((line) => !line.startsWith(`${date},`)),
    );

    expect(wrong.map((entry) => entry.file)).toEqual([]);
  });

  it("starts every file with the documented header", () => {
    const wrong = sessions.filter(
      ({ csv }) => csv.split("\r\n")[0] !== COLUMNS.join(","),
    );

    expect(wrong.map((entry) => entry.file)).toEqual([]);
  });

  it("terminates every line with CRLF, including the last", () => {
    // `.gitattributes` marks the data as `-text` so git does not rewrite these. If that
    // ever stops holding, every file changes on every checkout and the daily job's
    // "nothing to commit" check stops working — so it is worth asserting, not assuming.
    const wrong = sessions.filter(({ csv }) => !csv.endsWith("\r\n") || /[^\r]\n/.test(csv));

    expect(wrong.map((entry) => entry.file)).toEqual([]);
  });

  it("files each session under its own year", () => {
    const wrong = sessions.filter(({ date, file }) => path.basename(path.dirname(file)) !== date.slice(0, 4));

    expect(wrong.map((entry) => entry.file)).toEqual([]);
  });
});
