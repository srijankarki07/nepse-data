/**
 * Parsing a session off ShareSansar.
 *
 * The happy-path tests run against a **real captured page**, gzipped into
 * `tests/fixtures/`. That matters more than it looks: a hand-written fixture tests the
 * parser against the author's idea of the markup, which is exactly the thing that is
 * wrong when a scraper silently stops finding rows. A real capture fails loudly the
 * day the source changes shape.
 *
 * The failure tests are synthesised, because the ways a page can be broken are not
 * things a live capture will show on demand.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { extractTableById, textOf } from "../src/lib/html.js";
import {
  MIN_PLAUSIBLE_ROWS,
  parseAsOfDate,
  parseNumber,
  parseTodaySharePrice,
} from "../src/sources/sharesansar.js";

const FIXTURE = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "fixtures/today-share-price.html.gz",
);

const realPage = gunzipSync(readFileSync(FIXTURE)).toString("utf8");

/** A minimal page carrying a table with the given header and rows. */
function page(options: {
  header: string;
  rows: string[];
  date?: string | null;
  tableId?: string | null;
}): string {
  const heading =
    options.date === null
      ? "<h5>Today's prices</h5>"
      : `<h5>As of : <span class="text-org">${options.date ?? "2026-09-30"}</span> </h5>`;

  const table =
    options.tableId === null
      ? `<table><thead><tr>${options.header}</tr></thead></table>`
      : `<table id="${options.tableId ?? "headFixed"}"><thead><tr>${options.header}</tr></thead>` +
        `<tbody>${options.rows.join("")}</tbody></table>`;

  return `<html><body><div id="todayshareprice_data">${heading}${table}</div></body></html>`;
}

const HEADER =
  "<th>Symbol</th><th>Open</th><th>High</th><th>Low</th><th>Close</th><th>Vol</th><th>Turnover</th>";

function row(
  symbol: string,
  open: string,
  high: string,
  low: string,
  close: string,
  vol: string,
  turnover: string,
): string {
  return `<tr><td>${symbol}</td><td>${open}</td><td>${high}</td><td>${low}</td><td>${close}</td><td>${vol}</td><td>${turnover}</td></tr>`;
}

describe("parseNumber", () => {
  it("reads a plain number", () => {
    expect(parseNumber("870.00")).toBe(870);
  });

  it("strips the thousands separators the source uses", () => {
    // Every turnover figure on the page is thousands-separated, so `Number(raw)` would
    // give NaN and the column would silently empty out.
    expect(parseNumber("25,731,624.70")).toBe(25_731_624.7);
  });

  it("treats an absent value as null rather than zero", () => {
    // A halted scrip has no high price. Zero would be a claim it traded at nothing.
    expect(parseNumber("-")).toBeNull();
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("  ")).toBeNull();
    expect(parseNumber("–")).toBeNull();
  });

  it("does not invent a number from junk", () => {
    expect(parseNumber("N/A")).toBeNull();
  });
});

describe("parseAsOfDate", () => {
  it("reads the session from the heading", () => {
    expect(parseAsOfDate('<h5>As of : <span class="text-org">2026-09-30</span></h5>')).toBe(
      "2026-09-30",
    );
  });

  it("returns null rather than falling back to the clock", () => {
    // The whole point. NEPSE trades Sunday to Thursday and closes for holidays, so a run
    // on a non-trading day sees the previous session. Stamping today's date onto it
    // would file a day that never traded, and nothing downstream could tell.
    expect(parseAsOfDate("<h5>Today's share price</h5>")).toBeNull();
    expect(parseAsOfDate("")).toBeNull();
  });
});

describe("parseTodaySharePrice: the real page", () => {
  const snapshot = parseTodaySharePrice(realPage);

  it("reports the session the page is showing", () => {
    expect(snapshot.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("finds the whole market", () => {
    expect(snapshot.rows.length).toBeGreaterThan(MIN_PLAUSIBLE_ROWS);
  });

  it("reads a known scrip's figures", () => {
    const nabil = snapshot.rows.find((entry) => entry.symbol === "NABIL");

    expect(nabil).toBeDefined();
    expect(nabil?.close).toBeGreaterThan(0);
    expect(nabil?.high).toBeGreaterThanOrEqual(nabil?.low ?? 0);
    expect(nabil?.volume).toBeGreaterThan(0);
  });

  it("sorts by symbol, so a file is byte-stable", () => {
    const symbols = snapshot.rows.map((entry) => entry.symbol);
    expect(symbols).toEqual([...symbols].sort());
  });

  it("has no duplicate scrips", () => {
    const symbols = snapshot.rows.map((entry) => entry.symbol);
    expect(new Set(symbols).size).toBe(symbols.length);
  });

  it("never yields NaN, which is what a missed separator would produce", () => {
    for (const entry of snapshot.rows) {
      for (const value of [entry.open, entry.high, entry.low, entry.close, entry.volume, entry.turnover]) {
        expect(value === null || Number.isFinite(value)).toBe(true);
      }
    }
  });
});

describe("parseTodaySharePrice: refusing to guess", () => {
  const enough = Array.from({ length: MIN_PLAUSIBLE_ROWS + 1 }, (_, i) =>
    row(`S${String(i).padStart(3, "0")}`, "100", "110", "90", "105", "1,000", "105,000.00"),
  );

  it("refuses a page with no session date", () => {
    expect(() => parseTodaySharePrice(page({ header: HEADER, rows: enough, date: null }))).toThrow(
      /As of/,
    );
  });

  it("refuses a page whose table has moved", () => {
    expect(() =>
      parseTodaySharePrice(page({ header: HEADER, rows: enough, tableId: null })),
    ).toThrow(/headFixed/);
  });

  it("refuses a partially rendered table rather than overwriting a good file", () => {
    expect(() =>
      parseTodaySharePrice(
        page({ header: HEADER, rows: [row("NABIL", "1", "2", "1", "2", "1", "2")] }),
      ),
    ).toThrow(/partial response/);
  });

  it("refuses a table whose columns changed, and names them", () => {
    const renamed = page({
      header: "<th>Scrip</th><th>Open</th><th>High</th><th>Low</th><th>Close</th><th>Vol</th><th>Turnover</th>",
      rows: enough,
    });

    expect(() => parseTodaySharePrice(renamed)).toThrow(/Symbol/);
  });

  it("refuses a duplicated scrip rather than silently keeping one", () => {
    const duplicated = page({
      header: HEADER,
      rows: [...enough, row("NABIL", "1", "2", "1", "2", "1", "2"), row("NABIL", "3", "4", "3", "4", "3", "4")],
    });

    expect(() => parseTodaySharePrice(duplicated)).toThrow(/appears twice/);
  });

  it("does not confuse Close with Close - LTP or Prev. Close", () => {
    // The source has all three. Matching headers by prefix would store one of the other
    // two in the close column, which looks entirely plausible in the file.
    const withDecoys = page({
      header:
        "<th>Symbol</th><th>Open</th><th>High</th><th>Low</th><th>Close</th><th>Close - LTP</th><th>Prev. Close</th><th>Vol</th><th>Turnover</th>",
      rows: enough.map(() =>
        "<tr><td>NABIL</td><td>1</td><td>1</td><td>1</td><td>999</td><td>111</td><td>222</td><td>1</td><td>1</td></tr>".replace(
          "<td>NABIL</td>",
          `<td>X${Math.random().toString(36).slice(2, 8)}</td>`,
        ),
      ),
    });

    const parsed = parseTodaySharePrice(withDecoys);
    expect(parsed.rows.every((entry) => entry.close === 999)).toBe(true);
  });
});

describe("extractTableById", () => {
  it("returns null when the table is absent, distinct from empty", () => {
    // "The table is gone" and "the table is empty" are different failures, and a caller
    // seeing [] might reasonably conclude the market traded nothing.
    expect(extractTableById("<table id='other'></table>", "headFixed")).toBeNull();
  });

  it("reads cells from a well-formed table", () => {
    const table = extractTableById(
      "<table id='headFixed'><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>",
      "headFixed",
    );

    expect(table).toEqual([
      ["A", "B"],
      ["1", "2"],
    ]);
  });

  it("finds the right closing tag when tables are nested", () => {
    const html =
      "<table id='headFixed'><tr><td>outer</td></tr>" +
      "<tr><td><table><tr><td>inner</td></tr></table></td></tr></table>" +
      "<table id='after'><tr><td>nope</td></tr></table>";

    const table = extractTableById(html, "headFixed");
    expect(table?.flat().join(" ")).toContain("outer");
    expect(table?.flat().join(" ")).not.toContain("nope");
  });
});

describe("textOf", () => {
  it("drops style rules rather than reading them as data", () => {
    // The source embeds a <style> block inside the very container being parsed, so
    // stripping tags alone would leave CSS as cell text.
    expect(textOf("<style>.a { color: red; }</style><td>870.00</td>")).toBe("870.00");
  });

  it("decodes the entities a price table uses", () => {
    expect(textOf("<td>A &amp; B</td>")).toBe("A & B");
  });
});
