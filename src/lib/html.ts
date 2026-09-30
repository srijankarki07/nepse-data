/**
 * The smallest amount of HTML reading this repository needs.
 *
 * ## Why not a parser dependency
 *
 * This repository's entire job is to run once a day and commit a file. A dependency
 * is a supply-chain surface, a lockfile to keep current, and a thing that can break
 * the run at 3am for a reason unrelated to prices — so anything that can be done in
 * fifty careful lines is done in fifty careful lines.
 *
 * A parser would be justified if this read arbitrary markup. It does not: one page,
 * one table with a stable id, whose rows are plain `<tr>` and `<td>`. The tests run
 * against a **real captured page** rather than a hand-written fixture, so if the
 * source's shape moves, they fail rather than quietly returning nothing.
 *
 * ## What it deliberately does not handle
 *
 * Nested tables are counted so the right `</table>` is found, but a nested table's
 * rows are **not** separated from the outer one's. That is a real limitation and it
 * is recorded rather than hidden — the alternative was a parser, and this source has
 * no nested tables.
 */

/** The handful of entities a price table actually uses, plus the numeric escape. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const hex = entity[1]?.toLowerCase() === "x";
      const code = Number.parseInt(hex ? entity.slice(2) : entity.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/**
 * Removes tags, including the *contents* of `<script>` and `<style>`.
 *
 * The style rules matter rather than being tidiness: this source embeds a `<style>`
 * block inside the very container being read, so stripping tags alone would leave
 * `.light-blue { background-color: #d6eef8; }` as cell text.
 */
export function stripTags(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]*>/g, "");
}

/** Tag-free, entity-decoded, whitespace-collapsed text. */
export function textOf(html: string): string {
  return decodeEntities(stripTags(html)).replace(/\s+/g, " ").trim();
}

/** The opening `<table …>` tag carrying `id`, if there is one. */
function findTableTag(html: string, id: string): { start: number; end: number } | null {
  const pattern = /<table\b[^>]*>/gi;

  for (const match of html.matchAll(pattern)) {
    const tag = match[0];
    // Attribute order is not guaranteed, so the id is looked for anywhere in the tag
    // rather than through a fixed pattern that would break on a reorder.
    if (new RegExp(`\\bid\\s*=\\s*["']${id}["']`, "i").test(tag)) {
      return { start: match.index, end: match.index + tag.length };
    }
  }
  return null;
}

/** Index just past the `</table>` matching the table that opens at `from`. */
function findTableEnd(html: string, from: number): number {
  const token = /<(\/?)table\b[^>]*>/gi;
  token.lastIndex = from;
  let depth = 1;

  for (let match = token.exec(html); match !== null; match = token.exec(html)) {
    depth += match[1] === "/" ? -1 : 1;
    if (depth === 0) return match.index + match[0].length;
  }
  // An unclosed table: take the rest. Better to read too much and let the header check
  // reject it than to return nothing on a page that is otherwise readable.
  return html.length;
}

/**
 * Rows of cell text from the table carrying `id`, or `null` when no such table exists.
 *
 * `null` rather than `[]` on purpose: "the table is gone" and "the table is empty" are
 * different failures, and a caller that sees `[]` might reasonably decide there were no
 * trades today. The distinction is what lets the CLI refuse to write an empty file.
 */
export function extractTableById(html: string, id: string): string[][] | null {
  const tag = findTableTag(html, id);
  if (tag === null) return null;

  const tableHtml = html.slice(tag.end, findTableEnd(html, tag.end));

  // `</tr>` is optional in HTML, so rows are split on the opening tag and each chunk is
  // cut at its closing one if it has any. A row that never closes is still read.
  const rows: string[][] = [];

  for (const chunk of tableHtml.split(/<tr\b[^>]*>/i).slice(1)) {
    const close = chunk.search(/<\/tr>/i);
    const body = close === -1 ? chunk : chunk.slice(0, close);

    const cells = [...body.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) =>
      textOf(cell[1] ?? ""),
    );

    if (cells.length > 0) rows.push(cells);
  }

  return rows;
}
