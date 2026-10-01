/**
 * The handful of things ShareSansar requires before it will answer a dated request.
 *
 * ## Why this exists at all
 *
 * The daily page is a plain GET. The dated route is not: it is the AJAX endpoint behind
 * the page's Search button, and it refuses anything without the CSRF token and session
 * cookie that the daily page hands out. A bare POST comes back `419 CSRF token
 * mismatch`, which is a clear enough refusal but not one a naive scraper would know to
 * recover from.
 *
 * ## Why there is no cookie library
 *
 * `fetch` has no cookie jar, and this does not add one — deliberately. A jar would be
 * the wrong shape: exactly one cookie matters, it comes from exactly one place, and it
 * is sent to exactly one host. Keeping it in a local variable means there is no jar to
 * configure, no policy to get wrong, and no dependency for a supply-chain surface this
 * repository does not need. The same reasoning is why the HTML reader is hand-rolled.
 *
 * ## Why the token is fetched lazily and only re-fetched on 419
 *
 * A sweep makes thousands of requests over about two hours. Fetching the daily page
 * before every dated request would double that — the whole sweep for a token that in
 * practice never expires, because a request every second keeps the session alive.
 * Re-authenticating when the server actually says `419` gets the correctness of the
 * eager approach at the cost of the eager approach's traffic.
 *
 * A `419` immediately after a *fresh* token, though, is not a retry problem: it means
 * the site has changed how it authenticates, and every remaining day would fail the
 * same way. That aborts the sweep rather than grinding through it.
 */

import { REQUEST_TIMEOUT_MS, TODAY_SHARE_PRICE_URL, USER_AGENT } from "./sharesansar.js";

/** The dated route, found in the site's own JavaScript rather than in any documentation. */
export const DATED_PRICE_URL = "https://www.sharesansar.com/ajaxtodayshareprice";

/** How many times one day is attempted before it is recorded as failed. */
export const MAX_ATTEMPTS = 3;

/** Waited before each attempt. The first is immediate; the rest back off. */
const BACKOFF_MS = [0, 2_000, 8_000];

/** Worth trying again. `419` is handled separately, since it needs a new token first. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * The site rejected a token it had just issued.
 *
 * Distinct from an ordinary failure because it is not about the day that happened to be
 * in flight: it means authentication itself has changed, so the sweep should stop rather
 * than spend another two hours discovering the same thing several thousand times.
 */
export class SystematicAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SystematicAuthError";
  }
}

/**
 * The CSRF token from the daily page, or `null` if it is not there.
 *
 * Read by scanning `<input>` tags rather than by matching one fixed string, because the
 * attribute order is not guaranteed — a pattern that assumed `name` came before `value`
 * would break the day the source reordered them, and would break *silently* by
 * returning `null` for every request in the sweep.
 *
 * The `(?:^|\s)` before each attribute name is load-bearing: `\b` would also match
 * inside `data-name="_token"`, which is a different attribute entirely.
 */
export function extractCsrfToken(html: string): string | null {
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = match[0];

    if (!/(?:^|\s)name\s*=\s*["']_token["']/i.test(tag)) continue;

    const value = /(?:^|\s)value\s*=\s*(["'])([\s\S]*?)\1/i.exec(tag);
    if (value?.[2] !== undefined) return value[2];
  }

  return null;
}

/**
 * The `Cookie` header for this response's session, or `null` if it set none.
 *
 * `getSetCookie()` rather than `get("set-cookie")`, and not by preference: the latter
 * joins multiple headers with `", "`, and a cookie carrying `Expires=Wed, 01 Oct 2026
 * 00:00:00 GMT` contains a comma of its own. Splitting the joined string would cut that
 * cookie in half and send a truncated value — a bug that would present as an
 * intermittent login failure rather than as anything pointing here.
 *
 * Only the name and value are kept; expiry, path and flags are the browser's business
 * and this is not a browser. The whole run is one session and it is discarded after.
 */
export function cookieHeaderFrom(response: Response): string | null {
  const cookies = response.headers.getSetCookie();
  if (cookies.length === 0) return null;

  const pairs = cookies
    .map((cookie) => cookie.split(";")[0]?.trim() ?? "")
    .filter((pair) => pair !== "");

  return pairs.length === 0 ? null : pairs.join("; ");
}

export interface PriceSessionOptions {
  /** Injected so tests exercise the retry logic without touching the network. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
}

export interface PriceSession {
  /** The dated response body for one calendar day. Throws rather than returning junk. */
  fetchDated(date: string): Promise<string>;
  /** Requests issued, and how many times a new token was obtained. */
  readonly stats: { requests: number; opens: number };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Best-effort read of a body that is about to be discarded, to release the socket. */
async function drain(response: Response): Promise<void> {
  await response.arrayBuffer().catch(() => {});
}

/**
 * A session against ShareSansar: one token, one cookie, and a dated fetch that recovers
 * from an expired token on its own.
 */
export function createPriceSession(options: PriceSessionOptions = {}): PriceSession {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const userAgent = options.userAgent ?? USER_AGENT;

  let token: string | null = null;
  let cookie: string | null = null;

  const stats = { requests: 0, opens: 0 };

  /** Fetches the daily page and takes the token and cookie it hands out. */
  async function open(): Promise<void> {
    stats.requests++;
    stats.opens++;

    const response = await doFetch(TODAY_SHARE_PRICE_URL, {
      headers: { "user-agent": userAgent, accept: "text/html" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(
        `ShareSansar returned ${response.status} ${response.statusText} ` +
          "while opening a session.",
      );
    }

    const html = await response.text();
    const found = extractCsrfToken(html);

    if (found === null) {
      throw new Error(
        "The daily page carried no _token, so a dated request cannot be authorised. " +
          "The page's markup has probably changed.",
      );
    }

    token = found;
    cookie = cookieHeaderFrom(response);
  }

  async function post(date: string): Promise<Response> {
    stats.requests++;

    return doFetch(DATED_PRICE_URL, {
      method: "POST",
      headers: {
        "user-agent": userAgent,
        accept: "*/*",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
        referer: TODAY_SHARE_PRICE_URL,
        ...(cookie === null ? {} : { cookie }),
      },
      body: new URLSearchParams({
        _token: token ?? "",
        sector: "all_sec",
        date,
      }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  async function fetchDated(date: string): Promise<string> {
    if (token === null) await open();

    let attempt = 0;
    let refreshed = false;
    let lastError: Error | null = null;

    while (attempt < MAX_ATTEMPTS) {
      if (attempt > 0) await sleep(BACKOFF_MS[attempt] ?? 0);
      attempt++;

      let response: Response;
      try {
        response = await post(date);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }

      if (response.status === 419) {
        await drain(response);

        if (refreshed) {
          throw new SystematicAuthError(
            `ShareSansar rejected a freshly issued token twice in a row (${date}). ` +
              "Authentication has changed, so every remaining day would fail the same way.",
          );
        }

        refreshed = true;
        await open();
        // Re-authenticating is not an attempt at the *day*; spend none of the retries on it.
        attempt--;
        continue;
      }

      if (RETRYABLE_STATUS.has(response.status)) {
        await drain(response);
        lastError = new Error(
          `ShareSansar returned ${response.status} ${response.statusText} for ${date}.`,
        );
        continue;
      }

      if (!response.ok) {
        await drain(response);
        throw new Error(
          `ShareSansar returned ${response.status} ${response.statusText} for ${date}.`,
        );
      }

      return await response.text();
    }

    throw lastError ?? new Error(`Gave up on ${date} after ${MAX_ATTEMPTS} attempts.`);
  }

  return { fetchDated, stats };
}
