import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const SOURCE_URL = 'https://ext.iaa.gov.il/aeroinfo/AeroInfo.aspx?msgType=Notam';
const OUTPUT_FILE = new URL('./notams.json', import.meta.url);
const MIN_ROWS = Number(process.env.NOTAM_MIN_ROWS || 10);
const ROW_TIMEOUT_MS = 20000;

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// "YYYYMMDDHHmm" (UTC) -> ISO 8601 string
function parseCompactDateTime(raw) {
  if (!raw || raw.length !== 12) return null;
  const y = raw.slice(0, 4);
  const mo = raw.slice(4, 6);
  const d = raw.slice(6, 8);
  const h = raw.slice(8, 10);
  const mi = raw.slice(10, 12);
  return `${y}-${mo}-${d}T${h}:${mi}:00Z`;
}

// "YYYY-MM-DD-HH.mm.ss.ffffff" -> ISO 8601 string
function parseCreateDate(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})\.(\d{2})\.(\d{2})/.exec(raw || '');
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
}

// ICAO summary position token, e.g. "3123N03446E001" -> lat/lon in decimal degrees + radius in NM.
// Also handles longer forms with seconds, e.g. "312252N0344541E" (used in some free-text positions).
function parsePositionToken(token) {
  const m = /^(\d{2})(\d{2})(\d{2})?([NS])(\d{3})(\d{2})(\d{2})?([EW])(\d{3})?$/.exec(token);
  if (!m) return null;
  const [, latDeg, latMin, latSec, ns, lonDeg, lonMin, lonSec, ew, radius] = m;
  let lat = Number(latDeg) + Number(latMin) / 60 + Number(latSec || 0) / 3600;
  let lon = Number(lonDeg) + Number(lonMin) / 60 + Number(lonSec || 0) / 3600;
  if (ns === 'S') lat = -lat;
  if (ew === 'W') lon = -lon;
  const result = { lat: round(lat, 6), lon: round(lon, 6) };
  if (radius !== undefined) result.radiusNm = Number(radius);
  return result;
}

function round(n, dp) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function parseQLine(qLineText) {
  const m = /^Q\)\s*(.+)$/.exec(qLineText.trim());
  if (!m) return null;
  const parts = m[1].split('/').map((s) => s.trim());
  if (parts.length < 8) return null;
  const [fir, qcode, traffic, purpose, scope, lower, upper, positionToken] = parts;
  const position = parsePositionToken(positionToken);
  return {
    fir,
    qcode,
    traffic,
    purpose,
    scope,
    lowerLimitFl: lower,
    upperLimitFl: upper,
    positionToken,
    position: position ? { lat: position.lat, lon: position.lon, radiusNm: position.radiusNm } : null,
  };
}

function parseALine(aLineText) {
  const m = /^A\)\s*(.+)$/.exec(aLineText.trim());
  if (!m) return [];
  // A) commonly shares its line with B)/C), e.g. "A) LLLL B) 2608230245 C) 2608312059".
  const text = m[1];
  const bIdx = text.search(/B\)/);
  const affectedText = bIdx === -1 ? text : text.slice(0, bIdx);
  return affectedText.trim().split(/\s+/).filter(Boolean);
}

// Looks for a "CENTERED ON PSN <coord> ..." phrase plus a nearby "<radius>NM RADIUS" phrase
// in the free-text E) section, which is more precise than the Q-line's minute-rounded position.
function parsePreciseEPosition(eText) {
  const psnMatch = /CENTERED ON PSN\s+(\d{4,6})([NS])\s*(\d{5,7})([EW])/i.exec(eText);
  if (!psnMatch) return null;
  const [, latRaw, ns, lonRaw, ew] = psnMatch;
  const token = `${latRaw}${ns}${lonRaw}${ew}`;
  const position = parsePositionToken(token);
  if (!position) return null;

  const radiusMatch = /(\d+(?:\.\d+)?)\s*NM\s+RADIUS/i.exec(eText);
  const radiusNm = radiusMatch ? Number(radiusMatch[1]) : null;

  return { lat: position.lat, lon: position.lon, radiusNm };
}

function parseMsgXml(xml) {
  const openTagMatch = /^<Msg\s+([^>]*)>/.exec(xml);
  const attrs = {};
  if (openTagMatch) {
    const attrRegex = /(\w+)="([^"]*)"/g;
    let am;
    while ((am = attrRegex.exec(openTagMatch[1])) !== null) {
      attrs[am[1]] = decodeEntities(am[2]);
    }
  }

  const lines = [];
  const textRegex = /<MsgText>([\s\S]*?)<\/MsgText>/g;
  let tm;
  while ((tm = textRegex.exec(xml)) !== null) {
    lines.push(decodeEntities(tm[1]));
  }

  return { attrs, lines };
}

function buildNotamRecord(xml, fallback) {
  const { attrs, lines } = parseMsgXml(xml);
  const rawText = lines.join('\n');

  // First line is e.g. "(A0668/26 NOTAMR A0598/26" (replaces A0598/26) or
  // "(C1780/26 NOTAMN" (new). This page never shows NOTAMC (cancellation)
  // entries — a cancelled NOTAM just stops appearing in future scrapes — but
  // NOTAMR's "replaces" reference is real data worth surfacing: a consumer
  // caching NOTAMs across polls can retire the old number explicitly instead
  // of just noticing it vanished.
  const headerMatch = /^\(\S+\s+NOTAM([A-Z])(?:\s+(\S+))?/.exec((lines[0] || '').trim());
  const notamType = headerMatch ? headerMatch[1] : null;
  const replaces = headerMatch && headerMatch[2] ? headerMatch[2] : null;

  const qLineText = lines.find((l) => /^Q\)/.test(l.trim()));
  const aLineText = lines.find((l) => /^A\)/.test(l.trim()));
  const fgLineText = lines.find((l) => /^F\)/.test(l.trim()));
  const eLineIdx = lines.findIndex((l) => /^E\)/.test(l.trim()));

  let eText = null;
  if (eLineIdx !== -1) {
    // E) text continues across subsequent lines until the F)/G) line (if any).
    const fgIdx = lines.findIndex((l, i) => i > eLineIdx && /^F\)/.test(l.trim()));
    const end = fgIdx === -1 ? lines.length : fgIdx;
    eText = lines
      .slice(eLineIdx, end)
      .join(' ')
      .replace(/^E\)\s*/, '')
      .trim();
    // When there's no F)/G) line, the E) text is the last content and carries the
    // outer "(...)" wrapper's closing paren (e.g. "(C123/26 NOTAMN ... CTN ADZ.)").
    if (fgIdx === -1 && lines[0].trim().startsWith('(') && eText.endsWith(')')) {
      eText = eText.slice(0, -1).trim();
    }
  }

  const qLine = qLineText ? parseQLine(qLineText) : null;
  const affected = aLineText ? parseALine(aLineText) : [];

  let lowerLimit = null;
  let upperLimit = null;
  if (fgLineText) {
    // NOTAM text ends with a closing paren from the outer "(...)" wrapper, e.g. "F) GND G) 2200FT AMSL)".
    const text = fgLineText.trim().replace(/^F\)\s*/, '').replace(/\)\s*$/, '');
    const gIdx = text.search(/G\)/);
    if (gIdx === -1) {
      lowerLimit = text.trim() || null;
    } else {
      lowerLimit = text.slice(0, gIdx).trim() || null;
      upperLimit = text.slice(gIdx + 2).trim() || null;
    }
  }

  const precisePosition = eText ? parsePreciseEPosition(eText) : null;
  const position = precisePosition
    ? { ...precisePosition, source: 'e_text' }
    : qLine && qLine.position
      ? { ...qLine.position, source: 'q_line' }
      : null;

  // ICAO Q-code subject "KK" (e.g. "QKKKK") is reserved for CHECKLIST NOTAMs:
  // a periodic manifest of currently-valid NOTAM numbers + AIP/AIC references,
  // published for completeness cross-checking, not an operational restriction.
  const administrative = Boolean(qLine && qLine.qcode && qLine.qcode.slice(1, 3) === 'KK');

  return {
    id: attrs.NotamID || fallback.id,
    location: attrs.Location || fallback.location,
    airfield: attrs.Airfield || null,
    msgNumber: attrs.MsgNumber || null,
    fromDate: parseCompactDateTime(attrs.FromDate),
    toDate: parseCompactDateTime(attrs.ToDate),
    createDate: parseCreateDate(attrs.CreateDate),
    affected,
    qLine,
    eText,
    lowerLimit,
    upperLimit,
    position,
    administrative,
    notamType,
    replaces,
    rawText,
    fullTextAvailable: true,
  };
}

async function scrapeAll() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Captured right before the first request to the source page, not after
  // scraping finishes: the ~50-60s run touches ~90 rows sequentially, so
  // "finished" would understate staleness if something changed on the source
  // page partway through. The start time is the conservative "true as of" bound.
  const startedAt = new Date().toISOString();

  console.log(`Navigating to ${SOURCE_URL} ...`);
  const resp = await page.goto(SOURCE_URL, { waitUntil: 'load', timeout: 60000 });
  if (!resp || resp.status() !== 200) {
    throw new Error(`Unexpected navigation response: ${resp ? resp.status() : 'none'}`);
  }

  await page.waitForSelector('table.tblMainInfo', { timeout: 30000 });

  const rowCount = await page.locator('.ImgField img').count();
  console.log(`Found ${rowCount} NOTAM rows.`);

  const results = [];

  for (let i = 0; i < rowCount; i++) {
    const table = page.locator('table.tblMainInfo').nth(i);
    const fallback = {
      id: (await table.locator('.NotamID').first().innerText()).trim(),
      location: (await table.locator('.Location').first().innerText()).trim(),
      preview: (await table.locator('.MsgText').first().innerText()).trim(),
    };

    const img = page.locator('.ImgField img').nth(i);

    let record;
    for (let attempt = 1; attempt <= 2 && !record; attempt++) {
      try {
        const responsePromise = page.waitForResponse(
          async (r) => {
            if (r.request().method() !== 'POST') return false;
            if (!r.url().startsWith(SOURCE_URL.split('?')[0])) return false;
            try {
              const body = await r.text();
              return body.includes('f_buildMoreMsgInfo') && body.includes(`NotamID="${fallback.id}"`);
            } catch {
              return false;
            }
          },
          { timeout: ROW_TIMEOUT_MS },
        );

        await img.click();
        const response = await responsePromise;
        const body = await response.text();

        const match = /f_buildMoreMsgInfo\('(<Msg[\s\S]*?<\/Msg>)'\)/.exec(body);
        if (!match) throw new Error('f_buildMoreMsgInfo payload not found in response');

        record = buildNotamRecord(match[1], fallback);
      } catch (err) {
        console.warn(`Row ${i} (${fallback.id}) attempt ${attempt} failed: ${err.message}`);
      }
    }

    if (!record) {
      console.warn(`Row ${i} (${fallback.id}): falling back to truncated preview text.`);
      record = {
        id: fallback.id,
        location: fallback.location,
        airfield: null,
        msgNumber: null,
        fromDate: null,
        toDate: null,
        createDate: null,
        affected: [],
        qLine: null,
        eText: fallback.preview,
        lowerLimit: null,
        upperLimit: null,
        position: null,
        // No Q-line available in this fallback path, so detect via the
        // preview text itself (see the qcode-based check above for the
        // normal, reliable path).
        administrative: /^(E\)\s*)?CHECKLIST\b/i.test(fallback.preview.trim()),
        notamType: null,
        replaces: null,
        rawText: fallback.preview,
        fullTextAvailable: false,
      };
    }

    results.push(record);
  }

  await browser.close();
  return { startedAt, notams: results };
}

async function main() {
  const { startedAt, notams } = await scrapeAll();

  if (notams.length < MIN_ROWS) {
    throw new Error(
      `Sanity check failed: only ${notams.length} NOTAMs scraped (minimum expected: ${MIN_ROWS}). Refusing to publish a possibly-broken result.`,
    );
  }

  const incompleteCount = notams.filter((n) => !n.fullTextAvailable).length;
  if (incompleteCount > 0) {
    console.warn(`${incompleteCount}/${notams.length} NOTAMs only have truncated preview text (AJAX fetch failed).`);
  }

  const output = {
    generatedAt: startedAt,
    source: SOURCE_URL,
    disclaimer: 'Informational only. Not a substitute for an official pre-flight briefing.',
    count: notams.length,
    notams,
  };

  await writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2) + '\n', 'utf-8');
  console.log(`Wrote ${notams.length} NOTAMs to ${OUTPUT_FILE.pathname}`);
}

main().catch((err) => {
  console.error('Scrape failed:', err);
  process.exit(1);
});
