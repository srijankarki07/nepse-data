/**
 * Ask GitHub to run the daily scrape, at a minute GitHub's own cron cannot promise.
 *
 * ## Why this exists at all
 *
 * `.github/workflows/daily.yml` documents the measurements: over the six sessions from
 * 2026-10-01 the `schedule` event fired between 4h28m and 9h02m late, and on one day it
 * did not fire at all. `schedule` is a best-effort queue. A `workflow_dispatch`, by
 * contrast, starts immediately, so the only thing missing was something outside GitHub
 * to press the button. This is that thing.
 *
 * ## Why it does nothing else
 *
 * The waiting, the settle gate and the completeness floor all live in the GitHub job
 * (`src/lib/readiness.ts`), where there is a full Node runtime, a disk to compare against
 * and a forty-minute budget. A cron invocation here has a much smaller allowance, and the
 * free plan does not retry a tick that throws, so the work this does is kept to a single
 * request that either succeeds or is logged as having failed. Anything that needs to be
 * retried belongs on the other side of the dispatch, where a failure is visible on the
 * Actions page.
 *
 * ## There is deliberately no `fetch` handler
 *
 * An unauthenticated URL that can start workflow runs is a way for anyone who finds it to
 * burn Actions minutes and push commits to this repository. Testing does not need one:
 * `wrangler dev --test-scheduled` invokes the cron handler directly. See README.md.
 */

const API = "https://api.github.com";

/** Pinned, so a future default cannot change what this endpoint returns. */
const API_VERSION = "2022-11-28";

/**
 * The dispatch request, built separately so the test in `wrangler dev` can exercise it
 * without a network round trip.
 *
 * The two headers that look redundant are not: GitHub answers 403 without a `user-agent`
 * and 415 without a `content-type`.
 */
export function dispatchRequest(env) {
  return {
    url:
      `${API}/repos/${env.GITHUB_REPO}/actions/workflows/${env.WORKFLOW_FILE}/dispatches`,
    init: {
      method: "POST",
      headers: {
        "user-agent": `nepse-data-dispatch (+https://github.com/${env.GITHUB_REPO})`,
        accept: "application/vnd.github+json",
        "x-github-api-version": API_VERSION,
        "content-type": "application/json",
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
      },
      body: JSON.stringify({
        ref: env.REF ?? "main",
        // Inputs must be strings, and every one of them must already be declared in the
        // workflow file or GitHub answers 422 "Unexpected inputs provided". That is why
        // the workflow change has to land on `main` before this is deployed.
        inputs: { wait: env.WAIT_MINUTES ?? "0" },
      }),
    },
  };
}

async function dispatch(env, cron) {
  const { url, init } = dispatchRequest(env);
  const response = await fetch(url, init);

  // 204 with an empty body on success.
  if (response.status !== 204) {
    // The body is included verbatim because the failures are indistinguishable without
    // it: an expired token answers 401, a renamed input answers 422, and a repository the
    // token cannot see answers 404. All three look like "it stopped working".
    throw new Error(
      `GitHub refused the dispatch (${response.status}): ${await response.text()}`,
    );
  }

  console.log(`dispatched ${env.WORKFLOW_FILE} on ${env.REF ?? "main"} via cron "${cron}"`);
}

export default {
  async scheduled(event, env, ctx) {
    // `waitUntil` rather than `await`, so the invocation is not cut short before the
    // request completes. A rejection here is recorded against the invocation, which is
    // the only signal this Worker produces. See README.md on watching for it.
    ctx.waitUntil(dispatch(env, event.cron));
  },
};
