/**
 * The session against ShareSansar: token, cookie, retries and re-auth.
 *
 * Every test here runs against an injected `fetch`, so the suite never touches the
 * network — which matters more than usual, because these are the paths that only run
 * when the site is misbehaving, and those are exactly the paths a live test cannot
 * provoke on demand.
 */

import { describe, expect, it } from "vitest";

import {
  SystematicAuthError,
  cookieHeaderFrom,
  createPriceSession,
  extractCsrfToken,
} from "../src/sources/sharesansar-session.js";

/** A daily page carrying a token, and issuing a session cookie. */
function page(token: string, ...setCookies: string[]): Response {
  const headers = new Headers();
  for (const cookie of setCookies) headers.append("set-cookie", cookie);

  return new Response(
    `<html><body><form id="frm_todayshareprice">` +
      `<input type="hidden" name="_token" value="${token}">` +
      `</form></body></html>`,
    { status: 200, headers },
  );
}

/** A dated response carrying the table fragment. */
function dated(body = "<div>table</div>"): Response {
  return new Response(body, { status: 200 });
}

/** A queue of responses, plus a record of what was requested. */
function fakeFetch(queue: Array<Response | Error>): {
  impl: typeof fetch;
  calls: Array<{ url: string; body: string | null; headers: Record<string, string> }>;
} {
  const calls: Array<{ url: string; body: string | null; headers: Record<string, string> }> = [];

  const impl = (async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: typeof init?.body === "string" ? init.body : null,
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
    });

    const next = queue.shift();
    if (next === undefined) throw new Error("fake fetch ran out of queued responses");
    if (next instanceof Error) throw next;

    return next;
  }) as unknown as typeof fetch;

  return { impl, calls };
}

const noSleep = async (): Promise<void> => {};

describe("extractCsrfToken", () => {
  it("reads a token when name comes before value", () => {
    expect(extractCsrfToken('<input type="hidden" name="_token" value="abc123">')).toBe("abc123");
  });

  it("reads a token when value comes before name", () => {
    // Attribute order is not guaranteed, and a pattern that assumed one would return
    // null for every request in a sweep rather than failing loudly.
    expect(extractCsrfToken('<input value="abc123" type="hidden" name="_token">')).toBe("abc123");
  });

  it("accepts single quotes and odd whitespace", () => {
    expect(extractCsrfToken("<input name = '_token'  value = 'abc123' >")).toBe("abc123");
  });

  it("is not fooled by a similar attribute name", () => {
    // `\b` would match between `-` and `n` here, which is why the pattern uses (?:^|\s).
    expect(extractCsrfToken('<input data-name="_token" value="wrong">')).toBeNull();
  });

  it("returns null when there is no token at all", () => {
    expect(extractCsrfToken("<html><body>no form here</body></html>")).toBeNull();
  });
});

describe("cookieHeaderFrom", () => {
  it("keeps each cookie whole when one carries an Expires date", () => {
    // The bug this guards: `get("set-cookie")` joins with ", " and the Expires date has
    // a comma of its own, so the joined value splits in the middle of the cookie.
    const headers = new Headers();
    headers.append(
      "set-cookie",
      "laravel_session=abc.def; expires=Wed, 01 Oct 2026 00:00:00 GMT; path=/; httponly",
    );
    headers.append("set-cookie", "XSRF-TOKEN=xyz; path=/");

    expect(cookieHeaderFrom(new Response("", { headers }))).toBe(
      "laravel_session=abc.def; XSRF-TOKEN=xyz",
    );
  });

  it("returns null when the response sets no cookie", () => {
    expect(cookieHeaderFrom(new Response(""))).toBeNull();
  });
});

describe("createPriceSession", () => {
  it("opens a session once and reuses the token across days", async () => {
    const { impl, calls } = fakeFetch([page("t1"), dated(), dated()]);
    const session = createPriceSession({ fetch: impl, sleep: noSleep });

    await session.fetchDated("2024-06-13");
    await session.fetchDated("2024-06-14");

    // One page GET for two dated POSTs — the whole point of the lazy open.
    expect(calls.filter((call) => call.body === null)).toHaveLength(1);
    expect(calls).toHaveLength(3);
    expect(session.stats.opens).toBe(1);
  });

  it("sends the token, the sector and the date", async () => {
    const { impl, calls } = fakeFetch([page("t1"), dated()]);
    const session = createPriceSession({ fetch: impl, sleep: noSleep });

    await session.fetchDated("2024-06-13");

    const body = calls[1]?.body ?? "";
    expect(body).toContain("_token=t1");
    expect(body).toContain("sector=all_sec");
    expect(body).toContain("date=2024-06-13");
  });

  it("sends the session cookie it was issued", async () => {
    const { impl, calls } = fakeFetch([page("t1", "laravel_session=abc"), dated()]);
    const session = createPriceSession({ fetch: impl, sleep: noSleep });

    await session.fetchDated("2024-06-13");

    expect(calls[1]?.headers.cookie).toBe("laravel_session=abc");
  });

  it("re-authenticates on 419 and retries with the new token", async () => {
    const { impl, calls } = fakeFetch([
      page("stale"),
      new Response("", { status: 419 }),
      page("fresh"),
      dated(),
    ]);

    const session = createPriceSession({ fetch: impl, sleep: noSleep });
    await expect(session.fetchDated("2024-06-13")).resolves.toBe("<div>table</div>");

    expect(calls).toHaveLength(4);
    expect(calls[3]?.body).toContain("_token=fresh");
    expect(session.stats.opens).toBe(2);
  });

  it("aborts rather than grinding when a fresh token is rejected too", async () => {
    // Not a retry problem: authentication itself has changed, and every remaining day
    // would fail identically. Grinding through thousands of them would waste hours.
    const { impl } = fakeFetch([
      page("t1"),
      new Response("", { status: 419 }),
      page("t2"),
      new Response("", { status: 419 }),
    ]);

    const session = createPriceSession({ fetch: impl, sleep: noSleep });
    await expect(session.fetchDated("2024-06-13")).rejects.toBeInstanceOf(SystematicAuthError);
  });

  it("retries a server error and succeeds", async () => {
    const { impl } = fakeFetch([
      page("t1"),
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
      dated(),
    ]);

    const session = createPriceSession({ fetch: impl, sleep: noSleep });
    await expect(session.fetchDated("2024-06-13")).resolves.toBe("<div>table</div>");
  });

  it("retries a network error", async () => {
    const { impl } = fakeFetch([page("t1"), new Error("ECONNRESET"), dated()]);
    const session = createPriceSession({ fetch: impl, sleep: noSleep });

    await expect(session.fetchDated("2024-06-13")).resolves.toBe("<div>table</div>");
  });

  it("gives up after the attempt limit and reports the last error", async () => {
    const { impl } = fakeFetch([
      page("t1"),
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
    ]);

    const session = createPriceSession({ fetch: impl, sleep: noSleep });
    await expect(session.fetchDated("2024-06-13")).rejects.toThrow(/503/);
  });

  it("does not retry a status that will not improve", async () => {
    const { impl, calls } = fakeFetch([page("t1"), new Response("", { status: 404 })]);
    const session = createPriceSession({ fetch: impl, sleep: noSleep });

    await expect(session.fetchDated("2024-06-13")).rejects.toThrow(/404/);
    expect(calls).toHaveLength(2);
  });

  it("refuses to proceed when the daily page carries no token", async () => {
    const { impl } = fakeFetch([new Response("<html>no form</html>", { status: 200 })]);
    const session = createPriceSession({ fetch: impl, sleep: noSleep });

    await expect(session.fetchDated("2024-06-13")).rejects.toThrow(/_token/);
  });
});
