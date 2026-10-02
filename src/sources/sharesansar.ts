/**
 * Reading one session's prices off ShareSansar.
 *
 * ## Why this source
 *
 * The exchange's own API is the obvious choice and is not usable from a scheduled job:
 * its endpoints are behind a token the site generates in WebAssembly, and a scraper
 * that has to execute and deobfuscate a browser payload is a scraper that breaks
 * whenever the exchange ships a frontend change, silently, at 3am.
 *
 * ShareSansar serves the same session's figures as one plainly-marked HTML table with
 * no authentication. One request returns the whole market.
 *
 * ## Two routes, one table
 *
 * This module reads the same `#headFixed` table from two different responses:
 *
 *   - **Today's page** (`/today-share-price`), which carries the table inline. That is
 *     what `fetchTodaySession` and `parseTodaySharePrice` handle, and it is what the
 *     daily workflow uses.
 *   - **The dated AJAX route** (`POST /ajaxtodayshareprice`), which re-renders the same
 *     table for an arbitrary past date. That is what `parseBackfillDay` handles, and it
 *     is what makes a historical backfill possible at all. The route is not documented
 *     anywhere: it was found by reading the site's own JavaScript
 *     (`content.sharesansar.com/site/js/main_2.0.min.js`), where the Search button turns
 *     out to be a click handler rather than a form submission. The scaffolding for
 *     calling it lives in `sharesansar-session.ts`.
 *
 * The two share `parseFragment`, and differ only in policy — see the note above it.
 *
 * ## The date comes from the page, never the clock
 *
 * The exchange closes for holidays, and on a non-trading day the page still renders —
 * showing the *previous* session — so a job that stamped today's date onto that data
 * would file a day that never traded, and nothing downstream could tell. The page states
 * the session it is showing in an "As of" heading, and that is the only date this code
 * will use. When it is absent, this throws rather than guesses.
 *
 * Note that the trading *week* is deliberately not encoded anywhere in this module. It
 * has changed: the archive holds Sunday-to-Thursday sessions up to 2026-04-05 and
 * Monday-to-Friday ones from 2026-04-10. Anything that predicted trading days from a
 * weekday rule would have gone on quietly fetching the wrong ones.
 *
 * ## Columns are matched by name
 *
 * Positionally would be shorter and would break the first time the source inserts a
 * column. The headers are matched exactly rather than by prefix, because `Close` is a
 * prefix of both `Close - LTP` and `Prev. Close` and matching loosely would quietly
 * store the wrong number in the right-looking field.
 */

import { extractTableById, symbolNames, textOf } from "../lib/html.js";
import type { DaySnapshot, QuoteRow } from "../types.js";

export const TODAY_SHARE_PRICE_URL = "https://www.sharesansar.com/today-share-price";

export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Identifies the archive rather than impersonating a browser.
 *
 * A default `fetch` user-agent is often refused outright, and pretending to be Chrome
 * would be dishonest about what this is. Naming the project means a maintainer reading
 * their logs can see who is calling and why — which matters all the more for the
 * backfill, where one run makes several thousand requests.
 */
export const USER_AGENT =
  "nepse-data/0.1 (+https://github.com/srijankarki07/nepse-data; end-of-day archive)";

/** The table's id. Stable, and the reason a table can be found without guessing. */
export const TABLE_ID = "headFixed";

/**
 * A floor on how many scrips a session must contain before it is believed.
 *
 * The failure this guards is a truncated or partially-rendered response: a page that
 * arrives with twelve rows would otherwise overwrite a good file with a bad one. The
 * real table carries several hundred, so this is far below any plausible session and
 * well above any partial render.
 *
 * This is the floor for **today's page**. History needs a different one — see
 * `MIN_HISTORICAL_ROWS`.
 */
export const MIN_PLAUSIBLE_ROWS = 50;

/**
 * The floor for a day fetched *by date*, as opposed to the floor for today's page.
 *
 * The daily floor of 50 is calibrated against a market of ~350 scrips and guards a
 * truncated response. History is a different problem, and the difference is larger than
 * it first appears: the earliest sessions in the sweep's range are not a smaller version
 * of today's market, they are a *tiny* one. Measured directly rather than assumed —
 * January 2011 has sessions of 4, 5 and 6 scrips, and 2011 only reaches ~84 by November.
 * A floor of 10, which was the first guess here, refused every real session in the first
 * weeks of the range.
 *
 * So this sits as low as it can while still doing its job. What it guards against is a
 * response that lost most of its rows; what it must not do is refuse a market that
 * genuinely had four listings. At these counts the two are close to indistinguishable,
 * which is why the sweep *reports* the per-year minimum, median and maximum — a year
 * whose minimum sits far below its median is the signature of truncation that still
 * cleared the floor, and it is visible in the log without any extra machinery.
 *
 * It is deliberately **not** a per-year table. Such a table would be a set of numbers
 * invented from a handful of samples, and this repository's rule is to refuse rather
 * than to guess. `--min-rows` overrides it, per day or per run.
 */
export const MIN_HISTORICAL_ROWS = 3;

/** The source column each stored field is read from, matched exactly. */
const COLUMN_NAMES = {
  symbol: "Symbol",
  open: "Open",
  high: "High",
  low: "Low",
  close: "Close",
  volume: "Vol",
  turnover: "Turnover",
} as const;

type Field = keyof typeof COLUMN_NAMES;

/** Headers are compared case-insensitively and with whitespace collapsed. */
function normaliseHeader(header: string): string {
  return header.replace(/\s+/g, " ").trim().toLowerCase();
}

/** `"1,234.50"` → `1234.5`; `"-"`, `""` and junk → `null`. */
export function parseNumber(raw: string): number | null {
  const cleaned = raw.replaceAll(",", "").trim();
  if (cleaned === "" || /^[-–—]+$/.test(cleaned)) return null;

  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * The fields a session stores, in one list so row equality cannot silently miss one when
 * the schema grows.
 */
const ROW_FIELDS = ["symbol", "open", "high", "low", "close", "volume", "turnover"] as const;

/**
 * Whether two parsed rows are the same observation.
 *
 * Compared on the parsed values rather than the source's cell text, because the two differ
 * in ways that are not disagreements: `"1,234.50"` and `"1234.5"` are the same number, and
 * `"-"` and an empty cell are both an absent one. Comparing the raw cells would read those
 * as a conflict and refuse a day whose repeats are in fact identical.
 *
 * `null` is a value here — two absent fields are the same absence — and `parseNumber` never
 * returns `NaN`, so `===` is exact.
 */
function sameRow(a: QuoteRow, b: QuoteRow): boolean {
  return ROW_FIELDS.every((field) => a[field] === b[field]);
}

/**
 * The session the page is showing, from its "As of" heading.
 *
 * Returns `null` when it is absent, which is a refusal rather than a fallback: a
 * plausible-looking date invented from the clock is precisely the corruption this
 * function exists to prevent.
 */
export function parseAsOfDate(html: string): string | null {
  const match = /As of\s*:?\s*<span[^>]*>\s*(\d{4}-\d{2}-\d{2})\s*<\/span>/i.exec(html);
  if (match?.[1] !== undefined) return match[1];

  // A looser second attempt, in case the span is dropped but the heading survives.
  const heading = /As of\s*:?\s*([\s\S]{0,80})/i.exec(textOf(html));
  const loose = heading?.[1] === undefined ? null : /(\d{4}-\d{2}-\d{2})/.exec(heading[1]);
  return loose?.[1] ?? null;
}

/**
 * The page's own count of how many scrips it is showing — `"Total number of
 * Compaines: 0"`, misspelling included.
 *
 * Read through `textOf` rather than off the raw markup so that the tags between the
 * label and the number do not matter, and matched on `Comp\w*` rather than on either
 * spelling, because the site currently writes `Compaines` and will presumably one day
 * fix it. Matching only the correct spelling would mean this evidence silently stopped
 * being found on the day of the fix, and the emptiness rule built on it would start
 * refusing real holidays.
 */
export function companyCount(html: string): number | null {
  const match = /Total number of Comp\w*\s*:?\s*(\d+)/i.exec(textOf(html));
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * Why this response is believed to be a day the market did not trade, or `null` if
 * there is no such reason.
 *
 * The page states this itself, and that statement is the only thing accepted as proof.
 * See `parseBackfillDay` for why the row count cannot be.
 */
export function emptySessionEvidence(html: string): string | null {
  const reasons: string[] = [];

  if (/No Record Found\.?/i.test(textOf(html))) reasons.push('"No Record Found."');
  if (companyCount(html) === 0) reasons.push("a company count of 0");

  return reasons.length === 0 ? null : reasons.join(" and ");
}

/** Maps each stored field to its column index, or throws naming what is missing. */
function resolveColumns(header: readonly string[]): Record<Field, number> {
  const normalised = header.map(normaliseHeader);
  const resolved = {} as Record<Field, number>;
  const missing: string[] = [];

  for (const [field, name] of Object.entries(COLUMN_NAMES) as [Field, string][]) {
    const index = normalised.indexOf(name.toLowerCase());
    if (index === -1) missing.push(name);
    else resolved[field] = index;
  }

  if (missing.length > 0) {
    throw new Error(
      `The price table is missing the column(s) ${missing.join(", ")}. ` +
        `Available: ${header.join(" | ")}`,
    );
  }

  return resolved;
}

/**
 * A session that parsed but held fewer scrips than the floor allows.
 *
 * Its own class because the two callers treat it differently: the daily job lets it
 * propagate and fails the run, while the backfill records the day as *refused* and
 * carries on to the next one. A generic `Error` could not be told apart from a
 * structural fault, and the backfill must not continue past one of those.
 */
export class ImplausibleSessionError extends Error {
  /** How many scrips it did parse, so a caller can report and re-run without reparsing. */
  readonly rows: number;

  constructor(message: string, rows: number) {
    super(message);
    this.name = "ImplausibleSessionError";
    this.rows = rows;
  }
}

/** The two legitimate endings of reading the table, and nothing else. */
type FragmentOutcome =
  | { kind: "session"; snapshot: DaySnapshot; collapsedDuplicates: number }
  | { kind: "empty" };

interface FragmentOptions {
  /** Below this many rows the response is not believed. */
  minRows: number;
  /**
   * Whether a zero-row table is an acceptable ending.
   *
   * `false` for today's page, where an empty table means the fetch or the source is
   * broken and the run should fail. `true` for a day fetched by date, where the market
   * genuinely did not trade — but the caller must then confirm *why* it was empty; see
   * `parseBackfillDay`.
   */
  allowEmpty: boolean;
  /**
   * When set, the heading must name exactly this day.
   *
   * Catches the endpoint quietly falling back to the current session — the behaviour
   * every dead route in HANDOFF.md exhibited — which would otherwise file live prices
   * under a historical date.
   */
  expectDate?: string;
  /**
   * Whether a repeated scrip carrying the same values as the row already read may be
   * collapsed to one.
   *
   * Off for today's page, where a repeated scrip means the response is malformed and the
   * run should fail rather than wave it through. On for the dated route, where the source
   * genuinely re-lists some scrips on historical days — measured on 2012-10-01, where every
   * scrip appears twice — and refusing costs the whole session.
   *
   * A repeat whose values *differ* is two conflicting claims about one session, and is
   * refused on either route.
   */
  collapseIdenticalDuplicates?: boolean;
}

/**
 * Reads one session's table, and refuses everything it does not understand.
 *
 * Throws on any *structural* fault — no date, no table, no header, a missing column, a
 * duplicated scrip, too few rows. Those all mean the source or the response is broken,
 * and every caller writes to an append-only archive, so a quiet empty result would
 * become a committed file claiming the market traded nothing.
 *
 * The one judgement left to the caller is whether a zero-row table is an ending or a
 * fault, which is what `allowEmpty` decides.
 */
function parseFragment(html: string, options: FragmentOptions): FragmentOutcome {
  const date = parseAsOfDate(html);
  if (date === null) {
    throw new Error(
      'The page carried no "As of" date, so the session it shows is unknown. Refusing to guess it from the clock.',
    );
  }

  if (options.expectDate !== undefined && date !== options.expectDate) {
    throw new Error(
      `The endpoint answered for ${date} but ${options.expectDate} was requested — ` +
        "it appears to have fallen back to the current session. Refusing to file live " +
        "prices under a historical date.",
    );
  }

  const table = extractTableById(html, TABLE_ID);
  if (table === null) {
    throw new Error(`No table with id "${TABLE_ID}" — the page layout has changed.`);
  }

  const [header, ...body] = table;
  if (header === undefined) throw new Error("The price table has no header row.");

  const columns = resolveColumns(header);
  const rows: QuoteRow[] = [];
  const seen = new Map<string, QuoteRow>();
  let collapsedDuplicates = 0;

  for (const cells of body) {
    const symbol = (cells[columns.symbol] ?? "").trim().toUpperCase();
    if (symbol === "") continue;

    const parsed: QuoteRow = {
      symbol,
      open: parseNumber(cells[columns.open] ?? ""),
      high: parseNumber(cells[columns.high] ?? ""),
      low: parseNumber(cells[columns.low] ?? ""),
      close: parseNumber(cells[columns.close] ?? ""),
      volume: parseNumber(cells[columns.volume] ?? ""),
      turnover: parseNumber(cells[columns.turnover] ?? ""),
    };

    // One row per scrip per session is the premise of the whole archive. A duplicate
    // means the source changed shape, and silently keeping the last one would hide it.
    const already = seen.get(symbol);

    if (already !== undefined) {
      // The dated route re-lists some scrips on historical days. A repeat carrying exactly
      // the same values is the same observation twice, so where the caller has opted in it
      // is collapsed to one — and counted, never swallowed. A repeat whose values differ is
      // two conflicting claims about one session, which no route may resolve by choosing.
      if (options.collapseIdenticalDuplicates === true && sameRow(already, parsed)) {
        collapsedDuplicates++;
        continue;
      }

      throw new Error(`"${symbol}" appears twice in one session's table.`);
    }

    seen.set(symbol, parsed);
    rows.push(parsed);
  }

  // Checked before the floor, because an empty table is below every floor and the two
  // need different messages: "this day did not trade" is not "this response is short".
  if (rows.length === 0 && options.allowEmpty) return { kind: "empty" };

  if (rows.length < options.minRows) {
    throw new ImplausibleSessionError(
      `Only ${rows.length} scrips parsed, below the floor of ${options.minRows}. ` +
        "Treating this as a partial response rather than a quiet session.",
      rows.length,
    );
  }

  rows.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));

  return { kind: "session", snapshot: { date, rows }, collapsedDuplicates };
}

/**
 * Parses the session off today's page.
 *
 * Throws rather than returning an empty snapshot on anything unexpected, a zero-row
 * table included: on this route an empty table is a broken fetch, never a quiet market.
 */
export function parseTodaySharePrice(html: string): DaySnapshot {
  const outcome = parseFragment(html, {
    minRows: MIN_PLAUSIBLE_ROWS,
    allowEmpty: false,
  });

  if (outcome.kind === "empty") {
    // Unreachable: `allowEmpty: false` sends a zero-row table to the floor check above.
    throw new ImplausibleSessionError("The price table had no rows.", 0);
  }

  return outcome.snapshot;
}

/**
 * One dated day that parsed, together with the normalisations the sweep has to report.
 *
 * A wrapper rather than a field on `DaySnapshot`: that type is the shape this repository
 * *stores*, and it is read back off disk by `sessionFingerprint` and by the archive's own
 * tests. A collapse is a fact about one parse, not a property of a session, and hanging it
 * off the snapshot would let the writer ignore it silently — which is precisely the
 * behaviour this count exists to prevent.
 */
export interface ParsedBackfillDay {
  /** The session's prices — what becomes the day's CSV. */
  snapshot: DaySnapshot;
  /**
   * How many repeated rows were dropped because a scrip was listed more than once with
   * identical values. Zero on an ordinary day, and always zero on the daily route.
   */
  collapsedDuplicates: number;
}

/**
 * Parses one dated response from the AJAX route.
 *
 * Returns `null` for a day the market did not trade, and throws for everything else.
 *
 * ## Why a zero row count is not enough to mean "no session"
 *
 * A response truncated exactly at the header boundary parses to zero rows, and so does
 * a holiday. If zero rows meant "holiday", a dropped connection halfway through a
 * sweep would silently omit a real trading session from the archive, and no log would
 * say so. So emptiness is only accepted on the page's own evidence — "No Record Found."
 * or a stated count of zero — and an unexplained empty response throws instead.
 *
 * The mirrored case matters too: rows are absent but the page claims a count greater
 * than zero, which is the page contradicting itself and is likewise a refusal.
 *
 * ## Why the heading is checked as well
 *
 * The heading on this route echoes the requested date, so this check is nearly free —
 * but it is not worthless, because it is exactly what catches the endpoint falling back
 * to the current session. What it cannot catch is the endpoint *synthesising* the
 * heading from the request while still serving live prices; nothing in a single
 * response can. The sweep guards that case across requests instead, by refusing two
 * different dates that return an identical table.
 */
export function parseBackfillDay(
  html: string,
  requestedDate: string,
  minRows: number = MIN_HISTORICAL_ROWS,
): ParsedBackfillDay | null {
  const outcome = parseFragment(html, {
    minRows,
    allowEmpty: true,
    expectDate: requestedDate,
    collapseIdenticalDuplicates: true,
  });

  if (outcome.kind === "session") {
    return { snapshot: outcome.snapshot, collapsedDuplicates: outcome.collapsedDuplicates };
  }

  const claimed = companyCount(html);
  if (claimed !== null && claimed > 0) {
    throw new Error(
      `The response for ${requestedDate} has no rows but states ${claimed} companies. ` +
        "The page contradicts itself, so which part is wrong is unknown.",
    );
  }

  const evidence = emptySessionEvidence(html);
  if (evidence === null) {
    throw new Error(
      `The response for ${requestedDate} has no rows and no evidence that the market was ` +
        "closed. A truncated response looks identical to a holiday here, so this is " +
        "refused rather than recorded as a day that did not trade.",
    );
  }

  return null;
}

/** One fetch of the daily page, read for everything it carries. */
export interface FetchedSession {
  /** The session's prices — what becomes the day's CSV. */
  snapshot: DaySnapshot;
  /**
   * Company names by ticker, when the page carries them.
   *
   * Empty rather than an error when the links are absent: prices are the point, and a
   * page that parses perfectly well should not fail over a name.
   */
  names: Map<string, string>;
}

/**
 * Fetches the current session: its prices, and the company names the page links to.
 *
 * Both come from one request because they come from one page, and because they are read
 * at the same moment — the names belong to the session the prices are from.
 */
export async function fetchTodaySession(): Promise<FetchedSession> {
  const response = await fetch(TODAY_SHARE_PRICE_URL, {
    headers: { "user-agent": USER_AGENT, accept: "text/html" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`ShareSansar returned ${response.status} ${response.statusText}`);
  }

  const html = await response.text();

  // The prices are parsed first, and deliberately: if the page has changed shape, that is
  // the failure worth reporting, and it throws here rather than being masked by a name
  // lookup that quietly returned nothing.
  return { snapshot: parseTodaySharePrice(html), names: symbolNames(html) };
}
