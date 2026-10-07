# The punctual trigger

A Cloudflare Worker whose only job is to call GitHub at 09:20 UTC and ask it to run
`daily.yml`. It exists because GitHub's own cron cannot be relied on to fire on time, and
the archive's whole promise is that a session appears within half an hour of the close.

The measurements that made the case are in the header of `.github/workflows/daily.yml` and
in `HANDOFF.md`. In short: over the six sessions from 2026-10-01 the `schedule` event was
between 4h28m and 9h02m late, and one day it never fired. `workflow_dispatch` starts
immediately; only the trigger was missing.

**This is free.** Cloudflare's Workers Free plan includes Cron Triggers, with a
one-minute minimum interval and five triggers per account. This uses two, makes one
request per tick, and takes a few milliseconds of CPU against a 50 ms allowance. No paid
feature is involved.

The Worker does not wait for anything, does not read the archive and does not write to the
repository. All of that is the GitHub job's, where there is a real runtime and a visible
failure. See `../../src/lib/readiness.ts`.

## Setup

Order matters. The `wait` input has to exist in `daily.yml` **on `main`** before the Worker
can pass it: GitHub answers `422 Unexpected inputs provided` for an input the workflow
does not declare. So the workflow change lands first, then this.

1. **Merge the workflow change to `main`.**

2. **Create the token.** A fine-grained personal access token:

   | Setting | Value |
   | --- | --- |
   | Resource owner | your own account |
   | Repository access | Only select repositories → `nepse-data` |
   | Permissions | **Actions: Read and write** only |
   | Expiration | as long as it allows |

   `Metadata: Read` is added automatically and is mandatory. `Actions: Read and write` is
   the permission that creates a workflow dispatch; do not add `Contents: write`, and do
   not reach for a classic token with `repo` unless step 5 forces it.

   If this repository ever moves under an organisation, check that **Settings → Actions →
   General → Workflow permissions** is not set to read-only, which blocks dispatches
   independently of the token.

3. **Install wrangler and set the secret.** Run from this directory, using `npx` so the
   repository's lockfile stays untouched. This directory is deliberately outside
   `tsconfig.json`'s `include` and has no build step:

   ```bash
   cd ops/dispatch
   npx wrangler login
   npx wrangler secret put GITHUB_TOKEN   # paste the token from step 2
   ```

4. **Deploy.**

   ```bash
   npx wrangler deploy
   ```

5. **Test it before trusting it.** `--test-scheduled` invokes the cron handler on demand,
   which is why this Worker needs no public URL (see below):

   ```bash
   npx wrangler dev --test-scheduled
   # in another shell:
   curl "http://localhost:8787/__scheduled?cron=20+9+*+*+*"
   ```

   Then confirm a run appeared and that it received its budget:

   ```bash
   gh run list --workflow daily.yml --limit 3
   gh run view --log --workflow daily.yml | grep -i 'Ready\|Waited'
   ```

   The run's log prints what it was actually asked to wait for. If `--wait` were not being
   plumbed through, the job would still succeed. It would just archive immediately, and
   that log line is the only thing that would show it.

### If the dispatch is refused

`403 Resource not accessible by personal access token` is a known failure of fine-grained
tokens against the dispatch endpoint. The fallbacks, in order: a classic token with `repo`
and `workflow` scopes; or a GitHub App installation with `actions: write`, which then has
to sign a JWT and is a poor fit for the free plan's CPU allowance.

The error body is logged verbatim, so the status is the diagnosis rather than a guess.

## Watching it

The Worker produces no output anyone sees unless you ask for it:

```bash
npx wrangler tail
```

There is no public endpoint, deliberately. An unauthenticated URL that starts workflow runs
would let anyone who found it spend Actions minutes and push commits to this repository, so
`worker.js` exports no `fetch` handler at all.

**The token expiring is the failure to plan for.** A fine-grained token has a maximum
lifetime, and when it lapses the Worker starts failing every tick and says nothing. Nothing
breaks immediately, because the 10:15 UTC cron backstop still archives the day, but the
data starts arriving hours late, exactly as it did before this Worker existed. The alarm
that catches it is in `daily.yml`: a run that has to archive a session more than 45 minutes
after its close fails, and a failed run emails you.

So: note the expiry date here when you set it, and re-run steps 2, 3 and 4 before it passes.

```
Token expiry: ________________
```

## What it does not protect against

- **The dispatch succeeding and the job then failing.** The API returns `204` the moment
  the run is queued; the Worker never learns the outcome. GitHub's failed-run notification
  covers the runs that fail after starting.
- **A pending run being evicted.** GitHub keeps one running and one pending run per
  concurrency group, so a backfill in progress can push the daily run to pending, where the
  later cron backstop can cancel it. Nothing is lost, because the survivor does the same
  work, but the punctual promise is broken for that day. The reasoning is in `daily.yml`
  under `concurrency:`.
- **Cloudflare or GitHub being down.** The cron backstop is the answer, and it is why the
  schedule in `daily.yml` stays even though it is unpunctual.
