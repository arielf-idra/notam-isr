# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo does

Scrapes Israel's Airports Authority (IAA) live NOTAM page and republishes the
full ICAO-format text of every active NOTAM as `notams.json`, refreshed on a
schedule by GitHub Actions and served for free via `raw.githubusercontent.com`.
See [README.md](README.md) for the consumer-facing details (JSON shape,
`position` field semantics, hosting).

## Commands

```bash
npm install
npx playwright install --with-deps chromium   # one-time browser install
npm run scrape                                 # runs scrape.mjs, writes notams.json
```

There is no build step, lint config, or test suite. `npm run scrape` against
the live site *is* the verification method — there's nothing to unit test in
isolation since the entire risk surface is "does this still work against the
real, changeable third-party page." A full run takes ~50–60s (~90 NOTAMs,
sequential, ~500–700ms per row).

## Architecture

Single-purpose scraper, no framework:

- **`scrape.mjs`** — the entire scraper and parser, one file. Launches
  headless Chromium (Playwright), navigates to the IAA NOTAM page, and
  clicks each row's "+" icon sequentially. Each click triggers an ASP.NET
  UpdatePanel AJAX partial postback back to the same page URL; the response
  body contains a `f_buildMoreMsgInfo('<Msg ...>...</Msg>')` script call
  holding the full ICAO-format NOTAM text (the on-page table only shows a
  silently truncated preview). The script matches that response per-row via
  `page.waitForResponse`, regex-extracts the `<Msg>` XML, and hand-parses it
  (no XML library — the structure is simple and fixed) into structured
  fields: Q-line (FIR/Qcode/traffic/purpose/scope/altitude/summary
  position), A) affected locations, full E) text, F)/G) altitude limits, and
  a best-available `position` (prefers a `CENTERED ON PSN ... RADIUS` phrase
  parsed out of the E) text over the Q-line's minute-rounded summary
  position, but always keeps the Q-line one as a guaranteed fallback since
  every ICAO NOTAM has one). Per-row failures retry once, then fall back to
  the truncated preview text with `fullTextAvailable: false` rather than
  aborting the whole run.
  - Refuses to write `notams.json` (exits non-zero instead) if the scraped
    row count is below `NOTAM_MIN_ROWS` (env var, default `10`) — this is
    the sanity gate that keeps a broken scrape from ever reaching the
    published file.
- **`.github/workflows/scrape.yml`** — cron (every 10 min) + manual
  `workflow_dispatch`. Runs `npm run scrape`, then commits/pushes
  `notams.json` **only if the scrape step succeeded** (a failed step halts
  the job before the commit step runs, per default GitHub Actions
  behavior) **and** the file actually changed. This means a scrape failure
  or WAF change leaves the last known-good `notams.json` published as-is —
  never overwrite good data with a broken/empty result.
- **`index.html`** / **`viewer.js`** — static, dependency-free viewer. Fetches
  `./notams.json` client-side and renders a searchable list; meant to be
  served via GitHub Pages from the repo root. No build step; edit and reload
  directly.

## Key gotchas when touching the scraper

- The IAA page sits behind a Reblaze/Imperva bot-management challenge. A
  real Playwright + Chromium browser (headless is fine, confirmed working)
  clears it automatically; plain HTTP clients (curl, fetch, axios) do not
  and will get redirect-looped. Don't try to "optimize" this into a
  non-browser HTTP client.
- The per-row AJAX response is matched by URL + method + body content
  (`f_buildMoreMsgInfo` + the row's own `NotamID`) via `page.waitForResponse`,
  set up *before* the click to avoid a race. If IAA changes the postback
  mechanism, this is the first thing to re-verify against a live run.
- `A)` and `F)`/`G)` NOTAM lines frequently share their `MsgText` line with
  the following field (e.g. `"A) LLLL B) 2608230245 C) 2608312059"`, or end
  with the NOTAM's own closing paren from the outer `(...)` wrapper (e.g.
  `"F) GND G) 2200FT AMSL)"`) — the parsing in `scrape.mjs` has to split on
  the next field marker and strip that trailing paren rather than assuming a
  field ends at end-of-line.

## Security notes for future changes

Every NOTAM field is untrusted third-party scraped data (see the
[Security](README.md#security) section in the README for the full rationale).
When touching `viewer.js`, every value interpolated into `innerHTML` must go
through `escapeHtml()` — there is no exception, since `index.html`'s CSP
(`script-src 'self'`, no inline scripts) is the only backstop against an
escaping bug. If you add new JS to the page, it must live in an external
`.js` file for the same reason — an inline `<script>` block would violate
that CSP. When touching `.github/workflows/scrape.yml`, keep third-party
Actions pinned to a commit SHA (not a tag) and keep the workflow off
`pull_request`/`pull_request_target` triggers, since it holds
`contents: write`.
