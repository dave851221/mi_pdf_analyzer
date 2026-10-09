// User-supplied lists (site names, drug list, report title). Stored only in
// this browser's localStorage; never sent anywhere and never part of the repo.

const KEY = 'pdf-qty-analyzer.settings.v1';

const empty = () => ({ title: '', sites: [], catalog: [] });

function sanitize(raw) {
  const out = empty();
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.title === 'string') out.title = raw.title.trim();
  if (Array.isArray(raw.sites)) out.sites = dedupe(raw.sites.map((s) => String(s).trim()).filter(Boolean));
  if (Array.isArray(raw.catalog)) {
    const seen = new Set();
    for (const e of raw.catalog) {
      const code = String(e && e.code || '').trim(), name = String(e && e.name || '').trim();
      if (!code || seen.has(code)) continue;
      seen.add(code);
      out.catalog.push({ code, name });
    }
  }
  return out;
}

const dedupe = (list) => [...new Set(list)];

export function loadSettings() {
  try { return sanitize(JSON.parse(localStorage.getItem(KEY))); } catch { return empty(); }
}

export function saveSettings(settings) {
  const clean = sanitize(settings);
  try { localStorage.setItem(KEY, JSON.stringify(clean)); } catch { /* storage unavailable: keep in memory only */ }
  return clean;
}

export function parseSettingsJson(text) {
  return sanitize(JSON.parse(text));
}

export const sitesToText = (sites) => sites.join('\n');
export const parseSitesText = (text) => dedupe(text.split(/[\n,，、]/).map((s) => s.trim()).filter(Boolean));

export const catalogToText = (catalog) => catalog.map((e) => `${e.code}, ${e.name}`).join('\n');

// One drug per line: "code, product name" (comma or tab separated).
export function parseCatalogText(text) {
  const catalog = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([^,\t]+)[,\t]?(.*)$/);
    if (!m || !m[1].trim()) continue;
    catalog.push({ code: m[1].trim(), name: m[2].trim() });
  }
  return sanitize({ catalog }).catalog;
}
