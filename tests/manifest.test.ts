/**
 * The index consumers read first.
 *
 * These run against a temporary directory rather than the real archive, so they describe
 * the rules rather than the current contents — a test that asserted "latest is
 * 2026-09-30" would start failing the day the market next opened.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MANIFEST_PATH,
  SESSIONS_PATH,
  buildManifest,
  writeManifest,
  writeSessionsIndex,
} from "../src/lib/manifest.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "nepse-manifest-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Puts a session file where the archive would hold it. Contents are never read. */
function session(date: string): void {
  const directory = path.join(root, "data", "daily", date.slice(0, 4));
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, `${date}.csv`), "date,symbol\r\n");
}

describe("buildManifest", () => {
  it("reports an empty archive rather than failing", () => {
    expect(buildManifest(root)).resolves.toEqual({
      latest: null,
      previous: null,
      sessions: 0,
      years: {},
    });
  });

  it("names the two most recent sessions and counts the rest", async () => {
    for (const date of ["2024-06-10", "2024-06-11", "2024-06-12", "2024-06-13"]) {
      session(date);
    }

    const manifest = await buildManifest(root);

    expect(manifest.latest).toBe("2024-06-13");
    expect(manifest.previous).toBe("2024-06-12");
    expect(manifest.sessions).toBe(4);
    expect(manifest.years).toEqual({ "2024": 4 });
  });

  it("finds the previous session by looking, not by subtracting a day", async () => {
    // The market is shut two days in seven and for holidays, so "yesterday" is usually
    // not the previous session. A manifest that guessed would send a consumer to a file
    // that does not exist and report a day change against nothing.
    session("2024-06-09");
    session("2024-06-13");

    const manifest = await buildManifest(root);

    expect(manifest.latest).toBe("2024-06-13");
    expect(manifest.previous).toBe("2024-06-09");
  });

  it("counts sessions per year, with the years sorted", async () => {
    session("2011-06-10");
    session("2011-06-13");
    session("2026-09-30");

    const manifest = await buildManifest(root);

    expect(manifest.years).toEqual({ "2011": 2, "2026": 1 });
    expect(Object.keys(manifest.years)).toEqual(["2011", "2026"]);
  });

  it("ignores a file whose name is not a session date", async () => {
    // A stray file would otherwise become `latest` and send every consumer to a URL that
    // does not exist — a 404 that looks like an outage rather than a typo.
    session("2024-06-13");
    writeFileSync(path.join(root, "data", "daily", "2024", "notes.csv"), "x\r\n");
    writeFileSync(path.join(root, "data", "daily", "2024", "2024-13-45.csv"), "x\r\n");

    const manifest = await buildManifest(root);

    expect(manifest.sessions).toBe(1);
    expect(manifest.latest).toBe("2024-06-13");
  });
});

describe("writeManifest", () => {
  it("writes the manifest where a consumer expects it", async () => {
    session("2026-09-30");

    await writeManifest(root);

    const written = JSON.parse(readFileSync(path.join(root, MANIFEST_PATH), "utf8"));
    expect(written.latest).toBe("2026-09-30");
  });

  it("is byte-identical when nothing changed", async () => {
    // The property the daily job depends on. If this file differed between two runs with
    // an unchanged archive, the job would commit every day — including every holiday —
    // and the "a non-trading day is a no-op" guarantee would be gone.
    session("2026-09-30");

    await writeManifest(root);
    const first = readFileSync(path.join(root, MANIFEST_PATH), "utf8");
    await writeManifest(root);
    const second = readFileSync(path.join(root, MANIFEST_PATH), "utf8");

    expect(second).toBe(first);
  });

  it("carries no timestamp, which would defeat the line above", async () => {
    session("2026-09-30");
    await writeManifest(root);

    const written = JSON.parse(readFileSync(path.join(root, MANIFEST_PATH), "utf8"));

    expect(Object.keys(written).sort()).toEqual(["latest", "previous", "sessions", "years"]);
  });

  it("ends with a newline, so it is a text file and its diff is a line diff", async () => {
    session("2026-09-30");
    await writeManifest(root);

    expect(readFileSync(path.join(root, MANIFEST_PATH), "utf8").endsWith("\n")).toBe(true);
  });
});

describe("writeSessionsIndex", () => {
  it("lists every session date, ascending", async () => {
    session("2026-09-30");
    session("2011-01-02");
    session("2026-09-29");

    await writeSessionsIndex(root);

    const written = JSON.parse(readFileSync(path.join(root, SESSIONS_PATH), "utf8"));
    expect(written).toEqual(["2011-01-02", "2026-09-29", "2026-09-30"]);
  });

  it("is a flat array, not an object wrapping one", async () => {
    // The dates are the content. A wrapper key would be bytes describing itself.
    session("2026-09-30");
    await writeSessionsIndex(root);

    expect(JSON.parse(readFileSync(path.join(root, SESSIONS_PATH), "utf8"))).toBeInstanceOf(Array);
  });

  it("puts one date per line, so a new session is a one-line diff", async () => {
    // The file is rewritten in full every run. Compact JSON would make every day's change
    // look like the whole file changed, which is the opposite of what a review needs.
    session("2026-09-29");
    session("2026-09-30");
    await writeSessionsIndex(root);

    const text = readFileSync(path.join(root, SESSIONS_PATH), "utf8");
    const lines = text.trim().split("\n");

    expect(lines).toHaveLength(4); // [, two dates, ]
    expect(lines[0]).toBe("[");
    expect(lines[1]).toBe('  "2026-09-29",');
    expect(lines[2]).toBe('  "2026-09-30"');
    expect(lines[3]).toBe("]");
  });

  it("is byte-identical when nothing changed", async () => {
    // The same property the manifest has, and for the same reason: the daily job compares
    // before committing, and a file that differed every run would defeat it.
    session("2026-09-30");

    await writeSessionsIndex(root);
    const first = readFileSync(path.join(root, SESSIONS_PATH), "utf8");
    await writeSessionsIndex(root);
    const second = readFileSync(path.join(root, SESSIONS_PATH), "utf8");

    expect(second).toBe(first);
  });

  it("writes an empty list for an empty archive rather than failing", async () => {
    await writeSessionsIndex(root);
    expect(JSON.parse(readFileSync(path.join(root, SESSIONS_PATH), "utf8"))).toEqual([]);
  });

  it("ignores a file whose name is not a session date", async () => {
    session("2026-09-30");
    writeFileSync(path.join(root, "data", "daily", "2026", "notes.csv"), "x\r\n");

    await writeSessionsIndex(root);

    expect(JSON.parse(readFileSync(path.join(root, SESSIONS_PATH), "utf8"))).toEqual(["2026-09-30"]);
  });
});
