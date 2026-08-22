const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
}

function fmtUtc(iso) {
  if (!iso) return 'unknown';
  return iso.replace('T', ' ').replace('Z', ' UTC');
}

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs} hr ago`;
  return `${Math.round(hrs / 24)} days ago`;
}

// Every field below ultimately comes from a third-party scrape (see scrape.mjs)
// and is untrusted, so every value interpolated into HTML must go through
// escapeHtml — never assume upstream data is well-formed.
function renderCard(n) {
  const badges = [];
  if (n.location) badges.push(`<span class="badge">${escapeHtml(n.location)}</span>`);
  if (!n.fullTextAvailable) badges.push(`<span class="badge">preview only</span>`);
  if (n.position) badges.push(`<span class="badge accent">${n.position.source === 'e_text' ? 'precise position' : 'approx. position'}</span>`);

  const validity = (n.fromDate || n.toDate)
    ? `Valid ${escapeHtml(fmtUtc(n.fromDate))} &rarr; ${escapeHtml(fmtUtc(n.toDate))}`
    : '';

  const limits = (n.lowerLimit || n.upperLimit)
    ? `<div class="limits">Limits: ${escapeHtml(n.lowerLimit || '?')} &ndash; ${escapeHtml(n.upperLimit || '?')}</div>`
    : '';

  const position = n.position
    ? `<div class="limits">Position: ${n.position.lat.toFixed(5)}, ${n.position.lon.toFixed(5)}${n.position.radiusNm != null ? ` (radius ${n.position.radiusNm} NM)` : ''}</div>`
    : '';

  const searchBlob = `${n.id} ${n.location} ${n.eText || ''}`.toLowerCase();

  return `
    <article class="card" data-search="${escapeHtml(searchBlob)}">
      <div class="card-head">
        <span class="notam-id">${escapeHtml(n.id)}</span>
        <div class="badges">${badges.join('')}</div>
      </div>
      <div class="validity">${validity}</div>
      <div class="e-text">${escapeHtml(n.eText || '(no text available)')}</div>
      ${limits}
      ${position}
      <details>
        <summary>Raw ICAO text</summary>
        <pre class="raw">${escapeHtml(n.rawText || '')}</pre>
      </details>
    </article>
  `;
}

async function main() {
  const listEl = document.getElementById('list');
  let data;
  try {
    const res = await fetch('./notams.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    listEl.innerHTML = `<div class="error">Failed to load notams.json: ${escapeHtml(err.message)}</div>`;
    return;
  }

  document.getElementById('generated').textContent =
    `Last updated: ${fmtUtc(data.generatedAt)} (${timeAgo(data.generatedAt)})`;
  document.getElementById('count').textContent = `${data.count} active NOTAM${data.count === 1 ? '' : 's'}`;

  if (!data.notams || data.notams.length === 0) {
    listEl.innerHTML = '<div class="empty">No NOTAMs found.</div>';
    return;
  }

  const sorted = [...data.notams].sort((a, b) => (a.fromDate || '').localeCompare(b.fromDate || ''));
  listEl.innerHTML = sorted.map(renderCard).join('');

  const cards = Array.from(listEl.querySelectorAll('.card'));
  document.getElementById('search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    for (const card of cards) {
      const match = !q || card.dataset.search.includes(q);
      card.style.display = match ? '' : 'none';
    }
  });
}

main();
