/**
 * The shapes this repository stores and the shapes it reads.
 *
 * ## Why the stored row is not the scraped row
 *
 * The source publishes twenty-four columns, most of which are derived on the page —
 * `Diff %`, `Range`, `52 Weeks High`, a `Conf.` figure nobody has explained. Storing
 * them would mean storing somebody's arithmetic rather than the market's facts, and
 * would freeze a schema that the source is free to change.
 *
 * So the archive keeps the seven numbers that are actual observations: the session's
 * open, high, low, close, the volume, and the turnover. Every one of the source's
 * derived columns can be recomputed from those, and none of them can be recomputed
 * from the derived ones.
 *
 * ## Nulls are real
 *
 * A scrip can halt mid-session, or trade so thinly that a field is genuinely absent.
 * The source renders those as `-` or an empty cell, and they are stored as `null`
 * rather than `0` — a zero high price is a claim, and an absent one is not.
 */

/** One scrip's session. Every price is in NPR, to two decimals. */
export interface QuoteRow {
  /** The NEPSE ticker, upper-cased. */
  symbol: string;
  open: number | null;
  high: number | null;
  low: number | null;
  /** The session's closing price. */
  close: number | null;
  /** Shares traded. */
  volume: number | null;
  /** Total value traded, in NPR. */
  turnover: number | null;
}

/** Every scrip the source listed for one trading session. */
export interface DaySnapshot {
  /**
   * The trading date, `YYYY-MM-DD`, **as the source reports it**.
   *
   * Deliberately not the wall-clock date. The exchange closes for holidays, and its
   * trading week has changed within this archive's lifetime, so a run on a non-trading
   * day sees the previous session's figures on the page. Taking today's date would file
   * those under a day that never traded — silent corruption no later check would catch.
   */
  date: string;
  rows: QuoteRow[];
}
