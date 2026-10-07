/**
 * The per-symbol index: `data/series/`, rebuilt from `data/daily/`.
 *
 * These run against a temp directory holding hand-written sessions, so the cases that
 * matter can be provoked on demand — an escaped ticker, two tickers that want one file, a
 * row that does not fit the format. What the *real* archive produces is asserted at the
 * end, because the index is derived and the archive is the authority.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { COLUMNS } from "../src/lib/serialize.js";
import { SERIES_DIRECTORY, seriesName, seriesPath, writeSeries } from "../src/lib/series.js";

const HEADER = COLUMNS.join(",");

/** One session file's bytes, as `snapshotToCsv` would write them. */
function session(date: string, scrips: Record<string, number | string>): string {
  const rows = Object.entries(scrips).map(([symbol, close]) => {
    const value = typeof close === "number" ? String(close) : close;
    return [date, symbol, value, value, value, value, "1000", "50000"].join(",");
  });
  return `${[HEADER, ...rows].join("\r\n")}\r\n`;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "nepse-series-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Writes a session into the temp archive. */
function archive(date: string, scrips: Record<string, number | string>): void {
  const target = path.join(root, "data", "daily", date.slice(0, 4));
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, `${date}.csv`), session(date, scrips));
}

const readSeries = (name: string) =>
  readFileSync(path.join(root, SERIES_DIRECTORY, `${name}.csv`), "utf8");

const lines = (name: string) => readSeries(name).split("\r\n").filter((line) => line !== "");

describe("seriesName", () => {
  it("leaves a plain ticker alone", () => {
    expect(seriesName("NABIL")).toBe("NABIL");
    expect(seriesName("ADBLB86")).toBe("ADBLB86");
  });

  it("names a debenture after the period it covers, without a directory", () => {
    // The reason this function exists: fourteen tickers carry a slash, and a slash in a
    // file name is a directory separator.
    expect(seriesName("GBILD86/87")).toBe("GBILD86-87");
    expect(seriesName("NIFRAUR85/")).toBe("NIFRAUR85");
  });

  it("names the artefacts the source has published", () => {
    expect(seriesName("N/A")).toBe("N-A");
    expect(seriesName("NICAD 85/8")).toBe("NICAD-85-8");
  });

  it("refuses a ticker with nothing nameable in it", () => {
    expect(() => seriesName("///")).toThrow(/no characters a file name can be made from/);
  });

  it("never returns something that could leave its directory", () => {
    // A ticker arrives from a scraped page, so this has to hold for anything at all. The
    // rule is that the result is always a single path segment made of `A-Z0-9-`.
    expect(seriesName("../NABIL")).toBe("NABIL");
    expect(seriesName("A/B/C")).toBe("A-B-C");
    expect(seriesName("./x")).toBe("X");
    // Lower case is named, not refused, and not a second file for one ticker.
    expect(seriesName("nabil")).toBe("NABIL");
    expect(() => seriesName(".. ")).toThrow(/no characters/);

    for (const hostile of ["../NABIL", "A/B/C", "a b", "a.b", "N/A"]) {
      expect(seriesName(hostile), hostile).toMatch(/^[A-Z0-9-]+$/);
    }
  });

  it("is what seriesPath builds a path from", () => {
    expect(seriesPath("GBILD86/87")).toBe(path.join("data", "series", "GBILD86-87.csv"));
  });
});

describe("writeSeries", () => {
  it("groups one scrip's rows across sessions, oldest first", async () => {
    archive("2026-09-30", { NABIL: 570, ADBL: 307.5 });
    archive("2026-10-01", { NABIL: 566, ADBL: 308 });
    archive("2026-09-29", { NABIL: 560 });

    await writeSeries(root);

    // Written out of order on purpose: the sessions must be read in date order, not in the
    // order the filesystem happens to hand them over.
    expect(lines("NABIL").map((line) => line.split(",")[0])).toEqual([
      "date",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
    ]);
    // A session the scrip did not trade in contributes nothing, not a blank row.
    expect(lines("ADBL")).toHaveLength(3);
  });

  it("writes the archive's own columns, header included", async () => {
    archive("2026-10-01", { NABIL: 566 });
    await writeSeries(root);

    expect(lines("NABIL")[0]).toBe(HEADER);
  });

  it("keeps an escaped ticker's own spelling inside the file", async () => {
    // The file name is escaped; the data is not. A consumer reading the file still sees
    // the ticker the exchange uses, and the client's parser refuses a file whose rows
    // name a different scrip than the one asked for.
    archive("2026-10-01", { "GBILD86/87": 1090 });
    await writeSeries(root);

    expect(lines("GBILD86-87")[1]).toContain("GBILD86/87");
  });

  it("leaves files whose bytes have not changed completely alone", async () => {
    archive("2026-10-01", { NABIL: 566 });

    const first = await writeSeries(root);
    const second = await writeSeries(root);

    expect(first.written).toBe(1);
    expect(second.written).toBe(0);
    expect(second.unchanged).toBe(1);
  });

  it("picks up a later session without disturbing the rest", async () => {
    archive("2026-09-30", { NABIL: 570, ADBL: 307.5 });
    await writeSeries(root);

    archive("2026-10-01", { NABIL: 566 });
    const outcome = await writeSeries(root);

    // Only the scrip that traded; ADBL's file is already correct.
    expect(outcome.written).toBe(1);
    expect(outcome.unchanged).toBe(1);
    expect(lines("NABIL")).toHaveLength(3);
  });

  it("writes nothing at all on a dry run", async () => {
    archive("2026-10-01", { NABIL: 566 });

    const outcome = await writeSeries(root, { dryRun: true });

    expect(outcome.written).toBe(1);
    expect(existsSync(path.join(root, SERIES_DIRECTORY))).toBe(false);
  });

  it("reports what it wrote, so the log can be checked", async () => {
    archive("2026-10-01", { NABIL: 566, ADBL: 308 });

    const outcome = await writeSeries(root);

    expect(outcome.symbols).toBe(2);
    expect(outcome.rows).toBe(2);
    expect(outcome.escaped).toEqual([]);
  });

  it("names the escaped tickers rather than escaping them silently", async () => {
    archive("2026-10-01", { NABIL: 566, "GBILD86/87": 1090 });

    expect((await writeSeries(root)).escaped).toEqual(["GBILD86-87"]);
  });

  it("does nothing, successfully, when there is no archive yet", async () => {
    await expect(writeSeries(root)).resolves.toBeDefined();
    expect((await writeSeries(root)).symbols).toBe(0);
  });
});

describe("writeSeries refuses to build an index it cannot trust", () => {
  it("refuses two tickers that want the same file", async () => {
    // Under the escaping rule these collide. Nothing in today's archive does, but two
    // companies sharing one history is not a thing a reader could ever notice.
    archive("2026-10-01", { "GBILD86/87": 1090, "GBILD86-87": 1091 });

    await expect(writeSeries(root)).rejects.toThrow(/both want the file/);
  });

  it("refuses a row that is not eight columns", async () => {
    // The archive's files were written by this repository, so a short row means the
    // archive is damaged — and an index that skipped it would hide that.
    mkdirSync(path.join(root, "data", "daily", "2026"), { recursive: true });
    writeFileSync(
      path.join(root, "data", "daily", "2026", "2026-10-01.csv"),
      `${HEADER}\r\n2026-10-01,NABIL,1,2,3,4,5\r\n`,
    );

    await expect(writeSeries(root)).rejects.toThrow(/has 7 columns, expected 8/);
  });

  it("refuses a row dated for another day", async () => {
    mkdirSync(path.join(root, "data", "daily", "2026"), { recursive: true });
    writeFileSync(
      path.join(root, "data", "daily", "2026", "2026-10-01.csv"),
      `${HEADER}\r\n2026-09-30,NABIL,1,2,3,4,5,6\r\n`,
    );

    await expect(writeSeries(root)).rejects.toThrow(/is dated "2026-09-30"/);
  });

  it("writes no files when it refuses", async () => {
    archive("2026-10-01", { "GBILD86/87": 1090, "GBILD86-87": 1091 });

    await expect(writeSeries(root)).rejects.toThrow();
    expect(readdirSync(path.join(root, "data", "daily", "2026"))).toHaveLength(1);
    expect(existsSync(path.join(root, SERIES_DIRECTORY))).toBe(false);
  });
});

describe("the real archive", () => {
  const archiveRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

  it("has an index that matches what a rebuild would produce", async () => {
    // The invariant that matters: `data/series/` is derived, so if it can be rebuilt to
    // different bytes then the committed files are stale or hand-edited. Nothing is
    // written here — a dry run over the real archive must find every file already current.
    const outcome = await writeSeries(archiveRoot, { dryRun: true });

    expect(outcome.symbols).toBeGreaterThan(700);
    expect(outcome.rows).toBeGreaterThan(400_000);
    expect(outcome.written, `${outcome.written} series files are out of date`).toBe(0);
  });

  it("covers every ticker the sessions hold", async () => {
    const published = new Set(readdirSync(path.join(archiveRoot, SERIES_DIRECTORY)));
    expect(published.size).toBe((await writeSeries(archiveRoot, { dryRun: true })).symbols);
  });
});
