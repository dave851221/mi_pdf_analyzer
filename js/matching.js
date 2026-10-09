// Turns raw OCR text into trusted values by matching against the known lists.

function levenshtein(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function similarity(a, b) {
  const m = Math.max(a.length, b.length);
  return m ? 1 - levenshtein(a, b) / m : 0;
}

const normName = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const normCode = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

// Returns { code, name, flag }. flag is null when the row was identified with
// confidence, otherwise a message explaining why a human should look at it.
export function matchCatalog(codeText, nameText, catalog) {
  const code = normCode(codeText), name = normName(nameText);
  const scored = catalog.map((entry) => {
    const c = normCode(entry.code);
    // The leading "*" is sometimes read as a letter, so also try without it.
    const cs = Math.max(similarity(code, c), code.length > 1 ? similarity(code.slice(1), c) * 0.95 : 0);
    return { entry, exact: code === c, cs, ns: similarity(name, normName(entry.name)) };
  });
  const byName = [...scored].sort((a, b) => b.ns - a.ns);
  const bestName = byName[0];
  const margin = bestName ? bestName.ns - (byName[1] ? byName[1].ns : 0) : 0;
  const exact = scored.find((s) => s.exact);
  const hit = (s, flag = null) => ({ code: s.entry.code, name: s.entry.name, flag });

  // Accept silently only on strong, corroborated evidence.
  if (exact && exact.ns >= 0.8) return hit(exact);
  if (bestName && bestName.ns === 1 && margin > 0 && bestName.cs >= 0.6) return hit(bestName);
  if (bestName && bestName.ns >= 0.9 && margin >= 0.1 && bestName.cs >= 0.6) return hit(bestName);
  if (bestName && bestName.ns >= 0.9 && margin >= 0.3 && bestName.cs >= 0.4) return hit(bestName);
  if (exact) return hit(exact, '藥材碼與品名對不上，請確認');

  // Otherwise never substitute a guess: the list may simply be incomplete.
  // Keep what was read and let the user decide.
  const near = bestName && bestName.ns >= 0.9 ? `（品名最接近 ${bestName.entry.code}）` : '';
  return {
    code: code ? `*${code}` : '',
    name: nameText,
    flag: code ? `不在藥品清單中，請對照原圖確認${near}` : '藥材碼空白',
  };
}

const cleanSite = (line) => line.split('\n')[0].replace(/[^一-鿿A-Za-z0-9]/g, '');

// Returns { site, flag }.
export function matchSite(headerText, sites) {
  const text = headerText.replace(/[ \t]/g, '');
  const m = text.match(/申請院區[:：]?(.*)/);
  const line = m ? m[1] : text;
  if (!sites.length) {
    // No list configured yet: offer the raw reading for the user to confirm.
    const raw = cleanSite(line);
    return { site: raw, flag: raw ? '尚未設定院區清單，請確認院區名稱' : '無法辨識院區，請輸入' };
  }
  const contained = sites.filter((s) => line.includes(s));
  if (contained.length === 1) return { site: contained[0], flag: null };
  if (contained.length > 1) return { site: contained[0], flag: '讀到多個院區名稱，請確認' };
  // Not in the list (it may be incomplete): keep the reading, never guess.
  const raw = cleanSite(line);
  return { site: raw, flag: raw ? '不在院區清單中，請確認院區名稱' : '無法辨識院區，請輸入' };
}

export const PERIOD_RE = /^(\d{3})(\d{2})(\d{2})~(\d{3})(\d{2})(\d{2})$/;

export function isValidPeriod(period) {
  const m = period.match(PERIOD_RE);
  if (!m) return false;
  const ok = (mm, dd) => +mm >= 1 && +mm <= 12 && +dd >= 1 && +dd <= 31;
  return ok(m[2], m[3]) && ok(m[5], m[6]);
}

// Returns { period, flag } where period looks like "1150901~1150930".
export function parsePeriod(headerText) {
  const text = headerText.replace(/[ \t]/g, '');
  const m = text.match(/(\d{7})[~～\-–—]+(\d{7})/);
  if (!m) return { period: '', flag: '無法辨識日期區間，請輸入' };
  const period = `${m[1]}~${m[2]}`;
  return { period, flag: isValidPeriod(period) ? null : '日期區間格式異常，請確認' };
}

export function periodLabel(period) {
  const m = period.match(PERIOD_RE);
  if (!m) return period || '（未指定期間）';
  if (m[1] === m[4] && m[2] === m[5]) return `${+m[1]}年${+m[2]}月`;
  return period;
}

export function parseDeclaredCount(headerText) {
  const m = headerText.replace(/[ \t]/g, '').match(/申請筆數[:：]?(\d+)/);
  return m ? +m[1] : null;
}

export function parseQty(text) {
  const t = String(text).trim().replace(/,/g, '');
  return /^(0|[1-9]\d*)$/.test(t) ? +t : null;
}
