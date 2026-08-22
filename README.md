# notam-isr

An unofficial, machine-readable republish of Israel's Airports Authority (IAA)
live NOTAM feed as a single clean JSON file, refreshed automatically every 10
minutes and hosted for free via `raw.githubusercontent.com`. Acts as a
lightweight "NOTAM API" for anything that wants to consume active Israeli
NOTAMs client-side — no server, no API key, no CORS proxy.

A hosted [HTML viewer](index.html) is also included for browsing the data by eye
(see [Viewing the data](#viewing-the-data) below).

> **Not a substitute for an official pre-flight briefing.** This is an
> unofficial hobby project. Always confirm NOTAM information through official
> channels (e.g. IAA AeroInfo, a licensed briefing service) before flying.

## Why this exists

The IAA's live NOTAM page
([ext.iaa.gov.il/aeroinfo/AeroInfo.aspx?msgType=Notam](https://ext.iaa.gov.il/aeroinfo/AeroInfo.aspx?msgType=Notam))
is public and requires no login, but:

- It sits behind a Reblaze/Imperva bot-management challenge that blocks plain
  HTTP clients (curl, fetch, most scraping libraries) — only a real browser
  gets through.
- It has no CORS headers, so it can't be fetched directly from a browser-side
  app anyway.
- The table view shows only a **silently truncated** preview of each NOTAM's
  text (cut at roughly 165–180 characters, no ellipsis). The full ICAO-format
  text is only available by clicking a "+" icon per row, which fires an AJAX
  partial postback.

This repo automates that: a headless browser (Playwright + Chromium) loads
the page, clicks through all ~90 NOTAM rows, extracts the full ICAO-format
text from each AJAX response, parses it into structured fields, and publishes
the result as `notams.json` — reachable from any browser via
`raw.githubusercontent.com` (which does send `Access-Control-Allow-Origin: *`).

## Consuming the data

```
https://raw.githubusercontent.com/arielf-idra/notam-isr/main/notams.json
```

Fetch it directly, client-side, from any browser or app:

```js
const res = await fetch('https://raw.githubusercontent.com/arielf-idra/notam-isr/main/notams.json');
const { generatedAt, disclaimer, count, notams } = await res.json();
```

Refresh interval: **every 10 minutes** (GitHub Actions cron), plus manual
runs. Check `generatedAt` in the payload to see how fresh the data actually
is at fetch time — it's set to when the scrape run **started** reading the
source page, not when it finished. A full run walks ~90 rows sequentially
and takes ~50-60s, so using the finish time would understate staleness if
something on the source page changed partway through; the start time is the
conservative "this snapshot is true as of" bound.

### JSON shape

```jsonc
{
  "generatedAt": "2026-08-22T07:30:34.546Z",
  "source": "https://ext.iaa.gov.il/aeroinfo/AeroInfo.aspx?msgType=Notam",
  "disclaimer": "Informational only. Not a substitute for an official pre-flight briefing.",
  "count": 90,
  "notams": [
    {
      "id": "C1780/26",
      "location": "LLLL",
      "airfield": "Tel-Aviv FIR",
      "msgNumber": "2049537",
      "fromDate": "2026-08-23T02:45:00Z",
      "toDate": "2026-08-31T20:59:00Z",
      "createDate": "2026-08-20T13:14:20Z",
      "affected": ["LLLL"],
      "qLine": {
        "fir": "LLLL",
        "qcode": "QWCLW",
        "traffic": "IV",
        "purpose": "M",
        "scope": "W",
        "lowerLimitFl": "000",
        "upperLimitFl": "022",
        "positionToken": "3123N03446E001",
        "position": { "lat": 31.383333, "lon": 34.766667, "radiusNm": 1 }
      },
      "eText": "CAPTIVE BALLOON WILL TAKE PLACE AT RAHAT, UP TO 1,700FT AMSL. AN AREA WI 0.4NM RADIUS CENTERED ON PSN 312252N0344541E CLSD FM GND UP TO 2,200FT AMSL TO ALL FLT INCLUDING AGRICULTURE FLT. CTN ADZ",
      "lowerLimit": "GND",
      "upperLimit": "2200FT AMSL",
      "position": { "lat": 31.381111, "lon": 34.761389, "radiusNm": 0.4, "source": "e_text" },
      "rawText": "(C1780/26 NOTAMN\nQ) LLLL/QWCLW/IV/M  /W /000/022/3123N03446E001\nA) LLLL B) 2608230245 C) 2608312059\nE) CAPTIVE BALLOON WILL TAKE PLACE AT RAHAT, UP TO 1,700FT AMSL.\nAN AREA WI 0.4NM RADIUS CENTERED ON PSN 312252N0344541E\nCLSD FM GND UP TO 2,200FT AMSL TO ALL FLT INCLUDING\nAGRICULTURE FLT.\nCTN ADZ\nF) GND G) 2200FT AMSL)",
      "fullTextAvailable": true
    }
  ]
}
```

### About the `position` field — read this before plotting anything

Every NOTAM in this dataset carries a `position` object with `lat`, `lon`,
and `radiusNm` (nautical miles), tagged with a `source`:

- **`"q_line"`** — derived from the Q-line's mandatory summary position
  (e.g. `3123N03446E001`). Per ICAO Annex 15, *every* NOTAM has one, even
  boundary/polygon NOTAMs whose free text lists multiple vertices that can't
  be safely reduced to a single point. This is a **guaranteed fallback**:
  every NOTAM in this feed has a plottable position/radius, but it is only
  precise to the nearest arc-minute (~1.85 km) and is a rough summary, not
  necessarily the true center of the affected area.
- **`"e_text"`** — parsed from a `CENTERED ON PSN <coord> ... RADIUS`
  phrase in the full free-text `E)` field, when present. This is generally
  more precise than the Q-line (down to arc-seconds when given) and is
  preferred whenever it's parseable.

Multi-vertex boundary NOTAMs (`"BTN [THE] FLW PSN(S) ..."`) are **not**
parsed into a polygon — only the single-point/radius cases above. For those,
you get the Q-line fallback circle only, which is intentionally conservative
rather than guessing at a shape.

`qLine.lowerLimitFl` / `upperLimitFl` are the Q-line's flight-level range
(often `000`/`999` and not meaningful — prefer the top-level `lowerLimit` /
`upperLimit` strings, parsed from the `F)`/`G)` lines, when present).

## Viewing the data

[`index.html`](index.html) is a small static page that fetches `notams.json`
and renders it as a searchable, human-readable list. To publish it via GitHub
Pages:

1. Repo **Settings → Pages**.
2. Under "Build and deployment", set **Source** to "Deploy from a branch".
3. Branch: `main`, folder: `/ (root)`. Save.
4. After the first deploy (usually under a minute), the page is live at
   `https://arielf-idra.github.io/notam-isr/`.

The page re-fetches `notams.json` on every load, so it always reflects
whatever was last committed by the scrape workflow.

## How it works

- [`scrape.mjs`](scrape.mjs) launches headless Chromium via Playwright,
  loads the IAA NOTAM page (passing its bot-management challenge, which a
  real browser clears without issue), then sequentially clicks each row's
  "+" icon and captures the AJAX response containing the full
  `f_buildMoreMsgInfo('<Msg>...</Msg>')` payload. Each payload is parsed into
  the structured fields described above and written to `notams.json`.
- As a sanity check, the script refuses to write output (and exits non-zero)
  if it scrapes fewer than a minimum number of NOTAMs
  (`NOTAM_MIN_ROWS`, default `10`) — a low count almost always means the
  scrape broke (WAF change, layout change) rather than a genuinely quiet day.
- [`.github/workflows/scrape.yml`](.github/workflows/scrape.yml) runs this on
  a schedule (every 10 minutes, plus manual `workflow_dispatch`), and only
  commits/pushes `notams.json` if the scrape succeeded. **If the scrape fails
  or looks broken, the job fails loudly and the last known-good
  `notams.json` stays published untouched** — a stale-but-valid file is
  always preferred over a broken or empty one.

## Running it locally

```bash
npm install
npx playwright install --with-deps chromium
npm run scrape
```

Takes roughly 50–60 seconds for ~90 NOTAMs (page load + one AJAX round trip
per row, sequential). Writes `notams.json` in the repo root.

## Security

- **Least-privilege automation.** `scrape.yml` declares only
  `permissions: contents: write` — nothing else — and only ever runs on a
  schedule or manual `workflow_dispatch`, never on a `pull_request` trigger.
  That means an external contributor can't get a fork's code to run with this
  repo's write token by opening a PR (a common CI supply-chain hole). The
  commit step also stages only `notams.json` explicitly (`git add
  notams.json`, not `git add -A`), so a compromised dependency can't smuggle
  other file changes into a commit even in the worst case.
- **Pinned Actions.** All third-party GitHub Actions in the workflow are
  pinned to a full commit SHA (with the version as a trailing comment), not a
  mutable tag, so a compromised or force-moved tag upstream can't silently
  swap in different code. [Dependabot](.github/dependabot.yml) keeps these
  pins (and npm dependencies) current via automated PRs.
- **Escaped, CSP-hardened viewer.** Every NOTAM field is scraped from a
  third-party site and is treated as untrusted input: [`viewer.js`](viewer.js)
  HTML-escapes every field before inserting it into the page, and
  [`index.html`](index.html) sets a strict `Content-Security-Policy`
  (`script-src 'self'`, no inline scripts) as defense in depth — even if an
  escaping bug slipped in, the browser would still refuse to execute an
  injected `<script>`.
- **Data integrity has a hard limit.** There's no cryptographic signing on
  IAA's side, so if their site were compromised or tampered with in transit,
  this feed would faithfully republish that. Treat this the same way you'd
  treat any unofficial scrape — informational, not authoritative (see the
  disclaimer throughout this README).

If you fork or extend this: keep the workflow off `pull_request` triggers, or
if you need PR-based CI, make sure any privileged step (like the commit/push
here) only ever runs on your own trusted code, not on code checked out from a
fork.

## Limitations

- This is a scraper against a third-party government site with no public API
  and active bot-management. It is not affiliated with, endorsed by, or
  supported by the IAA, and it can break at any time if the site changes.
- Boundary/polygon NOTAMs are only ever given the Q-line fallback circle —
  see [above](#about-the-position-field--read-this-before-plotting-anything).
- Refresh interval is 10 minutes; this is not a real-time feed.

## License

[MIT](LICENSE)
