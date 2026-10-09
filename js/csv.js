import { parseQty } from './matching.js';

export const DETAIL_COLUMNS = ['檔案', '頁碼', '期間', '院區', '藥材碼', '品名', '數量'];

const escapeField = (v) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// BOM so that Excel opens the file as UTF-8.
export function toCsv(rows) {
  return '﻿' + rows.map((r) => r.map(escapeField).join(',')).join('\r\n') + '\r\n';
}

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

// Excel's plain "CSV" save uses the system code page (Big5 on zh-TW Windows),
// so fall back to it when the bytes are not valid UTF-8.
export function decodeCsvBytes(buffer) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { return new TextDecoder('big5').decode(buffer); }
}

// Returns { records, errors }. Any error means nothing should be imported.
export function parseDetailCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { records: [], errors: ['檔案是空的'] };
  const header = rows[0].map((h) => h.trim());
  const col = Object.fromEntries(DETAIL_COLUMNS.map((name) => [name, header.indexOf(name)]));
  const missing = ['院區', '藥材碼', '數量'].filter((name) => col[name] < 0);
  if (missing.length) return { records: [], errors: [`找不到必要欄位：${missing.join('、')}（第一列必須是欄位名稱）`] };

  const records = [], errors = [];
  const get = (r, name) => (col[name] >= 0 ? (r[col[name]] ?? '').trim() : '');
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const rec = {
      file: get(r, '檔案'), page: get(r, '頁碼'), period: get(r, '期間'),
      site: get(r, '院區'), code: get(r, '藥材碼'), name: get(r, '品名'),
    };
    const qty = parseQty(get(r, '數量'));
    if (!rec.site) errors.push(`第 ${line} 列：院區是空的`);
    if (!rec.code) errors.push(`第 ${line} 列：藥材碼是空的`);
    if (qty === null) errors.push(`第 ${line} 列：數量「${get(r, '數量')}」不是 0 以上的整數`);
    records.push({ ...rec, qty: qty === null ? '' : String(qty) });
  });
  return { records, errors };
}
