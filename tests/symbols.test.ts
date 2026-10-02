/**
 * Company names: reading them off the page, and keeping the directory.
 *
 * The live capture is used where it matters — the real page is the only authority on
 * whether the links are still shaped the way this reader expects — and synthesised
 * markup covers the cases a live page will not show on demand.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { readFileSync as read } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { symbolNames } from "../src/lib/html.js";
import { SYMBOLS_PATH, mergeSymbols, readSymbols, writeSymbols } from "../src/lib/symbols.js";

/** The real captured page, as everywhere else in this suite. */
const realPage = gunzipSync(
  read(path.resolve(fileURLToPath(new URL(".", import.meta.url)), "fixtures/today-share-price.html.gz")),
).toString("utf8");

describe("symbolNames: the real page", () => {
  it("finds names for the whole market", () => {
    // The check that matters: if the source restructures its links, this returns nothing
    // and every symbol loses its name — silently, since prices are unaffected.
    const names = symbolNames(realPage);

    expect(names.size).toBeGreaterThan(100);
    expect(names.get("NABIL")).toBeTypeOf("string");
    expect(names.get("NABIL")).not.toBe("");
  });

  it("reads a name that is a company and not a ticker", () => {
    const names = symbolNames(realPage);
    const nabil = names.get("NABIL") ?? "";

    expect(nabil.length).toBeGreaterThan(3);
    expect(nabil).not.toBe("NABIL");
  });
});

describe("symbolNames", () => {
  const link = (symbol: string, title: string) =>
    `<a href="https://www.sharesansar.com/company/${symbol.toLowerCase()}" title="${title}">${symbol}</a>`;

  it("reads the name from the link's title", () => {
    const names = symbolNames(`<td>${link("NABIL", "Nepal Arab Bank Limited")}</td>`);
    expect(names.get("NABIL")).toBe("Nepal Arab Bank Limited");
  });

  it("does not depend on attribute order", () => {
    // A reorder would otherwise silently produce no names at all, and prices would be
    // unaffected — the failure nobody notices.
    const reordered = '<a title="Nepal Arab Bank Limited" href="/company/nabil">NABIL</a>';
    expect(symbolNames(reordered).get("NABIL")).toBe("Nepal Arab Bank Limited");
  });

  it("ignores links that are not company pages", () => {
    // The page is full of anchors. Taking their titles would file menu labels and news
    // headlines as company names.
    const html = [
      '<a href="/news/something" title="Markets rally">Markets rally</a>',
      `<a href="/company/nabil" title="Nepal Arab Bank Limited">NABIL</a>`,
    ].join("");

    const names = symbolNames(html);
    expect([...names.keys()]).toEqual(["NABIL"]);
  });

  it("ignores a company link with no title", () => {
    expect(symbolNames('<a href="/company/nabil">NABIL</a>').size).toBe(0);
  });

  it("decodes entities in a name", () => {
    const html = '<a href="/company/x" title="A &amp; B Limited">X</a>';
    expect(symbolNames(html).get("X")).toBe("A & B Limited");
  });

  it("returns nothing rather than failing when there are no links", () => {
    expect(symbolNames("<table><tr><td>NABIL</td></tr></table>").size).toBe(0);
    expect(symbolNames("").size).toBe(0);
  });
});

describe("the symbol directory", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "nepse-symbols-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("starts empty rather than failing on a fresh clone", async () => {
    expect(await readSymbols(root)).toEqual({});
  });

  it("accumulates names across sessions", async () => {
    await mergeSymbols(root, new Map([["NABIL", "Nepal Arab Bank"]]), "2026-10-01");
    await mergeSymbols(root, new Map([["ADBL", "Agricultural Development Bank"]]), "2026-10-02");

    const directory = await readSymbols(root);

    expect(Object.keys(directory).sort()).toEqual(["ADBL", "NABIL"]);
    expect(directory["NABIL"]?.lastSeen).toBe("2026-10-01");
    expect(directory["ADBL"]?.lastSeen).toBe("2026-10-02");
  });

  it("keeps a scrip that stopped trading, so delisted is distinguishable", async () => {
    // `lastSeen` is what tells "delisted" from "never existed", and it only means that if
    // a scrip that stops appearing keeps its entry rather than being pruned.
    await mergeSymbols(root, new Map([["OLD", "Old Finance"]]), "2020-01-01");
    await mergeSymbols(root, new Map([["NABIL", "Nepal Arab Bank"]]), "2026-10-02");

    const directory = await readSymbols(root);

    expect(directory["OLD"]?.lastSeen).toBe("2020-01-01");
    expect(directory["NABIL"]?.lastSeen).toBe("2026-10-02");
  });

  it("follows a rename rather than freezing the first name it saw", async () => {
    await mergeSymbols(root, new Map([["X", "Old Name Limited"]]), "2020-01-01");
    await mergeSymbols(root, new Map([["X", "New Name Limited"]]), "2026-10-02");

    expect((await readSymbols(root))["X"]?.name).toBe("New Name Limited");
  });

  it("writes keys sorted, so a rename does not reshuffle the file", async () => {
    await writeSymbols(root, {
      ZZZ: { name: "Zed", lastSeen: "2026-01-01" },
      AAA: { name: "Aye", lastSeen: "2026-01-01" },
    });

    const text = readFileSync(path.join(root, SYMBOLS_PATH), "utf8");
    expect(text.indexOf("AAA")).toBeLessThan(text.indexOf("ZZZ"));
  });

  it("treats an unreadable file as an empty directory rather than failing", async () => {
    mkdirSync(path.dirname(path.join(root, SYMBOLS_PATH)), { recursive: true });
    writeFileSync(path.join(root, SYMBOLS_PATH), "not json at all");

    expect(await readSymbols(root)).toEqual({});
  });
});
