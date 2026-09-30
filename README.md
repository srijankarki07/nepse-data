# nepse-data

An owned, append-only archive of **NEPSE end-of-day prices**.

Every figure comes from a scraper in this repository, runs on a schedule in this
repository, and lands as a plain CSV committed to this repository. Nothing here depends
on another person's dataset being maintained.

> **Status — private, and missing its history.**
>
> The daily pipeline works and is tested. The **historical backfill does not exist yet**,
> so the archive starts from whichever day it is first run and grows forward from there.
> See [The gap](#the-gap-backfill) for what that needs and why it is not simply done.
>
> The repository is **private** deliberately, and should stay private until the whole
> archive is the output of this scraper. See [Provenance](#provenance).

## Layout

```
data/daily/2026/2026-09-30.csv    one file per trading session, ~18 KB
src/                              the scraper and the CLI
tests/                            including a real captured page as a fixture
.github/workflows/daily.yml       fetches and commits, every trading day
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
```

## The gap: backfill

**There is no history here.** The archive begins on the day it is first run.

The daily pipeline is the part that has to work forever, and it does. The backfill is the
part that has to work *once*, and it is harder than it looks — which is why it is
described rather than half-built:

- **The daily page cannot be asked for a past date.** It carries a date picker, but the
  form it sits in does `POST` to a route that answers `405 Method Not Allowed`, `?date=`
  is ignored, and the path form `404`s. Anything that fixes this needs the site's own
  JavaScript read, not its HTML.
- **The per-company pages are not regex-parseable.** `sharesansar.com/company/NABIL`
  loads and has a price-history section, but its `</table>` tags are unbalanced, so a
  reader like the one in `src/lib/html.ts` finds no rows. That needs a real HTML parser,
  which is a dependency this repository has so far avoided.

Either route is a few hours of work with the site open in front of you. Until then the
honest position is that this is an archive with a start date, not a history.

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
doing so: **the whole archive must be the output of this scraper**, including whatever
backfill lands. A history seeded from another community dataset would carry that
project's compilation into this one, and no later commit removes it from the git history.

The code is MIT (see `LICENSE`). The data is not covered by it.

## Known limitations

- **No historical backfill** — see [The gap](#the-gap-backfill).
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
