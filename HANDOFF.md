# Handoff

Where this stands, what to do next, and — most usefully — **what has already been tried
and ruled out**, so none of it gets re-derived.

The README describes what the project *is*. This describes the state it is *in*.

---

## Do this first

```bash
# 1. The push was rejected: the token lacks the `workflow` scope that GitHub requires
#    before an OAuth app may create .github/workflows/*. Opens a browser flow.
gh auth refresh -h github.com -s workflow

# 2. Everything is committed and the remote is already wired up — this finishes it.
cd /run/media/srijan/Storage/Documents/nepse-data
git push -u origin main
```

Then trigger the workflow by hand once (`Actions → Daily prices → Run workflow`) to
confirm it runs on a GitHub runner before trusting the schedule.

---

## Current state

| | |
| --- | --- |
| Repository | `github.com/srijankarki07/nepse-data` — **created, private, and empty** |
| Local branch | `main`, one commit `a6bf04d`, **not pushed** |
| Remote | `origin` configured correctly |
| Blocked on | the `workflow` token scope (above) — nothing else |
| Tests | 33 passing, typecheck clean |
| First data file | `data/daily/2026/2026-09-30.csv`, 352 scrips, 18,107 bytes |

---

## What works, and how it was verified

Everything below was checked by running it, not by reading it.

| Claim | How it was verified |
| --- | --- |
| The parser reads the real page | 33 tests, most of them against a **genuine captured response** (`tests/fixtures/`, gzipped, 39 KB) |
| It finds the whole market | A live run archived **352 scrips** with all 352 priced |
| Re-running is a no-op | A second `pnpm scrape` printed *"Unchanged — already archived"* and wrote nothing |
| The file format is as documented | Byte-checked: **353 lines, 353 CRLF terminators**, `date` present on every row |
| The refusals work | Tests cover a missing date, a moved table, a renamed column, a duplicated scrip, and a partial page |

## What is *not* verified

- **The workflow has never run.** It has never been pushed, so no scheduled or manual
  run has happened. The cron expression, the pnpm setup, and the commit step are
  reasoned but unexecuted.
- **Never run on a non-trading day.** The no-op-on-a-holiday behaviour follows from the
  source keeping the previous session's date, and the idempotency check was verified —
  but not the two together across a real holiday.
- **Never run from a GitHub runner.** The fetch works from this machine. A runner's
  network path, and whether ShareSansar treats it differently, are untested.
- **No backfill exists.** The archive has exactly one day in it.

---

## The trap worth not re-introducing

`pnpm fetch` is a **pnpm built-in** that populates the package store. It shadows a script
of the same name, exits `0`, and archives nothing — so the daily job would have succeeded
every day while the archive silently never grew.

The CLI command is `scrape` for that reason. It is noted in `src/cli.ts`, in
`daily.yml`, and in the commit message. Do not rename it back.

---

## The backfill: everything already tried

The archive starts on the day it is first run. Closing that gap is the main outstanding
piece of work, and the obvious routes are exhausted.

### Ruled out, with the result of each

| Attempt | Result |
| --- | --- |
| `GET /today-share-price?date=2024-06-13` | Ignored — returns the current session |
| `GET …?fromdate=2024-06-13` | Ignored |
| `GET …?date=…&sector=` | Ignored |
| `GET …?date=…&_=<random>` with `Cache-Control: no-cache` and a browser UA | Ignored — **not** a CDN caching artefact, the parameter is genuinely unused |
| `GET /today-share-price/2024-06-13` | `404` |
| `POST /today-share-price` with `date=…` | `405 Method Not Allowed` |
| `POST` with the page's real CSRF `_token`, a cookie jar, and `X-CSRF-TOKEN` | Still `405` — the form on the page (`#frm_todayshareprice`, `method="POST"`) posts to a route that does not accept POST |
| `GET /company/NABIL` | `200`, 264 KB, and contains a "Price History" section — but its `</table>` tags are **unbalanced**, so a regex reader finds no rows |
| `GET /company-detail/NABIL` | `404` |
| `GET /sitemap.xml` | `404` |

### Leads not yet followed

- **`/sectorwise-share-price`** — linked from the daily page. Unexamined; it may accept a
  date in a way the main page does not.
- **The page mentions "Datewise Indices"** — another route that may date-parameterise.
- **Read the site's JavaScript.** The datepicker is `bootstrap-datepicker` and its submit
  handler is not in the HTML, so it is in a bundle. That is where the real mechanism is,
  and it is the most direct route to a dated fetch.
- **A real HTML parser for the company pages.** `parse5` or `cheerio` would handle the
  unbalanced tags. It means a dependency, which this repository has deliberately avoided
  — worth it if the per-company route turns out to be the only one, not before.

### If the backfill is ever seeded from another dataset

Do not, unless the repository is certain to stay private. A seeded history stays in the
git history permanently, so "make it public later" stops being available. See the
condition in the README's *Provenance*.

---

## Decisions already made, so they are not relitigated

- **Private now, public later** — and only once the whole archive is this scraper's
  output, backfill included.
- **One file per session, not one per scrip.** Per-symbol files rewritten daily is how
  the community repositories reached several hundred MB.
- **Eight columns.** The source publishes twenty-four; the rest are derived on the page.
- **The date comes from the page's own heading**, never the clock.
- **A missing value is an empty field**, never `0`.
- **Nested tables are not separated** — recorded as a limitation in the README rather
  than fixed, because the source has none.

---

## Roadmap after the backfill

1. **Prove the schedule.** One manual dispatch, then let it run a week and confirm the
   archive grew by the right number of sessions.
2. **Wire it into Bachat Khata.** This is Phase 2/3 of that project: the historical chart
   needs a price-history store, which is what this repository is. The backend currently
   sources prices from a community dataset instead.
3. **Publish a query client** (Phase 4). Package the *query layer*, not the data: npm
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
| `nepse-data` | `main` | This repository. 1 commit, not yet pushed |

The backend's `docs/features/portfolio.md` has a **"Trying it against a real statement"**
runbook — the sequence for the first live run, what each step should show, and the two
failure modes most likely to appear. Two of its expectations look like bugs and are not: a
fresh import has **no prices at all** until Refresh is pressed, and the sector chart shows
a large `Unclassified` slice.

Note that the backend currently reads prices from `SamirWagle/Nepse-All-Scraper` via
jsDelivr. Once this repository has history, that dependency is the thing it replaces.
