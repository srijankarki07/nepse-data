# nepse-data

An owned, append-only archive of **NEPSE end-of-day prices**.

Every figure comes from a scraper in this repository, runs on a schedule in this
repository, and lands as a plain CSV committed to this repository. Nothing here depends
on another person's dataset being maintained.

> **Status — backfillable, and not yet pushed.**
>
> The daily pipeline works and is tested, and so does the **backfill**, which can reach
> back to 2011 — so the archive no longer has to start on the day it was first run. See
> [Backfilling history](#backfilling-history).
>
> The repository is **private** deliberately, and should stay private until the whole
> archive is the output of this scraper. The backfill is what makes that condition
> reachable; see [Provenance](#provenance).
>
> **Not yet pushed**, and neither workflow has run. [HANDOFF.md](HANDOFF.md) has the one
> blocker and the current state.

## Layout

```
data/daily/2026/2026-09-30.csv    one file per trading session, ~18 KB
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
- **The date is the session the source reports, never the wall clock.** NEPSE trades
  Sunday to Thursday and closes for holidays; on a non-trading day the page still
  renders, showing the *previous* session. Stamping today's date onto that would file a
  day that never traded, and nothing downstream could tell.

## How it runs

`.github/workflows/daily.yml`, at **10:15 UTC** — 16:00 in Kathmandu, an hour after the
close — on **Sunday through Thursday**, which is the NEPSE trading week, not the
Monday-to-Friday one. It installs, typechecks, tests, fetches, and commits if the file
changed.

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
including the ones the market was shut. The full range is about **5,750 requests at
1.1 s, so roughly 105 minutes**.

`pnpm backfill` runs it locally; `.github/workflows/backfill.yml` runs it a year at a
time from a runner. Both are safe to interrupt — a day already on disk is skipped without
a request, so a re-run resumes rather than repeats.

Three things it refuses to do, each of which would corrupt the archive quietly:

- **Treat zero rows as a holiday.** A response truncated at the header boundary also has
  zero rows. Emptiness is accepted only when the page says so itself — `No Record Found.`
  or a stated count of zero — and an unexplained empty response is an error. (The site
  spells it `Compaines`; the marker is matched loosely, or it would stop being found the
  day the typo is fixed.)
- **Trust one response about its own date.** The heading echoes the date that was asked
  for, so an endpoint serving the present under a past heading would look correct. The
  sweep compares the *table* across days instead, and aborts if two dates return the same
  prices.
- **Weaken the daily floor.** Today's market is ~350 scrips, and the daily floor of 50
  guards a truncated response. In 2011 the whole market was around 70, so history has its
  own lower floor — and the sweep reports per-year scrip counts so that floor can be set
  from measurement rather than from a guess.

The sweep starts at 2011 because that is where coverage becomes real. Before it, the
history is sparse and patchy — 2006 has sessions with three scrips, and some *trading*
days are absent entirely — so an earlier sweep would spend thousands of requests
recovering a handful of near-empty files, and leave gaps that look like scraper bugs but
are the source's.

## Provenance

The data is scraped from **ShareSansar**, which republishes the exchange's end-of-day
figures. It is not obtained from NEPSE directly — the exchange's own API sits behind a
token it generates in WebAssembly, which a scheduled job cannot reasonably obtain.

**This is why the repository is private.** A public archive is redistribution, and
nothing in the chain grants that: NEPSE's data is theirs, and ShareSansar publishes it
under terms that permit reading rather than republishing. Keeping it private removes the
question entirely, and the value — a dataset this project owns and can rely on — does not
depend on it being public.

It can be made public later without changing any code, and there is a condition for
doing so: **the whole archive must be the output of this scraper**, including the
backfill. A history seeded from another community dataset would carry that project's
compilation into this one, and no later commit removes it from the git history.

The backfill meets that condition. It is this repository's scraper reading the same
source — not an import from anywhere else — so the archive becomes publishable once the
sweep has run, without a single byte of somebody else's compilation entering the history.

The code is MIT (see `LICENSE`). The data is not covered by it.

## Known limitations

- **History before 2011 is not attempted.** The source's coverage is patchy before then,
  with some trading days absent entirely. See [Backfilling history](#backfilling-history).
- **A day the market was shut leaves no file.** The archive records the sessions that
  happened, not the days that did not, so a gap in the dates is ambiguous by itself — it
  may mean the market was closed, or that a sweep has not reached that day yet.
- **The historical floor is a starting point, not a calibration.** It is set well below
  any known session in range and is meant to be adjusted with `--min-rows` from the
  per-year counts a sweep reports.
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
