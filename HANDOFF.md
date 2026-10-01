# Handoff

Where this stands, what to do next, and — most usefully — **what has already been tried
and ruled out**, so none of it gets re-derived.

The README describes what the project *is*. This describes the state it is *in*.

---

## Do this first

Nothing is blocked. The push works, both branches are on the remote, and every workflow
has run on a runner.

The next real step is the sweep — see [Roadmap](#roadmap) — and it is worth dispatching a
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
| Repository | `github.com/srijankarki07/nepse-data` — **private**, default branch `main` |
| Branches | `feat/backfill` merged to `main` with `--no-ff` |
| Blocked on | **nothing** |
| Workflows | all three have run on a runner; the daily job is verified end to end |
| Tests | **99** passing, typecheck clean |
| Archive | **3,596 sessions**, 2011-01-01 → 2026-09-30, 38 MB, ~16 years |
| Unresolved | **7 days** out of 5,752 — all source artifacts, listed below |

---

## The seven days the archive does not have

Every one is the source's doing, not a scraper fault, and re-running will not change any
of them. They are listed here so nobody spends an afternoon rediscovering that.

| Day | Why |
| --- | --- |
| 2011-01-03 | bundled — `ADBL` appears twice, two sessions in one response |
| 2011-11-29 | bundled — `ADBL` |
| 2012-10-01 | bundled — `ACEDBL` |
| 2013-03-03 | bundled — `KBBL` |
| 2014-03-13 | bundled — `ADBL` |
| 2011-06-20 | served `2011-06-19`'s table under a `2011-06-20` heading |
| 2016-09-04 | served `2016-09-03`'s table under a `2016-09-04` heading |

The two failure modes are described in full under *Traps* below, and both are refused by
design rather than resolved by a guess. Nothing here is worth working around: the honest
position is that the source does not have those seven sessions, and the archive is more
useful with a hole that is named than with a row that was invented.

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

## What is *not* verified

- **Never run on a non-trading day in the daily job.** The no-op follows from the source
  reporting the previous session, and idempotency was verified — but not across a real
  holiday, because the archive has not yet been left alone for one.
- **The archive has not yet grown on its own.** The daily workflow has been dispatched by
  hand and worked; nothing has yet been committed by the *schedule*. Leave it a week and
  check the archive grew by the right number of sessions.
- **No adjustment for bonus shares, rights or splits**, deliberately. See the README.

The two things this section previously worried about — whether a runner can reach the
site, and whether a token survives a two-hour sweep — both have answers now: yes, and
yes. The full sweep ran to completion with **no re-authentication and no rate limiting**,
which is the strongest evidence available short of leaving it running for months.

### Verified by running it, not by reading it

| Claim | How |
| --- | --- |
| The whole archive is this scraper's output | 3,596 sessions, 2011 → 2026, no import from anywhere |
| **No two sessions hold identical prices** | Checked across all 3,596 files; see `tests/archive.test.ts` |
| No file's rows disagree with its own filename | Same check |
| A long sweep completes on a runner | 5,752 days, ~105 minutes, one job, no re-auth |
| The data reflects reality, not just the scraper | Two documented closures reproduced independently — see below |
| The daily job is a no-op when the session is archived | Dispatched by hand: 352 scrips fetched, *"Unchanged — already archived"* |

**The closures are the best check available.** The per-year counts were not tuned to
anything; they fell out of the source. And the archive independently reproduces the
Gorkha earthquake (May 2015: 6 sessions against ~20 in every neighbouring month) and the
COVID halt (April 2020: zero, with March cut short). A scraper inventing or mis-dating
data would not agree with history twice at month resolution.

---

## The traps worth not re-introducing

**`pnpm fetch` is a pnpm built-in.** It populates the package store, shadows a script of
the same name, exits `0`, and archives nothing — so the daily job would have succeeded
every day while the archive silently never grew. The CLI command is `scrape` for that
reason. It is noted in `src/cli.ts`, in `daily.yml`, and in the commit message. Do not
rename it back. (`backfill` is not a builtin, but check before adding the next one; the
failure is invisible.)

**A zero row count does not mean the market was closed.** A response truncated exactly at
the header boundary has zero rows too, and a sweep that read that as a holiday would drop
a real session out of the archive with nothing in any log to show for it. Emptiness is
only accepted on the page's own evidence — `No Record Found.` or a stated count of zero —
and anything else throws. Note the site writes **`Compaines`**, so the marker is matched
as `Comp\w*`; matching only the correct spelling would mean the evidence silently stopped
being found the day the typo is fixed.

**The source sometimes bundles two sessions into one response.** `2011-01-03` returns
every scrip twice, and the second row opens exactly where the first closed — so it is two
consecutive sessions, not a duplicated row. The parser refuses duplicate scrips by design
(that guard is what catches a genuinely malformed table), so such a day is reported as
**failed**, with the reason, rather than resolved by guessing which row is the session.
Expect a handful of these; they are the source's, and re-running will not fix them.

**The source also serves the previous session for days it has no data for.** `2011-06-20`
returns `2011-06-19`'s table byte-for-byte under a `2011-06-20` heading — same 61 scrips,
same prices. Only the heading is different, which is why a single response cannot detect
it and why the sweep digests the *table*. Such a day is refused by name, not written.

The first version of this guard aborted the whole sweep on the first repeat, and a 2011
run stopped dead at 2011-06-20 having archived 103 sessions — losing July to December to
one hole in the source. It now refuses the day and carries on, aborting only after
`MAX_CONSECUTIVE_REPEATS` (10) in a row. If a sweep ever stops that way, the endpoint has
genuinely broken.

**A floor of 10 was wrong and was measured down to 3.** Early sessions are not a smaller
version of today's market but a tiny one: January 2011 has days of 4, 5 and 6 scrips. The
first guess refused every real session in the first weeks of the range. The floor is a
compromise at these counts — truncation and a genuinely tiny market look alike — which is
exactly why the sweep reports per-year min/median/max.

**The dated route echoes the requested date in its heading.** So on that route the
heading is not independent confirmation — it is the request, read back. It still earns its
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
answers `419 CSRF token mismatch`. One request per calendar day — there is no range
parameter, and `fromdate`/`todate` are accepted and ignored.

### Routes ruled out (kept so they are not re-tried)

| Attempt | Result |
| --- | --- |
| `GET /today-share-price?date=2024-06-13` | Ignored — returns the current session |
| `GET …?fromdate=2024-06-13` | Ignored |
| `GET …?date=…&sector=` | Ignored |
| `GET …?date=…&_=<random>` with `Cache-Control: no-cache` and a browser UA | Ignored — **not** a CDN caching artefact, the parameter is genuinely unused |
| `GET /today-share-price/2024-06-13` | `404` |
| `POST /today-share-price` with `date=…` | `405 Method Not Allowed` |
| `POST` with the page's real CSRF `_token`, a cookie jar, and `X-CSRF-TOKEN` | Still `405` — this is the one that misled: the form is real, but the *route it suggests* is not the one the button uses |
| `GET /company/NABIL` | `200`, and has a price-history section, but its `</table>` tags are unbalanced, so a regex reader finds no rows |
| `GET /company-detail/NABIL` | `404` |
| `GET /sitemap.xml` | `404` |

### Leads that are now closed

- **"Read the site's JavaScript"** — done, and it was the answer. The endpoint is above.
- **`/sectorwise-share-price`** and **"Datewise Indices"** — never examined, and now
  unnecessary. The main route is dated.
- **A real HTML parser for the company pages** — dead. That route was only ever a means to
  a dated table, which `/ajaxtodayshareprice` provides directly. **Do not reopen the
  dependency question on its account**; this repository still has zero runtime
  dependencies and the backfill did not change that.

---

## Decisions already made, so they are not relitigated

- **Private now, public later** — and only once the whole archive is this scraper's
  output, backfill included. The backfill meets that condition; see the README's
  *Provenance*.
- **One file per session, not one per scrip.** Per-symbol files rewritten daily is how
  the community repositories reached several hundred MB.
- **Eight columns.** The source publishes twenty-four; the rest are derived on the page.
- **The date comes from the page's own heading**, never the clock.
- **A missing value is an empty field**, never `0`.
- **Nested tables are not separated** — recorded as a limitation in the README rather
  than fixed, because the source has none.
- **The backfill walks calendar days, not trading days.** ~5,750 requests rather than
  ~4,100. A weekday rule would cut the sweep by a quarter and silently drop the special
  sessions NEPSE has occasionally held on a Friday or Saturday.
- **`--to` never reaches today.** A session that has not closed yet is still changing, and
  the daily job would later rewrite it — the one thing the append-only rule prevents.
  Today belongs to `scrape`.
- **The backfill shares the daily job's concurrency group**, so a sweep queues the 10:15
  UTC daily run rather than racing it. A delayed daily run is visible; a lost one is not.
- **A refused day makes the run red.** Unresolved is loud here, and the report prints the
  exact `--min-rows` re-run that would fix it.

---

## Roadmap

1. **Let the schedule prove itself.** The sweep is done and the daily job has been
   dispatched by hand, but nothing has yet been committed by the *timer*. Leave it a week
   and confirm the archive grew by the right number of sessions.
2. ~~Run the real sweep.~~ Done: 5,752 days, 3,596 sessions, 38 MB, seven days unresolved
   and all seven the source's. Re-running any range is cheap — archived days are skipped
   without a request — so a fresh sweep is a safe way to pick up anything the source adds
   for the gaps above.
3. **Wire it into Bachat Khata.** Phase 2/3 of that project: the historical chart needs a
   price-history store, which is what this repository is. The backend currently sources
   prices from a community dataset instead.
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
| `nepse-data` | `main` | This repository. 3,596 sessions backfilled 2011 → today; 99 tests |

The backend's `docs/features/portfolio.md` has a **"Trying it against a real statement"**
runbook — the sequence for the first live run, what each step should show, and the two
failure modes most likely to appear. Two of its expectations look like bugs and are not: a
fresh import has **no prices at all** until Refresh is pressed, and the sector chart shows
a large `Unclassified` slice.

Note that the backend currently reads prices from `SamirWagle/Nepse-All-Scraper` via
jsDelivr. Once this repository has history, that dependency is the thing it replaces.
