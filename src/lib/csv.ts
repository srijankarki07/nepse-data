/**
 * Writing the archive's CSV.
 *
 * RFC 4180: a field containing a comma, a quote, a newline or leading whitespace is
 * quoted, and a quote inside a quoted field is doubled. Written out rather than taken
 * from a package for the same reason the HTML reader is — this repository has one
 * output format and no dependencies.
 *
 * ## CRLF, and why it is not a mistake
 *
 * The spec says CRLF and every spreadsheet accepts it. The files here are read by
 * programs far more often than by people, and every one of them handles both — so the
 * argument for LF would be tidier diffs, and the argument for CRLF is that a file
 * opened in Excel on Windows is one of the ways this data gets looked at. Git is
 * configured to leave the terminators alone (see `.gitattributes`).
 */

export type CsvValue = string | number | boolean | null | undefined;

function escapeField(value: CsvValue): string {
  if (value === null || value === undefined) return "";

  const text = String(value);
  if (/[",\r\n]/.test(text) || text !== text.trim()) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

/** Renders rows as CSV text with a header line, terminated with CRLF. */
export function toCsv(
  headers: readonly string[],
  rows: readonly (readonly CsvValue[])[],
): string {
  const lines = [headers.map(escapeField).join(",")];

  for (const row of rows) {
    lines.push(row.map(escapeField).join(","));
  }

  return `${lines.join("\r\n")}\r\n`;
}
