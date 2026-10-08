/**
 * The index levels, read from ShareSansar's market page.
 *
 * ## Why this is a source of its own
 *
 * It reads a different page from `sharesansar.ts`, for a different artifact, and it fails
 * differently. The price page is the record and its parser refuses anything doubtful; this
 * one reads a panel the site publishes beside its own market summary, and what it produces
 * is a small derived file.
 *
 * ## Why the levels are worth having
 *
 * NEPSE's indices are capitalisation-weighted over defined baskets, and this archive holds
 * eight columns of per-scrip prices with no share counts, so the real index **cannot** be
 * computed from the archive. A site showing an equal-weighted average of its own can label
 * it honestly, but it is not NEPSE. These are the exchange's own levels.
 *
 * ## The tables have no id, so they are found by heading
 *
 * The market page's twelve tables share one class and carry no `id`, so `extractTableById`
 * cannot reach them. What distinguishes them is the `<h3>` above each one, so the heading
 * is the locator: `Indices` holds the four headline levels, `Sub Indices` the thirteen
 * sectors. See `sectionByHeading`.
 *
 * ## The near miss: a sibling table reuses the index names
 *
 * Under the heading `Impacting Scripts` sits a block of "which scripts moved this sector"
 * rows, and it reuses index names for a different meaning entirely: `Investment`, `Finance`,
 * `Others` and six more appear there as sector labels beside a list of tickers. Reading it
 * would file a list of tickers as an index level.
 *
 * It does not reach this parser, and the reason is worth stating because nothing else here
 * would catch it: those rows span **two cells** against the header's eight, and they live in
 * a table of their own which `sectionByHeading` never enters, since the slice stops at the
 * first table's `</table>`. So the width check below is a backstop rather than the defence.
 * It would become the defence if the source ever left a table unclosed, which is the one way
 * this section could run on into the next one. See `findTableEnd`, which falls back to the
 * end of the page rather than returning nothing.
 *
 * A row that does not span the header is therefore **refused**, not skipped. Skipping was
 * the first shape here and it was wrong: on the real page no such row exists, so the only
 * thing it could ever do was drop a mishaped index row in silence and report a normal run.
 *
 * ## The date comes from the page, never the clock
 *
 * Each table carries its own "As of <date>" line, and the page has several more that are
 * *not* this date: the foreign-exchange panel is stamped with today while the indices are
 * stamped with the last session the exchange computed them for. So the date is read from
 * inside each index section, and the two are required to agree — a page caught mid-update
 * would otherwise be filed as though both days had been seen.
 */

import { extractTableRows, sectionByHeading } from "../lib/html.js";
import { REQUEST_TIMEOUT_MS, USER_AGENT, parseAsOfDate, parseNumber } from "./sharesansar.js";

/** The page carrying both index tables. A plain GET, unlike the dated price route. */
export const MARKET_URL = "https://www.sharesansar.com/market";

/** The headings the two tables sit under, in the order the page publishes them. */
const SECTIONS = ["Indices", "Sub Indices"] as const;

/**
 * A floor on how many index levels a page must carry before it is believed.
 *
 * The page lists seventeen. This sits well below that and well above the handful a
 * partially-rendered page would show, which is the trade `MIN_PLAUSIBLE_ROWS` makes for a
 * session. It cannot be tight, because *removing* an index is a change the source is
 * entitled to make, and a floor that tracked the count would turn that into a red run.
 */
export const MIN_INDEX_ROWS = 10;

/**
 * The page's label for an index, to the key this archive files it under.
 *
 * The key is the published contract: it names the file under `data/indices/` and is what a
 * consumer passes to read one index's history. So it is a **fixed table rather than a slug
 * derived from the label**, and the difference matters. A derived slug would follow the
 * source through a rename and quietly start a second file, leaving every reader of the old
 * key with a history that simply stops — a gap nothing downstream could detect. An unknown
 * label throws instead, and a person decides whether it is a rename or an addition.
 *
 * Labels are matched case- and whitespace-insensitively, because `HydroPower` becoming
 * `Hydropower` is a spelling change rather than a different index. Anything more is a
 * rename, and is meant to be noticed.
 */
const INDEX_KEYS: Record<string, string> = {
  "nepse index": "nepse",
  "sensitive index": "sensitive",
  "float index": "float",
  "sensitive float index": "sensitive-float",
  "banking subindex": "banking",
  "development bank index": "development-bank",
  "finance index": "finance",
  "hotels and tourism": "hotels-and-tourism",
  "hydropower index": "hydropower",
  investment: "investment",
  "life insurance": "life-insurance",
  "manufacturing and processing": "manufacturing-and-processing",
  "microfinance index": "microfinance",
  "mutual fund": "mutual-fund",
  "non life insurance": "non-life-insurance",
  "others index": "others",
  "trading index": "trading",
};

/**
 * The columns read from each table, by the header the source gives them.
 *
 * Matched by name rather than by position, for the same reason the price table is: the
 * source inserts columns, and a positional reader stores the wrong number in a
 * right-looking field the day it does. The two tables label their first and sixth columns
 * differently (`Index` against `Sub Index`, `Point Change` against `Point`), so those carry
 * the alternatives rather than one spelling.
 */
const COLUMN_NAMES = {
  label: ["Index", "Sub Index"],
  open: ["Open"],
  high: ["High"],
  low: ["Low"],
  close: ["Close"],
  change: ["Point Change", "Point"],
  percentChange: ["% Change"],
  turnover: ["Turnover"],
} as const;

type Field = keyof typeof COLUMN_NAMES;

/** One index's session: its level, the day's move, and the turnover behind it. */
export interface IndexLevel {
  /** The key this archive files the index under, and what a consumer asks for. */
  key: string;
  /** The source's own label, so a reader can see what the key was made from. */
  name: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  /** The day's change in points. */
  change: number | null;
  /** The day's change in percent, as the source publishes it. */
  percentChange: number | null;
  /** Total value traded across the index's constituents, in NPR. */
  turnover: number | null;
}

/** Both tables' levels for the one session they describe. */
export interface IndexPage {
  /** The session the exchange computed these for, `YYYY-MM-DD`, from the page. */
  date: string;
  indices: IndexLevel[];
}

/** Headers and labels are compared case-insensitively, with whitespace collapsed. */
function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Maps each field to its column index, or throws naming what is missing. */
function resolveColumns(header: readonly string[], section: string): Record<Field, number> {
  const cells = header.map(normalise);
  const resolved = {} as Record<Field, number>;
  const missing: string[] = [];

  for (const [field, names] of Object.entries(COLUMN_NAMES) as [Field, readonly string[]][]) {
    const index = cells.findIndex((cell) => names.some((name) => normalise(name) === cell));
    if (index === -1) missing.push(names.join(" or "));
    else resolved[field] = index;
  }

  if (missing.length > 0) {
    throw new Error(
      `The market page's "${section}" table is missing the column(s) ${missing.join(", ")}. ` +
        `Available: ${header.join(" | ")}`,
    );
  }

  return resolved;
}

/** One section's table, as index levels. `section` is the markup `sectionByHeading` returned. */
function parseIndexRows(section: string, title: string): IndexLevel[] {
  const rows = extractTableRows(section);
  const header = rows[0];

  if (header === undefined) {
    throw new Error(`The market page's "${title}" section holds no table.`);
  }

  const columns = resolveColumns(header, title);
  const levels: IndexLevel[] = [];
  const seen = new Set<string>();

  for (const cells of rows.slice(1)) {
    // A row that does not span the header is refused rather than skipped. See the note at the
    // top: on the real page no such row is in either table, so skipping could only ever drop
    // a mishaped index row silently, and a section that ran on into the next table would be
    // read as indices rather than recognised as a fault.
    if (cells.length !== header.length) {
      throw new Error(
        `The market page's "${title}" table has a row of ${cells.length} cells where the ` +
          `header has ${header.length}: ${JSON.stringify(cells)}. Nothing was written.`,
      );
    }

    const label = cells[columns.label] ?? "";
    // `hasOwn`, not a bare lookup: `INDEX_KEYS["constructor"]` would find an inherited
    // property and pass the refusal below, and a label is scraped text either way.
    const name = normalise(label);
    const key = Object.hasOwn(INDEX_KEYS, name) ? INDEX_KEYS[name] : undefined;

    if (key === undefined) {
      throw new Error(
        `The market page's "${title}" table lists an index this archive does not know: ` +
          `"${label}". If it is a new index, add it to INDEX_KEYS; if the source renamed ` +
          "one, change that entry rather than adding a second key, or its history forks.",
      );
    }

    if (seen.has(key)) {
      throw new Error(`The market page's "${title}" table lists "${label}" twice.`);
    }
    seen.add(key);

    const read = (field: Field): number | null => parseNumber(cells[columns[field]] ?? "");

    levels.push({
      key,
      name: label,
      open: read("open"),
      high: read("high"),
      low: read("low"),
      close: read("close"),
      change: read("change"),
      percentChange: read("percentChange"),
      turnover: read("turnover"),
    });
  }

  return levels;
}

/**
 * Both index tables off one market page, or a thrown error naming what was wrong.
 *
 * Nothing is returned on a doubt, for the same reason the price parser refuses: a caller
 * that is about to append to a published file should have no way to append half a page.
 */
export function parseMarketPage(html: string): IndexPage {
  const dates: string[] = [];
  const indices: IndexLevel[] = [];

  for (const title of SECTIONS) {
    const section = sectionByHeading(html, title);
    if (section === null) {
      throw new Error(
        `The market page has no "${title}" section, so no index levels could be read. ` +
          "The page's markup has probably changed.",
      );
    }

    const date = parseAsOfDate(section);
    if (date === null) {
      throw new Error(
        `The market page's "${title}" section carries no "As of" date, so the session it ` +
          "describes is unknown. Nothing was written.",
      );
    }

    dates.push(date);
    indices.push(...parseIndexRows(section, title));
  }

  const date = dates[0];
  if (date === undefined) throw new Error("The market page yielded no index session.");

  if (dates.some((other) => other !== date)) {
    throw new Error(
      `The market page's index tables disagree about the session: ${dates.join(" and ")}. ` +
        "A page halfway through an update cannot be filed, so nothing was written.",
    );
  }

  if (indices.length < MIN_INDEX_ROWS) {
    throw new Error(
      `The market page yielded ${indices.length} index levels, fewer than the ` +
        `${MIN_INDEX_ROWS} believed. A partially-rendered page would look like this, so ` +
        "nothing was written.",
    );
  }

  return { date, indices };
}

export interface IndexFetchOptions {
  /** Injected so tests exercise the parser without touching the network. */
  fetch?: typeof fetch;
  userAgent?: string;
}

/** The market page's markup. Throws rather than returning a body that is not a page. */
export async function fetchMarketPage(options: IndexFetchOptions = {}): Promise<string> {
  const doFetch = options.fetch ?? fetch;

  const response = await doFetch(MARKET_URL, {
    headers: { "user-agent": options.userAgent ?? USER_AGENT, accept: "text/html" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `ShareSansar returned ${response.status} ${response.statusText} for the market page.`,
    );
  }

  return await response.text();
}
