# nepse-data

An owned, append-only archive of **NEPSE end-of-day prices**.

Every figure comes from a scraper in this repository, runs on a schedule in this
repository, and lands as a plain CSV committed to this repository. Nothing here depends
on another person's dataset being maintained.

> **Status — fifteen years of history, published.**
>
> The daily pipeline works and is tested, and the **backfill has been run**. The archive
> holds **3,596 sessions** covering 2011 to today, every one of them this scraper's own
> output. See [Backfilling history](#backfilling-history).
>
> This repository is **public**. That was a decision rather than a default — a published
> archive of these figures is redistribution, and the reasoning for and against is kept
> in [Provenance](#provenance) rather than deleted now that the answer changed.
>
> [HANDOFF.md](HANDOFF.md) has the current state and what remains unverified.

## Layout

```
data/latest.json                  the index — read this first
data/daily/2026/2026-09-30.csv    one file per trading session, ~3-20 KB
                                  3,596 files across 16 years, 38 MB in total
src/                              the scraper and the CLI
tests/                            including real captured responses as fixtures
.github/workflows/daily.yml       fetches and commits, every trading day
.github/workflows/backfill.yml    fills in the past, dispatched by hand
```

**Daily files, not per-symbol files.** One file holds every scrip the source listed that
session, written once and never touched again.

The obvious alternative — a file per ticker, appended to daily — is how the community
repositories this replaces reached several hundred megabytes. Every commit rewrites
every file, so git stores a full new copy of each one and the history grows with the
*archive* rather than with the data. A daily file costs a small fraction of that, and its
diff is always one file.

Directories are nested by year because a single one would hold several thousand files
within a decade.

## The format

Eight columns, one row per scrip, sorted by symbol:

```csv
date,symbol,open,high,low,close,volume,turnover
2026-09-30,ACLBSL,866.1,880,866.1,870,673,585967.6
2026-09-30,ADBL,307.5,308.9,305.2,307.5,83834,25731624.7
```

| Column | Meaning |
| --- | --- |
| `date` | The trading session, from the source's own heading |
| `symbol` | The NEPSE ticker, upper-cased |
| `open` `high` `low` `close` | Prices in NPR |
| `volume` | Shares traded |
| `turnover` | Value traded, in NPR |

Four things about this are deliberate and expensive to change later, since every
committed file already has them:

- **`date` is repeated on every row** rather than being implied by the filename. That
  redundancy is what makes the files safe to concatenate in any order: a consumer never
  recovers the date from a path, so the set of files reads as a dataset rather than as a
  directory of files.
- **A missing value is an empty field, never `0`.** A halted scrip has no high price. A
  zero is a claim it traded at nothing.
- **Only observed columns are stored.** The source publishes twenty-four; the rest are
  derived on the page (`Diff %`, `VWAP %`, `52 Weeks High`, and a `Conf.` figure nobody
  has explained). Storing somebody else's arithmetic would freeze a schema the source is
  free to change, and every one of those can be recomputed from these seven.
- **The date is the session the source reports, never the wall clock.** The exchange
  closes for holidays, and on a non-trading day the page still renders, showing the
  *previous* session. Stamping today's date onto that would file a day that never traded,
  and nothing downstream could tell.
- **Nothing here assumes a trading week.** NEPSE's has changed: this archive holds
  Sunday-to-Thursday sessions from 2011 to 5 April 2026, and Monday-to-Friday sessions
  from 10 April 2026 onward. The schedule therefore runs every day, and the backfill
  walks calendar days — a closed day is a no-op rather than something the code has to
  predict. See [How it runs](#how-it-runs).

## Reading it

`data/latest.json` is the index, and the first thing a consumer reads:

```json
{
  "latest": "2026-09-30",
  "previous": "2026-09-29",
  "sessions": 3596,
  "years": { "2011": 222, "2012": 229, "...": 0 }
}
```

A directory tree is not enumerable over the transports this data is read through —
`raw.githubusercontent.com` and jsDelivr both serve *files*, and neither will list a
directory — so without this a consumer has no way to learn which date to ask for. It is
the difference between a dataset and a directory of files.

`latest` and `previous` are the two most recent **sessions**, found by looking rather than
by subtracting a day, because the market is shut two days in seven and for holidays. That
pair is enough to price a holding and show its day change from a single fetch of
`data/daily/<year>/<date>.csv` — and since one file holds every scrip for that session,
that is **one request for the whole market**, rather than one per symbol.

The file is rebuilt from the filenames on disk, never patched, so it cannot drift from the
archive. It deliberately carries **no timestamp**: it is rewritten on every run, and a
timestamp would make it differ every time — including on the days nothing happened, which
is every holiday — so the daily job would find a change and commit every single day,
losing the property that a non-trading day is a no-op.

## How it runs

`.github/workflows/daily.yml`, at **10:15 UTC** — 16:00 in Kathmandu, an hour after the
close — **every day**. It installs, typechecks, tests, fetches, and commits if the file
changed.

**Every day, rather than on trading days, because the trading week is not fixed.** The
archive itself shows it changing: Sunday-to-Thursday sessions run from 2011 until 5 April
2026, and Monday-to-Friday ones from 10 April 2026 onward. A schedule written for the old
week would have quietly stopped fetching every Friday — a fifth of the year, missing with
no failure reported anywhere — which is exactly the kind of silent gap this repository
exists to avoid. A day the market was shut costs one request and commits nothing, so
running daily is much cheaper than being wrong.

A run on a holiday is a no-op rather than merely tolerable: the source reports the
previous session, whose file already exists and is byte-identical, so there is nothing to
commit. Re-running by hand is safe for the same reason.

```bash
pnpm install
pnpm scrape:dry   # fetch and report, write nothing
pnpm scrape       # fetch and write data/daily/<year>/<date>.csv
pnpm test

pnpm backfill --from 2024-06-10 --to 2024-06-14 --dry-run   # look before writing
pnpm backfill --from 2011-01-01                              # to yesterday, by default
```

## Backfilling history

The daily pipeline is the part that has to work forever. The backfill is the part that
works once, and it reaches back to **2011**.

The daily page cannot be asked for a past date: its date picker sits in a form that posts
to a route answering `405`, `?date=` is ignored, and the path form `404`s. The route that
works is not in the markup at all — it is in the site's own JavaScript, where the Search
button turns out to be a click handler rather than a form submission:

```
POST https://www.sharesansar.com/ajaxtodayshareprice
_token=<csrf>&sector=all_sec&date=YYYY-MM-DD
```

It re-renders the same `#headFixed` table the daily parser already reads. So the backfill
reuses that parser unchanged, and the HTML-parser dependency that the per-company pages
would have needed is not needed at all.

**One request per calendar day.** The endpoint has no range parameter — `fromdate` and
`todate` are accepted and silently ignored — so a sweep has to ask about every day,
including the ones the market was shut.

`pnpm backfill` runs it locally; `.github/workflows/backfill.yml` runs it a year at a
time from a runner. Both are safe to interrupt — a day already on disk is skipped without
a request, so a re-run resumes rather than repeats. Re-running is also cheap: a sweep
over a fully archived range finishes in seconds having asked the source nothing.

The sweep over `2011-01-01 → 2026-09-30` — **5,752 calendar days** at 1.1 s, about 105
minutes — produced:

| | |
| --- | --- |
| Sessions archived | **3,596** |
| Days the source reports no session | 2,149 |
| Days left unresolved | **7** |

Seven days out of 5,752 is 99.9%, and every one is the source's doing rather than a
scraper fault: five days where it publishes two consecutive sessions in one response, and
two where it serves the previous day's table under the requested date. Both are described
under [Known limitations](#known-limitations), and both are refused rather than guessed
at.

Coverage is not uniform, and the shape of it is a cross-check that the data is real
rather than merely well-formed. The market grew from a median of 74 listed scrips in 2011
to 344 in 2026, and the archive independently reproduces two documented closures: **May
2015 has 6 sessions against roughly 20 in every neighbouring month**, which is the Gorkha
earthquake, and **April 2020 has none**, with March cut short, which is the COVID trading
halt.

Three things it refuses to do, each of which would corrupt the archive quietly:

- **Treat zero rows as a holiday.** A response truncated at the header boundary also has
  zero rows. Emptiness is accepted only when the page says so itself — `No Record Found.`
  or a stated count of zero — and an unexplained empty response is an error. (The site
  spells it `Compaines`; the marker is matched loosely, or it would stop being found the
  day the typo is fixed.)
- **Trust one response about its own date.** The heading echoes the date that was asked
  for, so an endpoint serving one session under another date's heading would look
  correct. The sweep compares the *table* across days instead, refuses the day when two
  dates return identical prices, and stops only if they run consecutively — a single one
  is a hole in the source, a run of them is the endpoint failing.
- **Weaken the daily floor.** Today's market is ~350 scrips and the daily floor of 50
  guards a truncated response. History is not a smaller version of that market but a
  *tiny* one: measured directly, January 2011 has sessions of **4, 5 and 6 scrips**. So
  history has its own floor, low enough not to refuse a market that genuinely had four
  listings, and the sweep reports per-year counts so an operator can see when it is wrong.

The sweep starts at 2011 because that is where coverage begins to be usable, but the
early years are thin and the source's history is genuinely holey — 2006 has sessions with
three scrips, some *trading* days are absent entirely, and early 2011 only reaches ~84
scrips by November. Gaps in the early archive are the source's, not the scraper's, and
the sweep reports each day's outcome so the two cannot be confused.

One artifact is worth knowing about: **the source occasionally bundles two consecutive
sessions into one response.** `2011-01-03` returns every scrip twice, and the second row
opens exactly where the first closed — so it is two sessions, not a duplicate. The
archive's premise is one row per scrip per session, so such a day is reported as failed
rather than guessed at, and it is listed with its reason at the end of a sweep.

## Provenance

The data is scraped from **ShareSansar**, which republishes the exchange's end-of-day
figures. It is not obtained from NEPSE directly — the exchange's own API sits behind a
token it generates in WebAssembly, which a scheduled job cannot reasonably obtain.

**Publishing was a deliberate decision, not a default**, and the reasoning is kept on
record now that the answer has changed. For most of this project's life the repository was
private, and the reason was this: a published archive of these figures is redistribution,
NEPSE's data is NEPSE's, and ShareSansar publishes it under terms that permit reading
rather than republishing. Private removed the question entirely.

What made publishing available is the condition this repository set for itself: **the
whole archive is this scraper's output.** All 3,596 sessions came from the code here
reading the same source, and none was imported — so no other project's compilation is
carried in the history, and no later commit could have removed it if one had been.

It remains a judgement rather than a settled right. Anyone reusing this data is taking it
on the same terms it was taken here.

The code is MIT (see `LICENSE`). The data is not covered by it.

## Known limitations

- **History before 2011 is not attempted.** The source's coverage is patchy before then,
  with some trading days absent entirely. See [Backfilling history](#backfilling-history).
- **A day the market was shut leaves no file.** The archive records the sessions that
  happened, not the days that did not, so a gap in the dates is ambiguous by itself — it
  may mean the market was closed, or that a sweep has not reached that day yet.
- **The historical floor is measured, but only against the days sampled.** It is 3,
  because the smallest real session found in range has 4 scrips. At those counts a
  truncated response and a genuinely tiny market look alike, so the per-year report is
  what to check rather than the floor alone.
- **Five days could not be archived because the source bundles two sessions into one
  response.** The second row set opens exactly where the first closes, so the response
  holds two consecutive sessions rather than a duplicate. The archive's premise is one
  row per scrip per session, so these are reported by name rather than resolved by
  guessing which half is the day.
- **Two days were refused because the source served the previous day's table under the
  requested date.** Identical prices across two dates cannot be legitimate, so the day is
  refused and named. Re-running will not change it: the data for those days is not in the
  source.
- **One source.** If ShareSansar changes its markup or blocks the job, the archive stops
  growing. The failure is loud rather than silent: the parser refuses a page whose table
  or columns it cannot find, and the workflow fails.
- **Nested tables are not separated.** `src/lib/html.ts` counts table depth so it finds
  the right closing tag, but a nested table's rows would be read as the outer one's. The
  source has no nested tables; the limitation is recorded rather than hidden.
- **Numbers are stored as the source publishes them.** No adjustment for bonus shares,
  rights issues or splits is applied or inferred. Whether that matters depends on the
  question being asked of the data, and it is not a decision this repository should make
  silently.
