/**
 * Calendar days, and what "today" means here.
 *
 * ## Why a day is not a moment
 *
 * The archive stores *sessions*, and a session is named by a calendar date. Nothing in
 * this module is about an instant in time, which is why the arithmetic is all `Date.UTC`
 * and never local: the sequence of dates from one to another is a fact independent of
 * any clock, and building it in UTC keeps it out of daylight-saving entirely.
 *
 * ## Why "today" is Kathmandu's today
 *
 * The one place a clock does enter is the backfill's default end date, and there the
 * timezone is the whole point. The exchange is in Kathmandu, which is UTC+05:45 — so at
 * 18:20 UTC it is already tomorrow there. A runner in UTC asking for "today" after 18:15
 * UTC would be asking for the next Kathmandu day, and in the other direction a job
 * asking for "yesterday" before 18:15 UTC would be asking for a day that is still today
 * in Nepal and has not closed yet — a partial session, written into the archive, which
 * the daily job would then find and rewrite. The append-only rule exists to prevent
 * exactly that, so the boundary is worth getting right rather than approximating with
 * a UTC date.
 */

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const MS_PER_DAY = 86_400_000;

/**
 * True when `value` is `YYYY-MM-DD` **and names a real calendar date**.
 *
 * The pattern alone is not enough: it admits `2021-02-30` and `2021-13-01`, and a
 * round-trip through `Date` is what rejects them. Callers act on this before spending a
 * network request, so a typo in a `--from` should be a usage error rather than a sweep
 * that fails four hours in.
 */
export function isRealDay(value: string): boolean {
  const match = DAY_PATTERN.exec(value);
  if (match === null) return false;

  const [, year, month, day] = match;
  if (year === undefined || month === undefined || day === undefined) return false;

  const y = Number(year);
  const m = Number(month);
  const d = Number(day);

  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
  );
}

/**
 * Every calendar day from `from` to `to`, inclusive, as `YYYY-MM-DD`.
 *
 * Inclusive at both ends because the range is written by a human as "the first to the
 * last day I want", and a caller that had to adjust the endpoint by one would be a
 * standing invitation to an off-by-one day missing from the archive.
 */
export function eachDay(from: string, to: string): string[] {
  if (!isRealDay(from)) throw new Error(`"${from}" is not a real YYYY-MM-DD date`);
  if (!isRealDay(to)) throw new Error(`"${to}" is not a real YYYY-MM-DD date`);

  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (start > end) throw new Error(`The range ends on ${to}, before it starts on ${from}`);

  const days: string[] = [];
  for (let time = start; time <= end; time += MS_PER_DAY) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return days;
}

/** The day before `date`. */
export function previousDay(date: string): string {
  if (!isRealDay(date)) throw new Error(`"${date}" is not a real YYYY-MM-DD date`);

  const time = Date.parse(`${date}T00:00:00Z`) - MS_PER_DAY;
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * `en-CA` is not a mistake: it is the one built-in locale whose short date form is
 * already `YYYY-MM-DD`, so this formats the answer instead of assembling it from parts.
 */
const KATHMANDU_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kathmandu",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today's date in Kathmandu, which is not today everywhere. See the note above. */
export function kathmanduToday(now: Date = new Date()): string {
  return KATHMANDU_DAY.format(now);
}
