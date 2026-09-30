/**
 * Reading one session's prices off ShareSansar's daily table.
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
 * ## The date comes from the page, never the clock
 *
 * NEPSE trades Sunday to Thursday and closes for holidays. On a non-trading day the
 * page still renders — showing the *previous* session — so a job that stamped today's
 * date onto that data would file a day that never traded, and nothing downstream could
 * tell. The page states the session it is showing in an "As of" heading, and that is
 * the only date this code will use. When it is absent, this throws rather than guesses.
 *
 * ## Columns are matched by name
 *
 * Positionally would be shorter and would break the first time the source inserts a
 * column. The headers are matched exactly rather than by prefix, because `Close` is a
 * prefix of both `Close - LTP` and `Prev. Close` and matching loosely would quietly
 * store the wrong number in the right-looking field.
 */

import { extractTableById, textOf } from "../lib/html.js";
import type { DaySnapshot, QuoteRow } from "../types.js";

export const TODAY_SHARE_PRICE_URL = "https://www.sharesansar.com/today-share-price";

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Identifies the archive rather than impersonating a browser.
 *
 * A default `fetch` user-agent is often refused outright, and pretending to be Chrome
 * would be dishonest about what this is. Naming the project means a maintainer reading
 * their logs can see who is calling and why.
 */
const USER_AGENT =
  "nepse-data/0.1 (+https://github.com/srijankarki07/nepse-data; end-of-day archive)";

/** The table's id. Stable, and the reason a table can be found without guessing. */
const TABLE_ID = "headFixed";

/**
 * A floor on how many scrips a session must contain before it is believed.
 *
 * The failure this guards is a truncated or partially-rendered response: a page that
 * arrives with twelve rows would otherwise overwrite a good file with a bad one. The
 * real table carries several hundred, so this is far below any plausible session and
 * well above any partial render.
 */
export const MIN_PLAUSIBLE_ROWS = 50;

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
 * Parses one session out of the page.
 *
 * Throws rather than returning an empty snapshot on anything unexpected. Every caller
 * of this writes to an append-only archive, so a quiet empty result would become a
 * committed file claiming the market traded nothing.
 */
export function parseTodaySharePrice(html: string): DaySnapshot {
  const date = parseAsOfDate(html);
  if (date === null) {
    throw new Error(
      'The page carried no "As of" date, so the session it shows is unknown. Refusing to guess it from the clock.',
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
  const seen = new Set<string>();

  for (const cells of body) {
    const symbol = (cells[columns.symbol] ?? "").trim().toUpperCase();
    if (symbol === "") continue;

    // One row per scrip per session is the premise of the whole archive. A duplicate
    // means the source changed shape, and silently keeping the last one would hide it.
    if (seen.has(symbol)) {
      throw new Error(`"${symbol}" appears twice in one session's table.`);
    }
    seen.add(symbol);

    rows.push({
      symbol,
      open: parseNumber(cells[columns.open] ?? ""),
      high: parseNumber(cells[columns.high] ?? ""),
      low: parseNumber(cells[columns.low] ?? ""),
      close: parseNumber(cells[columns.close] ?? ""),
      volume: parseNumber(cells[columns.volume] ?? ""),
      turnover: parseNumber(cells[columns.turnover] ?? ""),
    });
  }

  if (rows.length < MIN_PLAUSIBLE_ROWS) {
    throw new Error(
      `Only ${rows.length} scrips parsed, below the floor of ${MIN_PLAUSIBLE_ROWS}. ` +
        "Treating this as a partial response rather than a quiet session.",
    );
  }

  rows.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));

  return { date, rows };
}

/** Fetches and parses the current session. */
export async function fetchTodaySharePrice(): Promise<DaySnapshot> {
  const response = await fetch(TODAY_SHARE_PRICE_URL, {
    headers: { "user-agent": USER_AGENT, accept: "text/html" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`ShareSansar returned ${response.status} ${response.statusText}`);
  }

  return parseTodaySharePrice(await response.text());
}
