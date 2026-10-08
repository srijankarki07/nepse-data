# nepse-data

An owned, append-only archive of **NEPSE end-of-day prices**.

Every figure comes from a scraper in this repository, runs on a schedule in this
repository, and lands as a plain CSV committed to this repository. Nothing here depends
on another person's dataset being maintained.

> **Status: fifteen years of history, published.**
>
> The daily pipeline works and is tested, and the **backfill has been run**. The archive
> holds **3,600 sessions** covering 2011 to today, every one of them this scraper's own
> output. See [Backfilling history](#backfilling-history).
>
> This repository is **public**. That was a decision rather than a default: a published
> archive of these figures is redistribution, and the reasoning for and against is kept
> in [Provenance](#provenance) rather than deleted now that the answer changed.
>
> [HANDOFF.md](HANDOFF.md) has the current state and what remains unverified.

## Layout

```
data/latest.json                  the index. Read this first
data/daily/2026/2026-09-30.csv    one file per trading session, ~3-20 KB
                                  3,600 files across 16 years, 38 MB in total
data/series/NABIL.csv             one file per ticker, its whole history, ~34 MB in total
data/closes/2025.csv              one file per year, every ticker's close, ~3.5 MB in total
data/indices/latest.json          the exchange's index levels, newest session, ~4.5 KB
data/indices/nepse.csv            one file per index, appended daily, one row a session
src/                              the scraper and the CLI
tests/                            including real captured responses as fixtures
.github/workflows/daily.yml       fetches and commits, every trading day
.github/workflows/backfill.yml    fills in the past, dispatched by hand
```

**Daily files are the record. `data/series/` and `data/closes/` are indexes over them**, and
they answer opposite questions.

A consumer that wants **one scrip across every session** reads a series file instead of one
file per trading day: measured against the package that reads this archive, a year of one scrip
costs **231 requests and 4.13 MB** through the daily files and **one request** through a series
file.

A consumer that wants **every scrip across a year** reads a closes file. It is wide where the
others are long, one row per date and one column per ticker, which is what makes a year of the
whole market fit in 450 KB. Measured over a year, against the same package: **232 requests and
4.13 MB become 2 requests and 790 KB**, and the two paths agree cell for cell on all 78,064
`(date, scrip, close)` values they hold. This is the shape a market index needs, because the
arithmetic is a mean of each scrip's day-on-day ratio.

Both are **derived**, rebuilt from `data/daily/` by `pnpm index` on every run and written only
where the bytes changed. So they cannot drift from the archive, and a holiday still commits
nothing.

The per-symbol index is also the one place the layout costs something. It rewrites several
hundred files per commit instead of one, measured at **37.5 KB of `.git` per day against
8.2 KB** for a daily file, about 9.4 MB a year, which is worth paying for what it buys. What it
does cost is reviewability: the daily data commit now touches several hundred files, so its
diff is no longer readable line by line. The per-year files cost almost nothing by comparison:
one file a day, 2.4 KB of `.git` per commit.

> **The file name is not always the ticker.** Fourteen of them contain a slash, because the
> source names a debenture for the two years it covers (`GBILD86/87`), and a slash is a
> directory separator. Those are written as `data/series/GBILD86-87.csv`. The rule is that
> every run of characters outside `A-Za-z0-9` becomes one `-`, and the ticker inside the
> file is unchanged.

Directories are nested by year because a single one would hold several thousand files
within a decade.

### `data/indices/` is the exception, and it accumulates

**NEPSE's indices cannot be computed from this archive.** They are capitalisation-weighted
over defined baskets, and the daily files hold eight columns of per-scrip prices with no
share counts, so no arrangement of them yields the real level. The only place a level exists
is the page the exchange publishes it on, on the day it is published.

So these files are the one part of the layout that is not an index over `data/daily/`.
`data/indices/<key>.csv` holds one index's history, one row per session:

```csv
date,open,high,low,close,change,percentChange,turnover
2026-10-07,2579,2579.1,2565.22,2572.34,-6.38,-0.24,3748080303.07
```

`data/indices/latest.json` holds every level for the newest session, in about 4.5 KB. That is
the hot path: a site showing today's rail should not download years of rows to answer a
question about one day. Each entry carries its own `date` rather than sharing one at the top,
so a level that could not be updated shows the session it is actually from instead of
borrowing a newer one.

**The history begins the day this was introduced**, and unlike `data/series/` it cannot be
rebuilt backwards. The archive accumulated its own history by walking the source day by day
from 2011; there is no equivalent walk for index levels, and the page only ever shows the
current session.

A row is appended only when its session is **newer** than the last one the file holds, so a
re-run, a retried workflow and a holiday all write nothing. A session already recorded is
never rewritten, which means a correction the source makes to a past session is not picked
up: what was published stays published, the same rule the daily files follow.

The key is a **fixed table, not a slug derived from the label**. Seventeen keys are in use
(`nepse`, `sensitive`, `float`, `sensitive-float`, `banking`, `development-bank`, `finance`,
`hydropower`, `microfinance`, `life-insurance`, `non-life-insurance`,
`manufacturing-and-processing`, `hotels-and-tourism`, `trading`, `investment`, `mutual-fund`,
`others`). A derived slug would follow the source through a rename and quietly start a second
file, leaving every reader of the old key with a history that simply stops, so an unknown
label fails the run instead and a person decides whether it is a rename or an addition.

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
  walks calendar days: a closed day is a no-op rather than something the code has to
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

A directory tree is not enumerable over the transports this data is read through:
`raw.githubusercontent.com` and jsDelivr both serve *files*, and neither will list a
directory, so without this a consumer has no way to learn which date to ask for. It is
the difference between a dataset and a directory of files.

`latest` and `previous` are the two most recent **sessions**, found by looking rather than
by subtracting a day, because the market is shut two days in seven and for holidays. That
pair is enough to price a holding and show its day change from a single fetch of
`data/daily/<year>/<date>.csv`, and since one file holds every scrip for that session,
that is **one request for the whole market**, rather than one per symbol.

The file is rebuilt from the filenames on disk, never patched, so it cannot drift from the
archive. It deliberately carries **no timestamp**: it is rewritten on every run, and a
timestamp would make it differ every time (including on the days nothing happened, which
is every holiday), so the daily job would find a change and commit every single day,
losing the property that a non-trading day is a no-op.

## How it runs

A session appears **within half an hour of the close**. NEPSE closes at 15:00 Kathmandu
(09:15 UTC), and the target is 09:45 UTC.

Two triggers, because one of them cannot make that promise and the other is not allowed to
be a single point of failure:

| Trigger | Fires | Waits | Role |
| --- | --- | --- | --- |
| Cloudflare Worker cron (`ops/dispatch/`) | 09:20 UTC | up to 25 min | the punctual one |
| `daily.yml` `schedule` | 10:15 and 14:30 UTC | reads once | the backstop |

**GitHub's own schedule is the backstop, not the trigger, and that is a measured decision.**
Over the six sessions from 2026-10-01 it fired between **4h28m and 9h02m late**, and on
2026-10-02 it did not fire at all. The 2026-10-05 session was committed at 01:02 the next
morning. `created_at == run_started_at` on each of those runs, so GitHub was queueing the
event, not waiting for a runner. A `workflow_dispatch` starts immediately, so the Worker
exists to press that button on time; the cron stays for the day the Worker is broken, its
token has expired, or Cloudflare is down.

**The job waits for the session rather than running at a chosen hour.** The fetch polls the
source until the session appears, so nothing has to guess when the source publishes, and a
session that lands at 09:31 is archived at 09:31. Two things guard what is written:

- **It must hold still.** After the page first reports the session, it is read again a
  minute later and the two readings must agree, compared as CSV. A table that is still
  being filled in is never archived. A page that will not settle is a failed run, not a
  written day. See `src/lib/readiness.ts`.
- **It must be big enough.** A session with fewer than half the scrips of the newest
  archived one is refused. Byte-stability alone cannot catch a table that stopped changing
  before it finished arriving, and the row floor of 50 is calibrated against a truncated
  response rather than a half-published market. The floor is set from the archive's own
  numbers: across the 177 sessions of 2026 the thinnest is 261 rows against 329 the day
  before, so 0.5 clears every real session by 29 points. `--min-completeness 0` overrides
  it.

The backstop passes `--wait 0`, so a GitHub-timed run reads once and decides instead of
sitting on a runner for half an hour. A run that starts late still archives the right day:
the loop waits for the session the *source* is showing, never for "today" as the runner's
clock sees it. That is what let the 01:02 case above recover its day rather than miss it.

**Every day, rather than on trading days, because the trading week is not fixed.** The
archive itself shows it changing: Sunday-to-Thursday sessions run from 2011 until 5 April
2026, and Monday-to-Friday ones from 10 April 2026 onward. A schedule written for the old
week would have quietly stopped fetching every Friday (a fifth of the year), with
no failure reported anywhere, which is exactly the kind of silent gap this repository
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

# What the punctual trigger runs: wait up to 25 minutes for the session, and only write
# it once two reads a minute apart agree.
pnpm scrape --wait 25 --confirm 60

pnpm backfill --from 2024-06-10 --to 2024-06-14 --dry-run   # look before writing
pnpm backfill --from 2011-01-01                              # to yesterday, by default

pnpm index:dry   # rebuild the derived indexes and report, write nothing
pnpm index       # rebuild them for real; reads data/daily/, never the network

pnpm indices:dry # read the exchange's index levels and report, write nothing
pnpm indices     # record them; one request, appends only what is new
```

**`pnpm indices` is the one index step that touches the network**, which is why it is its own
command rather than part of `pnpm index`. The daily job runs it with `continue-on-error`, and
a later step turns the run red if it failed. That is deliberate: the session is written to
disk and committed before the failure is reported, so a source outage costs a day of index
levels rather than a hole in the archive. The levels can be fetched again tomorrow; a session
cannot.

## Backfilling history

The daily pipeline is the part that has to work forever. The backfill is the part that
works once, and it reaches back to **2011**.

The daily page cannot be asked for a past date: its date picker sits in a form that posts
to a route answering `405`, `?date=` is ignored, and the path form `404`s. The route that
works is not in the markup at all: it is in the site's own JavaScript, where the Search
button turns out to be a click handler rather than a form submission:

```
POST https://www.sharesansar.com/ajaxtodayshareprice
_token=<csrf>&sector=all_sec&date=YYYY-MM-DD
```

It re-renders the same `#headFixed` table the daily parser already reads. So the backfill
reuses that parser unchanged, and the HTML-parser dependency that the per-company pages
would have needed is not needed at all.

**One request per calendar day.** The endpoint has no range parameter (`fromdate` and
`todate` are accepted and silently ignored), so a sweep has to ask about every day,
including the ones the market was shut.

`pnpm backfill` runs it locally; `.github/workflows/backfill.yml` runs it a year at a
time from a runner. Both are safe to interrupt: a day already on disk is skipped without
a request, so a re-run resumes rather than repeats. Re-running is also cheap: a sweep
over a fully archived range finishes in seconds having asked the source nothing.

The sweep over `2011-01-01 → 2026-09-30`, **5,752 calendar days** at 1.1 s (about 105
minutes) produced:

| | |
| --- | --- |
| Sessions archived | **3,600** |
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
  zero rows. Emptiness is accepted only when the page says so itself, `No Record Found.`
  or a stated count of zero, and an unexplained empty response is an error. (The site
  spells it `Compaines`; the marker is matched loosely, or it would stop being found the
  day the typo is fixed.)
- **Trust one response about its own date.** The heading echoes the date that was asked
  for, so an endpoint serving one session under another date's heading would look
  correct. The sweep compares the *table* across days instead, refuses the day when two
  dates return identical prices, and stops only if they run consecutively: a single one
  is a hole in the source, a run of them is the endpoint failing.
- **Weaken the daily floor.** Today's market is ~350 scrips and the daily floor of 50
  guards a truncated response. History is not a smaller version of that market but a
  *tiny* one: measured directly, January 2011 has sessions of **4, 5 and 6 scrips**. So
  history has its own floor, low enough not to refuse a market that genuinely had four
  listings, and the sweep reports per-year counts so an operator can see when it is wrong.

The sweep starts at 2011 because that is where coverage begins to be usable, but the
early years are thin and the source's history is genuinely holey: 2006 has sessions with
three scrips, some *trading* days are absent entirely, and early 2011 only reaches ~84
scrips by November. Gaps in the early archive are the source's, not the scraper's, and
the sweep reports each day's outcome so the two cannot be confused.

One artifact is worth knowing about: **the source sometimes lists a scrip more than once in
one response**, in three different ways, and only one of them is recoverable. Where the
repeats carry identical figures — `2012-10-01` lists all 91 of its scrips twice — they are
collapsed to a single row and the day is archived. Where the response instead holds two
consecutive sessions interleaved (`2011-01-03`, whose second row opens exactly where the
first closed), or two rows that disagree about one session (`2013-03-03`, `2014-03-13`),
the day is reported as failed rather than guessed at, and listed with its reason at the end
of a sweep. HANDOFF.md sets out which is which, and why.

## Provenance

The data is scraped from **ShareSansar**, which republishes the exchange's end-of-day
figures. It is not obtained from NEPSE directly: the exchange's own API sits behind a
token it generates in WebAssembly, which a scheduled job cannot reasonably obtain.

**Publishing was a deliberate decision, not a default**, and the reasoning is kept on
record now that the answer has changed. For most of this project's life the repository was
private, and the reason was this: a published archive of these figures is redistribution,
NEPSE's data is NEPSE's, and ShareSansar publishes it under terms that permit reading
rather than republishing. Private removed the question entirely.

What made publishing available is the condition this repository set for itself: **the
whole archive is this scraper's output.** All 3,600 sessions came from the code here
reading the same source, and none was imported, so no other project's compilation is
carried in the history, and no later commit could have removed it if one had been.

It remains a judgement rather than a settled right. Anyone reusing this data is taking it
on the same terms it was taken here.

The code is MIT (see `LICENSE`). The data is not covered by it.

## Known limitations

- **History before 2011 is not attempted.** The source's coverage is patchy before then,
  with some trading days absent entirely. See [Backfilling history](#backfilling-history).
- **A day the market was shut leaves no file.** The archive records the sessions that
  happened, not the days that did not, so a gap in the dates is ambiguous by itself: it
  may mean the market was closed, or that a sweep has not reached that day yet.
- **The historical floor is measured, but only against the days sampled.** It is 3,
  because the smallest real session found in range has 4 scrips. At those counts a
  truncated response and a genuinely tiny market look alike, so the per-year report is
  what to check rather than the floor alone.
- **Five days could not be archived, and none of them can be.** Three contain a scrip
  listed twice with *differing* figures — either two consecutive sessions interleaved, or
  two rows making conflicting claims about one session — where choosing between them would
  be a guess. The archive's premise is one row per scrip per session, so these are reported
  by name rather than resolved. Two further days that were once listed here
  (`2012-10-01`, `2011-11-29`) have since been recovered: their repeats carried identical
  figures, so collapsing them loses nothing.
- **Two days were refused because the source served the previous day's table under the
  requested date.** Identical prices across two dates cannot be legitimate, so the day is
  refused and named. Re-running will not change it: the data for those days is not in the
  source.
- **One source.** If ShareSansar changes its markup or blocks the job, the archive stops
  growing. The failure is loud rather than silent: the parser refuses a page whose table
  or columns it cannot find, and the workflow fails.
- **Index levels have no history before October 2026.** NEPSE's indices are
  capitalisation-weighted over baskets the archive holds no share counts for, so
  `data/indices/` **accumulates** from the day it was introduced rather than being rebuilt
  backwards. A chart of an index before that date cannot be produced from this repository,
  and no amount of re-scraping will change that: the page only ever shows the current
  session.
- **Nested tables are not separated.** `src/lib/html.ts` counts table depth so it finds
  the right closing tag, but a nested table's rows would be read as the outer one's. The
  source has no nested tables; the limitation is recorded rather than hidden.
- **Numbers are stored as the source publishes them.** No adjustment for bonus shares,
  rights issues or splits is applied or inferred. Whether that matters depends on the
  question being asked of the data, and it is not a decision this repository should make
  silently.
