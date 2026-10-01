/**
 * The rules for touching a file that is already a historical record.
 *
 * ## Why this is its own module
 *
 * Both entry points write sessions and both must obey the same two rules — never
 * replace a byte-identical file, and never leave a partial one — but they report the
 * outcome differently. Keeping the rules here means the daily job and the backfill
 * cannot drift apart on the thing that matters most about this repository.
 *
 * ## The archive is append-only in spirit
 *
 * A day, once written, is a historical record. A later run that disagrees with it is a
 * fact about the scraper rather than a correction of the past, so the caller is told
 * that it is *rewriting* and can say so out loud. Silence here would let a changed
 * source quietly restate history.
 *
 * ## Why the write goes through a temporary file
 *
 * `writeFile` truncates and then streams. A process killed between those two — a
 * cancelled workflow, a laptop lid, a full disk — leaves a half-written CSV at the
 * real path. That file is then indistinguishable from a good one to everything
 * downstream, and both the daily job's "unchanged" check and the backfill's
 * skip-if-present rule would trust it forever.
 *
 * Writing beside the target and `rename`-ing over it removes the window: `rename` is
 * atomic within a filesystem, so the archive only ever holds a complete file. This
 * mattered less when the archive was one file a day; it matters a great deal for a
 * sweep writing several thousand, where a run being killed part-way is the normal
 * case rather than the exceptional one.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { snapshotPath } from "./paths.js";
import { snapshotToCsv } from "./serialize.js";
import type { DaySnapshot } from "../types.js";

/** What happened to the file, so the caller can report it in its own voice. */
export type ArchiveOutcome = "written" | "unchanged" | "rewritten";

/** The bytes already on disk for a session, or `null` if there are none. */
export async function archivedCsv(root: string, date: string): Promise<string | null> {
  return readFile(path.join(root, snapshotPath(date)), "utf8").catch(() => null);
}

/** True when a session is already archived, without reading the whole file. */
export async function isArchived(root: string, date: string): Promise<boolean> {
  return (await archivedCsv(root, date)) !== null;
}

/**
 * Writes a session, unless it is already there byte-for-byte.
 *
 * Returns `"unchanged"` without touching the disk when the content matches, which is
 * what makes a re-run, a retried workflow, a holiday, and a resumed backfill all safe.
 * Callers rely on that being free — the backfill skips thousands of days this way.
 */
export async function writeSnapshot(
  root: string,
  snapshot: DaySnapshot,
): Promise<ArchiveOutcome> {
  const target = path.join(root, snapshotPath(snapshot.date));
  const csv = snapshotToCsv(snapshot);

  const existing = await archivedCsv(root, snapshot.date);
  if (existing === csv) return "unchanged";

  await mkdir(path.dirname(target), { recursive: true });

  const temp = `${target}.tmp`;
  try {
    await writeFile(temp, csv, "utf8");
    await rename(temp, target);
  } catch (error) {
    // Leave nothing behind: a stray .tmp would otherwise be swept up by the workflow's
    // `git add data` and committed as though it were part of the archive.
    await unlink(temp).catch(() => {});
    throw error;
  }

  return existing === null ? "written" : "rewritten";
}
