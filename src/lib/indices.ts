/**
 * The index levels: `data/indices/latest.json` and one file per index.
 *
 * ## Why this is the only index that accumulates
 *
 * `data/series/`, `data/closes/`, the manifest and the session list are all *derived* from
 * `data/daily/` and rebuilt on every run, so they cannot drift from the archive. These
 * cannot be, and the reason is the same one that makes `symbols.json` accumulate: an index
 * level is **not recoverable from the archive.** NEPSE's indices are capitalisation-weighted
 * over baskets the archive has no share counts for, so the only place a level exists is the
 * page it was read from, on the day it was published. A derived file would have nothing to
 * derive from.
 *
 * So each index gets a file that grows by one row a session, and the history begins the day
 * this was introduced rather than reaching back fifteen years. That is a real limit and it
 * is stated rather than hidden: the archive accumulated its own history by walking the
 * source day by day, and the source offers no equivalent walk for index levels.
 *
 * ## The two artifacts answer different questions
 *
 * `latest.json` is the hot path — seventeen numbers, read by a site that wants today's rail
 * and nothing else. `data/indices/<key>.csv` is the history, one file per index, which is
 * what a chart over a range needs. Folding history into the JSON would make every "what is
 * NEPSE at" download years of rows to answer a question about one day.
 *
 * ## Appending is the one rule that matters here
 *
 * A row is added only when its session is **newer** than the last one the file holds. Equal
 * means the day is already recorded, so a re-run, a retried workflow and a holiday are all
 * no-ops; older means the page is serving a session this archive has already moved past, and
 * a published history is not rewritten to match it. That is the same append-only principle
 * the daily archive follows, and it is why a correction the source makes to a past session
 * is not picked up: what was published stays published.
 *
 * The consequence is worth stating plainly, because it is a deliberate trade: for a session
 * already recorded, `latest.json` reports the values in the **file**, not the ones the page
 * is showing now. A page still carrying yesterday's session therefore cannot revise
 * yesterday's numbers through the hot path while the history keeps the original.
 *
 * `latest.json` describes the page's set of indices, not the directory's. If the exchange
 * retires an index it stops appearing here, and its file simply stops growing. That is the
 * honest answer rather than a fault: a retired level is not a stale one, and keeping the
 * last known value under an old date would present it as current.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { toCsv } from "./csv.js";
import type { IndexLevel } from "../sources/sharesansar-index.js";

/** Where the index files live. Alongside `daily/`, like the other indexes. */
export const INDICES_DIRECTORY = "data/indices";

/** The hot path: every level for the newest session, and nothing else. */
export const INDICES_LATEST_PATH = `${INDICES_DIRECTORY}/latest.json`;

/**
 * The columns each index file carries, identically to what the page publishes.
 *
 * `change` is the day's move in points and `percentChange` the same move in percent. Both
 * are kept even though one implies the other against `close`, because the source rounds
 * them and a consumer charting the move should show the figure the exchange published
 * rather than one re-derived from two rounded numbers.
 */
export const INDEX_COLUMNS = [
  "date",
  "open",
  "high",
  "low",
  "close",
  "change",
  "percentChange",
  "turnover",
] as const;

/** The header line every index file starts with. */
const HEADER = toCsv(INDEX_COLUMNS, []);

/** `data/indices/nepse.csv`, relative to the repository root. */
export function indexPath(key: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(key)) {
    throw new Error(`"${key}" is not a usable index key`);
  }
  return path.join(INDICES_DIRECTORY, `${key}.csv`);
}

/** One index's level for one session, as `latest.json` publishes it. */
export interface IndexEntry {
  /** The source's own label, so a reader can see what the key was made from. */
  name: string;
  /**
   * The session this level is from.
   *
   * Carried per entry rather than once at the top, because the two can differ. A file that
   * is ahead of the page keeps its own, newer session, and a single top-level date would
   * then label its figures with a session they are not from. It is also what makes a level
   * the source stopped publishing visible as an older date instead of looking current.
   */
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  /** The day's change in points. */
  change: number | null;
  /** The day's change in percent. */
  percentChange: number | null;
  turnover: number | null;
}

/** `data/indices/latest.json`, as published. */
export interface LatestIndices {
  /** The newest session any index file holds, or `null` when there are none. */
  date: string | null;
  /** Key to level. Keys are sorted when written, so the diff is stable. */
  indices: Record<string, IndexEntry>;
}

/** The eight values of a row, in `INDEX_COLUMNS` order but for the date. */
type RowValues = (number | null)[];

/** The last recorded row of an index file, or `null` when the file has none. */
function lastRow(csv: string | null, key: string): { date: string; values: RowValues } | null {
  if (csv === null) return null;

  const lines = csv.split(/\r?\n/).filter((line) => line !== "");
  if (lines[0] !== undefined && lines[0].trim() !== HEADER.trim()) {
    throw new Error(`${indexPath(key)} has an unexpected header, so nothing was written.`);
  }

  const line = lines.at(-1);
  if (line === undefined || line.startsWith("date,")) return null;

  const cells = line.split(",");
  if (cells.length !== INDEX_COLUMNS.length) {
    throw new Error(
      `${indexPath(key)} has a row of ${cells.length} columns, expected ` +
        `${INDEX_COLUMNS.length}. The file is damaged, so nothing was written.`,
    );
  }

  const values = cells.slice(1).map((cell) => {
    const text = cell.trim();
    if (text === "") return null;

    const value = Number(text);
    if (!Number.isFinite(value)) {
      throw new Error(`${indexPath(key)} holds "${cell}" where a number belongs.`);
    }
    return value;
  });

  return { date: cells[0] ?? "", values };
}

/** One row's values, in `INDEX_COLUMNS` order but for the date, which the caller supplies. */
function rowOf(level: IndexLevel): RowValues {
  return [
    level.open,
    level.high,
    level.low,
    level.close,
    level.change,
    level.percentChange,
    level.turnover,
  ];
}

/**
 * One appended line, terminator included.
 *
 * Written through `toCsv` rather than by joining the fields here, so the escaping has one
 * implementation. `toCsv` always emits a header, and the row is what follows it.
 */
function rowLine(date: string, values: RowValues): string {
  const rendered = toCsv(INDEX_COLUMNS, [[date, ...values]]);
  return rendered.slice(rendered.indexOf("\r\n") + 2);
}

/** Renders `latest.json`. Sorted and timestamp-free, so an unchanged run is byte-identical. */
function renderLatest(entries: Map<string, IndexEntry>): string {
  const indices: Record<string, IndexEntry> = {};
  for (const key of [...entries.keys()].sort()) {
    const entry = entries.get(key);
    if (entry !== undefined) indices[key] = entry;
  }

  // The newest session any entry is from. In the ordinary run they all share one, and this
  // is that date; it differs only for an entry that could not be updated, which its own
  // `date` then shows.
  const date = [...entries.values()].map((entry) => entry.date).sort().at(-1) ?? null;

  const latest: LatestIndices = { date, indices };
  return `${JSON.stringify(latest, null, 2)}\n`;
}

/** Writes `content` to `target` through a temporary file, so a reader never sees a half one. */
async function writeAtomically(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });

  const temp = `${target}.tmp`;
  try {
    await writeFile(temp, content, "utf8");
    await rename(temp, target);
  } catch (error) {
    // Leave nothing behind: a stray .tmp would be swept up by the workflow's `git add data`
    // and committed as though it were part of the archive.
    await unlink(temp).catch(() => {});
    throw error;
  }
}

export interface IndicesOutcome {
  /** The session the levels are for, from the page. */
  date: string;
  /** How many index levels the page carried. */
  indices: number;
  /** Keys whose file gained this session. Empty on a re-run or a holiday. */
  appended: string[];
  /** Index files whose bytes changed. */
  written: number;
  /** Index files that already held this session. */
  unchanged: number;
  /** Whether `latest.json`'s bytes changed. */
  latestChanged: boolean;
}

/** An index file to write: its key, and the bytes that go in it. */
interface Plan {
  key: string;
  csv: string;
}

/**
 * Records one page's levels: appends what is new, then rebuilds `latest.json`.
 *
 * `latest.json` is rendered from the rows that ended up recorded rather than from the page,
 * so the levels a consumer reads there are the same ones the history holds. See the note on
 * appending at the top.
 *
 * ## Every file is read and validated before any is written
 *
 * Two passes, not one, and the reason is the rule this repository holds everywhere else:
 * **nothing is written on a doubt.** The first shape of this function validated and wrote
 * each file inside a single loop, which meant a damaged file discovered halfway through left
 * the indices before it already appended, the ones after it untouched, and `latest.json`
 * never rendered at all. The site's own daily job runs this with `continue-on-error` so that
 * a source outage cannot cost a session, so that half-state would have been committed.
 *
 * Seventeen small files make the second pass free, and it buys the property that matters: a
 * doubt about the *data* now costs nothing, because a damaged file is found before the first
 * write rather than after the tenth. A disk failure in the middle of the writes is still
 * possible and is not covered; that is the one failure left, and the next run repairs it
 * because a file whose last row is behind the session is appended to again.
 */
export async function writeIndices(
  root: string,
  page: { date: string; indices: readonly IndexLevel[] },
  options: { dryRun?: boolean } = {},
): Promise<IndicesOutcome> {
  const dryRun = options.dryRun === true;
  const appended: string[] = [];
  const plans: Plan[] = [];
  const entries = new Map<string, IndexEntry>();

  let unchanged = 0;

  const entryOf = (name: string, date: string, values: RowValues): IndexEntry => {
    const [open, high, low, close, change, percentChange, turnover] = values;
    return {
      name,
      date,
      open: open ?? null,
      high: high ?? null,
      low: low ?? null,
      close: close ?? null,
      change: change ?? null,
      percentChange: percentChange ?? null,
      turnover: turnover ?? null,
    };
  };

  // Pass one: read and validate everything, deciding what each file needs. Nothing is
  // written here, so a throw part-way leaves the disk exactly as it was.
  for (const level of page.indices) {
    const target = path.join(root, indexPath(level.key));
    const existing = await readFile(target, "utf8").catch(() => null);
    // An empty file is treated as no file. It would otherwise be appended to with no header,
    // which the *next* run would refuse as a damaged file, breaking this index until someone
    // deleted it by hand.
    const held = existing === null || existing === "" ? null : existing;
    const last = lastRow(held, level.key);

    // `last.date < page.date` rather than `!==`: a page serving an older session than the
    // archive already holds is not an update, and history is not rewritten to match it.
    if (last === null || last.date < page.date) {
      const values = rowOf(level);
      // Every file this writes ends in a terminator, but a hand-edited one might not, and
      // appending to that would weld two rows into one. Cheap to refuse to.
      const base = held === null ? HEADER : held.endsWith("\n") ? held : `${held}\r\n`;

      appended.push(level.key);
      plans.push({ key: level.key, csv: `${base}${rowLine(page.date, values)}` });
      entries.set(level.key, entryOf(level.name, page.date, values));
    } else {
      unchanged++;
      // The file's row, not the page's. See the note on appending at the top.
      entries.set(level.key, entryOf(level.name, last.date, last.values));
    }
  }

  const latestTarget = path.join(root, INDICES_LATEST_PATH);
  const latest = entries.size === 0 ? null : renderLatest(entries);

  // Pass two: write. From here the only way to fail is the disk itself.
  let written = 0;
  for (const plan of plans) {
    written++;
    if (!dryRun) await writeAtomically(path.join(root, indexPath(plan.key)), plan.csv);
  }

  const existingLatest = await readFile(latestTarget, "utf8").catch(() => null);
  const latestChanged = latest !== null && existingLatest !== latest;

  if (latestChanged && !dryRun && latest !== null) await writeAtomically(latestTarget, latest);

  return {
    date: page.date,
    indices: page.indices.length,
    appended: appended.sort(),
    written,
    unchanged,
    latestChanged,
  };
}
