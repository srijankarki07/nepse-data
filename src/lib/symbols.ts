/**
 * The ticker directory: what each symbol is called, and when it was last seen.
 *
 * ## Why it is a file of its own
 *
 * The archive's CSV has eight columns of market data and no room for a company name, and
 * that format is the one thing in this repository that is expensive to change — three
 * thousand files already carry it. So names are published beside the archive instead:
 * the CSV stays the record of prices, and this is the record of what the tickers mean.
 *
 * ## Why it is merged rather than rebuilt
 *
 * The manifest and the session list are *derived* — rebuilt from the filenames each run,
 * so they cannot drift. This one cannot be, and the reason is worth stating because it
 * breaks the pattern: **a name is not recoverable from the archive.** It is read from the
 * source page, once, on the day a scrip is first seen. Rebuilding from the archive would
 * produce a directory of tickers with no names at all.
 *
 * So it accumulates. Each run adds what it saw and leaves the rest alone, which means a
 * scrip that stops trading keeps its name and its `lastSeen` stops moving — the two facts
 * a consumer needs to tell "delisted" from "never existed".
 *
 * ## What it does not cover, and why that is honest
 *
 * Names are learned from the day's page, so they exist for scrips that have traded since
 * this file was introduced. A scrip delisted in 2015 that never appeared again has no
 * name here. Filling that in would mean re-reading fifteen years of pages from the source
 * to recover attributes for companies that no longer exist, and the honest position is
 * that the archive has their prices and not their names.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Where a consumer looks for the directory. Alongside `daily/`, like the other indexes. */
export const SYMBOLS_FILE = "symbols.json";
export const SYMBOLS_PATH = `data/${SYMBOLS_FILE}`;

export interface SymbolEntry {
  /** The company's name, as the source publishes it. */
  name: string;
  /** The most recent session this ticker appeared in, `YYYY-MM-DD`. */
  lastSeen: string;
}

/** Ticker to entry. Keys are sorted when written, so the diff is stable. */
export type SymbolDirectory = Record<string, SymbolEntry>;

/** The directory as published, or an empty object when there is none yet. */
export async function readSymbols(root: string): Promise<SymbolDirectory> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(root, SYMBOLS_PATH), "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as SymbolDirectory;
  } catch {
    // Absent on a fresh clone, and a file this reader cannot parse is treated the same
    // way. Either is a directory that starts empty and grows, not a failure.
    return {};
  }
}

/**
 * Folds one session's names into the directory.
 *
 * `date` is the session they were seen in, so `lastSeen` records what the archive knows
 * rather than when this happened to run.
 */
export async function mergeSymbols(
  root: string,
  names: ReadonlyMap<string, string>,
  date: string,
): Promise<SymbolDirectory> {
  const directory = await readSymbols(root);

  for (const [symbol, name] of names) {
    // The source can rename a company, so a name is refreshed rather than kept. Only
    // `lastSeen` would otherwise ever change, and a directory that could not follow a
    // rebranding would be quietly out of date.
    directory[symbol] = { name, lastSeen: date };
  }

  await writeSymbols(root, directory);
  return directory;
}

/**
 * Writes the directory, keys sorted.
 *
 * Sorted because this file is rewritten in full on every run: unsorted, a rename would
 * reshuffle the whole file and its diff would be useless for review.
 */
export async function writeSymbols(root: string, directory: SymbolDirectory): Promise<void> {
  const sorted: SymbolDirectory = {};
  for (const symbol of Object.keys(directory).sort()) {
    const entry = directory[symbol];
    if (entry !== undefined) sorted[symbol] = entry;
  }

  const target = path.join(root, SYMBOLS_PATH);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
}
