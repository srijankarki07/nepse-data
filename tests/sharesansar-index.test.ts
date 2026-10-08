/**
 * Reading the exchange's index levels off ShareSansar's market page.
 *
 * The happy path runs against a **real captured page**, gzipped into `tests/fixtures/`, for
 * the same reason the price parser's does: a hand-written fixture tests the parser against
 * the author's idea of the markup, which is exactly what is wrong when a scraper silently
 * stops finding rows.
 *
 * The failure cases are synthesised, because the ways a page can be broken are not things a
 * live capture will show on demand.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { MIN_INDEX_ROWS, parseMarketPage } from "../src/sources/sharesansar-index.js";

const FIXTURE = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "fixtures/market.html.gz",
);

const realPage = gunzipSync(readFileSync(FIXTURE)).toString("utf8");

const MAIN_HEADER = ["Index", "Open", "High", "Low", "Close", "Point Change", "% Change", "Turnover"];
const SUB_HEADER = ["Sub Index", "Open", "High", "Low", "Close", "Point", "% Change", "Turnover"];

/** The labels the real page carries, so a synthesised one passes the floor. */
const MAIN_LABELS = ["NEPSE Index", "Sensitive Index", "Float Index", "Sensitive Float Index"];
const SUB_LABELS = [
  "Banking SubIndex",
  "Development Bank Index",
  "Finance Index",
  "Hotels And Tourism",
  "HydroPower Index",
  "Investment",
  "Life Insurance",
  "Manufacturing And Processing",
  "Microfinance Index",
  "Mutual Fund",
  "Non Life Insurance",
  "Others Index",
  "Trading Index",
];

/** One row of a table, with a plausible value in every column. */
function row(label: string): string[] {
  return [label, "1", "2", "0.5", "1.5", "0.1", "0.2", "1,000"];
}

/** One `<h3>` and the table beneath it, as the market page writes them. */
function section(title: string, date: string | null, header: string[], rows: string[][]): string {
  const head = header.map((cell) => `<th>${cell}</th>`).join("");
  const body = rows.map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
  const asOf =
    date === null ? "<p>No date on this one</p>" : `<p>As of <span class="text-org">${date}</span></p>`;

  return (
    `<h3 class="heading-title">${title}</h3><div class="border-orange"></div>${asOf}` +
    `<div class="table-responsive"><table class="table table-bordered"><thead><tr>${head}</tr>` +
    `</thead><tbody>${body}</tbody></table></div>`
  );
}

/** A whole market page: the two index sections, and anything a test wants beside them. */
function marketPage(options: {
  date?: string | null;
  subDate?: string | null;
  main?: string[][];
  sub?: string[][];
  mainHeader?: string[];
  subHeader?: string[];
  before?: string;
  omitMain?: boolean;
  omitSub?: boolean;
} = {}): string {
  const main = options.main ?? MAIN_LABELS.map(row);
  const sub = options.sub ?? SUB_LABELS.map(row);

  return [
    options.before ?? "",
    options.omitMain === true
      ? ""
      : section("Indices", options.date === undefined ? "2026-10-07" : options.date, options.mainHeader ?? MAIN_HEADER, main),
    options.omitSub === true
      ? ""
      : section(
          "Sub Indices",
          options.subDate === undefined ? "2026-10-07" : options.subDate,
          options.subHeader ?? SUB_HEADER,
          sub,
        ),
  ].join("");
}

describe("parseMarketPage", () => {
  it("reads every level off the real page", () => {
    const page = parseMarketPage(realPage);

    expect(page.date).toBe("2026-10-07");
    expect(page.indices).toHaveLength(17);
  });

  it("reads the exchange's own figures", () => {
    const page = parseMarketPage(realPage);
    const nepse = page.indices.find((index) => index.key === "nepse");

    expect(nepse).toMatchObject({
      name: "NEPSE Index",
      open: 2579,
      high: 2579.1,
      low: 2565.22,
      close: 2572.34,
      change: -6.38,
      percentChange: -0.24,
      turnover: 3748080303.07,
    });
  });

  it("keys both tables into one set", () => {
    const keys = parseMarketPage(realPage).indices.map((index) => index.key).sort();

    expect(keys).toEqual([
      "banking",
      "development-bank",
      "finance",
      "float",
      "hotels-and-tourism",
      "hydropower",
      "investment",
      "life-insurance",
      "manufacturing-and-processing",
      "microfinance",
      "mutual-fund",
      "nepse",
      "non-life-insurance",
      "others",
      "sensitive",
      "sensitive-float",
      "trading",
    ]);
  });

  it("does not read the sibling table that reuses the index names", () => {
    // `Investment`, `Finance` and `Others` each appear twice on this page: once as an index
    // level, and once in the `Impacting Scripts` block, which lists tickers against sector
    // names. Only the first is a level. What separates them is the slice stopping at the
    // first `</table>`, since that block is a table of its own under its own heading.
    const page = parseMarketPage(realPage);
    const investment = page.indices.filter((index) => index.key === "investment");

    expect(investment).toHaveLength(1);
    expect(investment[0]?.close).toBeCloseTo(93.52);
    expect(page.indices.every((index) => typeof index.close === "number")).toBe(true);
  });

  it("refuses a row that does not span the header", () => {
    // Skipping such a row was the first shape of this and it was wrong: neither real table
    // has one, so all it could ever do was drop a mishaped index row in silence and report a
    // normal run. It is also what would catch a section that ran on into the next table.
    expect(() =>
      parseMarketPage(
        marketPage({ main: [...MAIN_LABELS.map(row), ["Total Turnover (Rs.)", "1,000"]] }),
      ),
    ).toThrow(/has a row of 2 cells where the header has 8/);
  });

  it("takes the date from each index section, not from the page", () => {
    // The real page stamps its foreign-exchange panel with today while the indices carry the
    // last session the exchange computed them for. A date read off the whole page would be
    // the wrong one, and a wrong date here means a session filed under a day it never traded.
    const page = parseMarketPage(
      marketPage({
        before: '<h3 class="heading-title">Foreign Exchange</h3><p>As of <span class="text-org">2026-10-08</span></p>',
      }),
    );

    expect(page.date).toBe("2026-10-07");
  });

  it("reads a heading that wraps part of itself in a span", () => {
    // The source writes `Sub <span class="text-org">Indices</span>`, so a matcher that
    // compared raw markup rather than text would not find the section at all.
    const page = parseMarketPage(realPage);

    expect(page.indices.some((index) => index.key === "banking")).toBe(true);
  });

  it("refuses a page with no index section", () => {
    expect(() => parseMarketPage(marketPage({ omitMain: true }))).toThrow(/no "Indices" section/);
  });

  it("refuses a section with no As of date", () => {
    expect(() => parseMarketPage(marketPage({ date: null }))).toThrow(/carries no "As of" date/);
  });

  it("refuses two tables that disagree about the session", () => {
    // A page caught halfway through an update would otherwise be filed as though both days
    // had been seen, under whichever of the two dates happened to be read first.
    expect(() => parseMarketPage(marketPage({ subDate: "2026-10-06" }))).toThrow(
      /disagree about the session/,
    );
  });

  it("refuses an index label it does not know", () => {
    // The failure this prevents is silent: a slug derived from the label would follow the
    // source through a rename and start a second file, leaving the old key's history to stop.
    expect(() =>
      parseMarketPage(marketPage({ main: [...MAIN_LABELS.map(row), row("Insurance Index")] })),
    ).toThrow(/does not know: "Insurance Index"/);
  });

  it("refuses a label that happens to name an Object property", () => {
    // `INDEX_KEYS["constructor"]` finds an inherited property rather than `undefined`, so a
    // bare lookup would pass the refusal below and fail much later, on the file name. The
    // guard is `Object.hasOwn`, and this is what holds it there.
    expect(() =>
      parseMarketPage(marketPage({ main: [...MAIN_LABELS.map(row), row("Constructor")] })),
    ).toThrow(/does not know: "Constructor"/);
  });

  it("refuses a table whose columns have moved", () => {
    expect(() =>
      parseMarketPage(marketPage({ mainHeader: ["Index", "Open", "High", "Low", "Close"] })),
    ).toThrow(/missing the column\(s\)/);
  });

  it("refuses a table listing one index twice", () => {
    expect(() =>
      parseMarketPage(marketPage({ main: [...MAIN_LABELS.map(row), row("NEPSE Index")] })),
    ).toThrow(/lists "NEPSE Index" twice/);
  });

  it("refuses a page too small to be the market's", () => {
    expect(() =>
      parseMarketPage(marketPage({ main: [row("Float Index")], sub: [row("Banking SubIndex")] })),
    ).toThrow(new RegExp(`fewer than the ${MIN_INDEX_ROWS} believed`));
  });

  it("tolerates a heading that only re-spells an index", () => {
    // `HydroPower` becoming `Hydropower` is a spelling change, not a different index, and
    // turning it into a red run would be a false alarm.
    const page = parseMarketPage(
      marketPage({
        sub: SUB_LABELS.map((label) =>
          row(label === "HydroPower Index" ? "Hydropower Index" : label),
        ),
      }),
    );

    expect(page.indices.find((index) => index.key === "hydropower")?.name).toBe("Hydropower Index");
  });
});
