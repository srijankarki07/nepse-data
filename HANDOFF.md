# Handoff

Where this stands, what to do next, and (most usefully) **what has already been tried
and ruled out**, so none of it gets re-derived.

The README describes what the project *is*. This describes the state it is *in*.

---

## Do this first

Nothing is blocked. The push works, both branches are on the remote, and every workflow
has run on a runner.

The next real step is the sweep (see [Roadmap](#roadmap)) and it is worth dispatching a
narrow range before the full one, because the two things that can go wrong (a rate limit
at hour one, a token that dies mid-run) only show up over distance.

If a push is ever refused with `refusing to allow an OAuth App to create or update
workflow … without 'workflow' scope`, the token has lost the scope and needs
`gh auth refresh -h github.com -s workflow`. Note it is needed for *any* push carrying
`.github/workflows/*`, not just the first.

---

## Current state

| | |
| --- | --- |
| Repository | `github.com/srijankarki07/nepse-data`, **public**, default branch `main` |
| Branches | `feat/backfill` merged to `main` with `--no-ff` |
| Blocked on | **nothing** |
| Workflows | all three have run on a runner; the daily job is verified end to end |
| Tests | **136** passing, typecheck clean |
| Archive | **3,600 sessions**, 2011-01-02 → 2026-10-02, 38 MB, ~16 years |
| Index | `data/latest.json`, latest and previous session, worth reading first |
| Unresolved | **5 days** out of 5,752, all source artifacts, listed below |

**Public is recent.** The repository was private for its whole life up to this point
because publishing these figures is redistribution, and the reasoning is kept in the
README's *Provenance* rather than deleted. What changed the answer is that the archive is
now wholly this scraper's output: the condition the project had set for itself. If that
judgement is revisited, the README is where the argument lives.

---

## The five days the archive does not have

Every one is the source's doing, not a scraper fault, and re-running will not change any
of them. They are listed here so nobody spends an afternoon rediscovering that.

| Day | Why |
| --- | --- |
| 2011-01-03 | two sessions interleaved — 5 scrips listed twice, the second row opening where the first closed — and the second half contradicts what the source says for `2011-01-04` directly |
| 2013-03-03 | `KBBL` listed twice, differing in every column |
| 2014-03-13 | `BBBL` listed twice, differing only in Open (124 against 149), and absent from every neighbouring session, so nothing can arbitrate |
| 2011-06-20 | served `2011-06-19`'s table under a `2011-06-20` heading |
| 2016-09-04 | served `2016-09-03`'s table under a `2016-09-04` heading |

Two days were listed here until recently — `2012-10-01` and `2011-11-29` — and are now
archived. The source listed their scrips more than once, but with *identical* figures, so
collapsing the repeats to one row loses nothing and recovers the session. That is the only
class of repeat that is recoverable, and it was worth recovering: `2012-10-01` is a whole
91-scrip session.

The failure modes are described in full under *Traps* below, and all are refused by design
rather than resolved by a guess. Nothing here is worth working around: the honest position
is that the source does not have those five sessions, and the archive is more useful with a
hole that is named than with a row that was invented.

## What works, and how it was verified

Everything below was checked by running it, not by reading it.

| Claim | How it was verified |
| --- | --- |
| The daily parser reads the real page | 33 tests, most against a **genuine captured response** (`tests/fixtures/`, gzipped) |
| The dated route reads the past | The **same parser, unmodified**, reads a captured `2024-06-13` response: 313 rows |
| The backfill works end to end | `pnpm backfill --from 2024-06-10 --to 2024-06-14` archived **4 sessions**, and reported the Friday as no session |
| Re-running is a no-op | A second run over the same range skipped all 4 archived days **without a request** |
| A holiday is not an error | The real closed-day capture returns `null`, and only when the page says `No Record Found.` |
| Truncation is not mistaken for a holiday | A test feeds a zero-row response with no evidence and **asserts it throws** |
| The refusals work | Tests cover a missing date, a moved table, a renamed column, a duplicated scrip, a partial page, a contradicted count, a wrong-date response, and two dates returning identical prices |
| An identical repeat is collapsed, not swallowed | `2012-10-01` archived 91 scrips with 91 duplicates dropped, reported in the log and the summary; today's page still throws on the same input |
| A *differing* repeat is still refused | `2013-03-03` and `2014-03-13` still fail the day, by name |

## What is *not* verified

- **Never run on a non-trading day in the daily job.** The no-op follows from the source
  reporting the previous session, and idempotency was verified, but not across a real
  holiday, because the archive has not yet been left alone for one.
- **The daily schedule is not punctual, and cannot be relied on.** Measured, not suspected.
  Every run from `2026-10-01` to `2026-10-06` was late by **4h28m to 9h02m**, and
  `created_at == run_started_at` on each, so GitHub was *queueing* the event, not making a
  runner wait for a machine. `2026-10-02` never fired, and the session was committed only
  because the workflow was dispatched by hand; `2026-10-05` was committed at **01:02
  Kathmandu the next morning**. At 20:05 Kathmandu on `2026-10-07` the schedule had still
  not fired at all, and that day was missing from the archive.

  **Addressed, on `2026-10-07`.** A Cloudflare Worker cron (`ops/dispatch/`) now dispatches
  the workflow at 09:20 UTC, which is five minutes after the close; the GitHub schedule
  stays as a backstop at 10:15 and 14:30 UTC. The job itself was changed from "run an hour
  after the close" to "wait for the session" (`src/lib/readiness.ts`), with a settle gate
  and a completeness floor. The residual risk is the token: an expired PAT degrades
  silently to the backstop, which is late. That is why `daily.yml` fails a **cron** run that
  has to archive a session more than 45 minutes after its close: that run is the canary, and
  the failure is the alarm. A hand dispatch only warns, so that a deliberate intervention
  does not teach anyone to ignore red.

- **No session has yet been committed by the Worker.** Everything above was verified by
  running the pieces (the CLI against the live page, the readiness loop against injected
  deps), but the end-to-end path (Cloudflare tick → dispatch → commit before 09:45 UTC) has
  not completed a real cycle, because it was wired up after the `2026-10-07` close. The
  first trading day after that is the real test.
- **No adjustment for bonus shares, rights or splits**, deliberately. See the README.

The two things this section previously worried about, whether a runner can reach the
site, and whether a token survives a two-hour sweep, both have answers now: yes, and
yes. The full sweep ran to completion with **no re-authentication and no rate limiting**,
which is the strongest evidence available short of leaving it running for months.

### Verified by running it, not by reading it

| Claim | How |
| --- | --- |
| The whole archive is this scraper's output | 3,600 sessions, 2011 → 2026, no import from anywhere |
| **No two sessions hold identical prices** | Checked across all 3,600 files; see `tests/archive.test.ts` |
| No file's rows disagree with its own filename | Same check |
| A long sweep completes on a runner | 5,752 days, ~105 minutes, one job, no re-auth |
| The data reflects reality, not just the scraper | Two documented closures reproduced independently; see below |
| The daily job is a no-op when the session is archived | Dispatched by hand: 352 scrips fetched, *"Unchanged, already archived"* |

**The closures are the best check available.** The per-year counts were not tuned to
anything; they fell out of the source. And the archive independently reproduces the
Gorkha earthquake (May 2015: 6 sessions against ~20 in every neighbouring month) and the
COVID halt (April 2020: zero, with March cut short). A scraper inventing or mis-dating
data would not agree with history twice at month resolution.

---

## The traps worth not re-introducing

**`pnpm fetch` is a pnpm built-in.** It populates the package store, shadows a script of
the same name, exits `0`, and archives nothing, so the daily job would have succeeded
every day while the archive silently never grew. The CLI command is `scrape` for that
reason. It is noted in `src/cli.ts`, in `daily.yml`, and in the commit message. Do not
rename it back. (`backfill` is not a builtin, but check before adding the next one; the
failure is invisible.)

**A zero row count does not mean the market was closed.** A response truncated exactly at
the header boundary has zero rows too, and a sweep that read that as a holiday would drop
a real session out of the archive with nothing in any log to show for it. Emptiness is
only accepted on the page's own evidence (`No Record Found.` or a stated count of zero, and anything else throws. Note the site writes **`Compaines`**, so the marker is matched
as `Comp\w*`; matching only the correct spelling would mean the evidence silently stopped
being found the day the typo is fixed.

**The source sometimes lists a scrip more than once in one response — in three different
ways.** Measured by fetching every affected day, not inferred from one of them:

  - **Identical repeats.** `2012-10-01` lists all 91 of its scrips twice with the same
    figures; `2011-11-29` lists ADBL three times. There is nothing to choose between the
    copies, so on the dated route the parser **collapses** them to one row, counts them and
    reports the day. Both days are now archived. This is the only class that was ever
    recoverable, and it was worth recovering: 2012-10-01 is a whole 91-scrip session.
  - **Two sessions interleaved.** `2011-01-03` returns 5 scrips twice, the second row
    opening exactly where the first closed, so the response really does carry two
    consecutive sessions. It is still **refused**, deliberately: its second half contradicts
    what the same source says for `2011-01-04` when asked directly — it claims a close of
    131 and a high of 131, where the real session closed at 139 with a high of 139.
    Splitting it would archive a session known to be wrong.
  - **One row, two conflicting claims.** `2013-03-03` (`KBBL`, differing in every column)
    and `2014-03-13` (`BBBL`, differing only in Open — 124 against 149). Refused, because
    nothing on disk can arbitrate: `BBBL` appears in no neighbouring session at all.

An earlier version of this note claimed the doubling was always two consecutive sessions.
That is true of exactly one of the five days, and it is the one that must not be split.

The collapse is opted into by the dated route alone — today's page still refuses a repeated
scrip outright, so a malformed daily response fails the run rather than being accepted
quietly on the job nobody watches. A repeat whose values *differ* is refused on both routes.

**The source also serves the previous session for days it has no data for.** `2011-06-20`
returns `2011-06-19`'s table byte-for-byte under a `2011-06-20` heading, same 61 scrips,
same prices. Only the heading is different, which is why a single response cannot detect
it and why the sweep digests the *table*. Such a day is refused by name, not written.

**A one-day sweep cannot see that guard at all.** It compares against days it has read, and
it reads only the days inside the requested range — so `--from 2016-09-04 --to 2016-09-04`
starts with nothing to compare against and *archives* the previous session under the wrong
date. Include the preceding session: `--from 2016-09-03 --to 2016-09-04` refuses it
correctly. This matters for re-running a single day by hand, which is the obvious thing to
do when one is missing.

The first version of this guard aborted the whole sweep on the first repeat, and a 2011
run stopped dead at 2011-06-20 having archived 103 sessions, losing July to December to
one hole in the source. It now refuses the day and carries on, aborting only after
`MAX_CONSECUTIVE_REPEATS` (10) in a row. If a sweep ever stops that way, the endpoint has
genuinely broken.

**A floor of 10 was wrong and was measured down to 3.** Early sessions are not a smaller
version of today's market but a tiny one: January 2011 has days of 4, 5 and 6 scrips. The
first guess refused every real session in the first weeks of the range. The floor is a
compromise at these counts (truncation and a genuinely tiny market look alike) which is
exactly why the sweep reports per-year min/median/max.

**NEPSE's trading week changed mid-archive, and a schedule that encoded the old one
broke silently.** The archive shows Sunday-to-Thursday sessions from 2011 until
**2026-04-05**, and Monday-to-Friday sessions from **2026-04-10** onwards: the last
Sunday and the first Friday are one week apart, and the Friday sessions are full ones
(median 344 scrips, indistinguishable from Monday's 342). This was found by checking the
day-of-week distribution of the archive against a claim that the week was Monday to
Thursday, not by anything failing.

The daily cron had been written as `0-4` (Sunday through Thursday) so from April 2026
it would have stopped fetching **every Friday**, about a fifth of each year, with no
failure reported anywhere. The archive is complete only because the backfill walks
calendar days and happened to cover the period.

**The schedule now runs every day**, deliberately. A closed day costs one request and
commits nothing, because the source keeps reporting the previous session. Two wasted runs
a week is much cheaper than being wrong the next time the exchange changes its week, and
it has changed once, which is enough to know it is not a fixed fact about the world.
Nothing else in the codebase may assume a trading week either: the backfill walks
calendar days, and the parser takes the date from the page rather than deriving it.

**The general lesson: a weekday rule is a prediction about someone else's business
calendar.** This repository is built to avoid predicting: it refuses rather than guesses,
and it reads dates from the source rather than the clock, and the cron was the one place
that quietly broke that rule.

**The dated route echoes the requested date in its heading.** So on that route the
heading is not independent confirmation: it is the request, read back. It still earns its
place, because it catches the endpoint falling back to the current session, which is what
every dead route below did. What it cannot catch is an endpoint that *synthesises* the
heading while serving live prices; only the cross-day table digest in `backfill.ts` does.

---

## The backfill: the route that works

HANDOFF previously recorded this as unsolved, with the obvious routes exhausted. It was
solved by **reading the site's JavaScript rather than its HTML**.

`content.sharesansar.com/site/js/main_2.0.min.js` holds the handler:

```js
$("#btn_todayshareprice_submit").click(function() {
    var n = $("#frm_todayshareprice").serialize();
    $.ajax({ url: a + "ajaxtodayshareprice", type: "POST", data: n }).done(...)
});
```

The Search button is a click handler, not a form submission, and the endpoint is
**`POST /ajaxtodayshareprice`** with `_token`, `sector=all_sec` and `date`. It returns the
same `#headFixed` table, so the existing parser reads it unchanged.

Requires the CSRF token and session cookie from a GET of the daily page; without them it
answers `419 CSRF token mismatch`. One request per calendar day: there is no range
parameter, and `fromdate`/`todate` are accepted and ignored.

### Routes ruled out (kept so they are not re-tried)

| Attempt | Result |
| --- | --- |
| `GET /today-share-price?date=2024-06-13` | Ignored, returns the current session |
| `GET …?fromdate=2024-06-13` | Ignored |
| `GET …?date=…&sector=` | Ignored |
| `GET …?date=…&_=<random>` with `Cache-Control: no-cache` and a browser UA | Ignored, and **not** a CDN caching artefact: the parameter is genuinely unused |
| `GET /today-share-price/2024-06-13` | `404` |
| `POST /today-share-price` with `date=…` | `405 Method Not Allowed` |
| `POST` with the page's real CSRF `_token`, a cookie jar, and `X-CSRF-TOKEN` | Still `405`. This is the one that misled: the form is real, but the *route it suggests* is not the one the button uses |
| `GET /company/NABIL` | `200`, and has a price-history section, but its `</table>` tags are unbalanced, so a regex reader finds no rows |
| `GET /company-detail/NABIL` | `404` |
| `GET /sitemap.xml` | `404` |

### Leads that are now closed

- **"Read the site's JavaScript"** is done, and it was the answer. The endpoint is above.
- **`/sectorwise-share-price`** and **"Datewise Indices"**, never examined, and now
  unnecessary. The main route is dated.
- **A real HTML parser for the company pages**, dead. That route was only ever a means to
  a dated table, which `/ajaxtodayshareprice` provides directly. **Do not reopen the
  dependency question on its account**; this repository still has zero runtime
  dependencies and the backfill did not change that.

---

## Decisions already made, so they are not relitigated

- **Published once the whole archive was this scraper's output**, which the finished
  backfill made true. The reasoning for and against is in the README's *Provenance*.
- **The index carries no timestamp.** It is rewritten on every run, so one would make it
  differ every day (including every holiday) and the daily job would commit a change
  daily, losing the no-op property. Freshness is `latest`, which moves only with the
  market.
- **One file per session, not one per scrip.** Per-symbol files rewritten daily is how
  the community repositories reached several hundred MB.
- **Eight columns.** The source publishes twenty-four; the rest are derived on the page.
- **The date comes from the page's own heading**, never the clock.
- **A missing value is an empty field**, never `0`.
- **Nested tables are not separated**, recorded as a limitation in the README rather
  than fixed, because the source has none.
- **The backfill walks calendar days, not trading days.** ~5,750 requests rather than
  ~4,100. A weekday rule would cut the sweep by a quarter and silently drop the special
  sessions NEPSE has occasionally held on a Friday or Saturday.
- **`--to` never reaches today.** A session that has not closed yet is still changing, and
  the daily job would later rewrite it: the one thing the append-only rule prevents.
  Today belongs to `scrape`.
- **The backfill shares the daily job's concurrency group**, so a sweep queues the daily
  run rather than racing it. A delayed daily run is visible; a lost one is not. The cost is
  now sharper than it was: GitHub keeps one running and one *pending* run per group, and a
  newly queued run evicts the pending one. So a backfill in progress at 09:20 can push the
  punctual run to pending, where the 10:15 backstop then cancels it. The survivor does the
  same work, but the half-hour promise breaks for that day and a cancelled run notifies
  nobody. Acceptable only because backfills are hand-dispatched and rare; `queue: max` on
  both workflows is the fix if it ever stops being rare.
- **A refused day makes the run red.** Unresolved is loud here, and the report prints the
  exact `--min-rows` re-run that would fix it.

---

## Roadmap

1. **Deploy the Worker and watch one full cycle.** `ops/dispatch/README.md` has the steps.
   The workflow change has to be on `main` first, because GitHub rejects a dispatch
   carrying an input the workflow does not declare. Then confirm, on the next trading day,
   that a `workflow_dispatch` run appears at ~09:20 UTC and that the session is committed
   before 09:45. Log the token's expiry date while you are there: an expired PAT degrades
   silently to the unpunctual backstop, and the `daily.yml` latency alarm is the only thing
   that says so.
2. ~~Run the real sweep.~~ Done: 5,752 days, 3,600 sessions, 38 MB, five days unresolved
   and all seven the source's. Re-running any range is cheap, archived days are skipped
   without a request, so a fresh sweep is a safe way to pick up anything the source adds
   for the gaps above.
3. ~~Wire it into Bachat Khata.~~ **Started.** The backend has a
   `NepseArchiveQuoteProvider` that reads `data/latest.json` and the two most recent
   sessions, and it is now that project's default, the community mirror it replaces is
   kept as the rollback. Verified against the live archive. Committed on
   `feat/nepse-data-quotes` in the backend repository, **deliberately not pushed**: that
   branch sits on an unpushed five-branch portfolio stack, so pushing it would publish all
   five branches at once, and that is a decision about that project rather than a step in
   this one.
4. **Publish a query client** (Phase 4). Package the *query layer*, not the data: npm
   versions are immutable, so a data-carrying package would need republishing constantly.
   Bulk reads want GitHub Release assets, which jsDelivr does not serve.

---

## Related work, in the other two repositories

The Bachat Khata portfolio feature is complete and **also waiting on a first live run**.
Worth doing both runs together, because they exercise the same seam.

| Repo | Branch | State |
| --- | --- | --- |
| `backend` | `docs/portfolio-reference` | 5 stacked local commits. `test:cov` green, 1000 tests |
| `bachat-khata` | `35-feat-portfolio` | 1 local commit. 168 tests, build green |
| `nepse-data` | `main` | This repository. 3,600 sessions backfilled 2011 → today; 136 tests |

The backend's `docs/features/portfolio.md` has a **"Trying it against a real statement"**
runbook, the sequence for the first live run, what each step should show, and the two
failure modes most likely to appear. Two of its expectations look like bugs and are not: a
fresh import has **no prices at all** until Refresh is pressed, and the sector chart shows
a large `Unclassified` slice.

Note that the backend currently reads prices from `SamirWagle/Nepse-All-Scraper` via
jsDelivr. Once this repository has history, that dependency is the thing it replaces.
