// Page -> structured rows. Environment-agnostic: the caller supplies a
// grayscale page image and an OCR engine ({ digits, code, line, block, cjk },
// each taking an image and resolving to { text, conf }).

import {
  normalizeContrast, rotateQuarter, deskew, detectGrid, cropCell, crop, inkBox, normalizeCell, stripEdgeInk,
} from './imaging.js';
import { readDigits } from './digits.js';
import { matchCatalog, matchSite, parsePeriod, parseDeclaredCount, parseQty } from './matching.js';
import { HEADER_KEYWORDS, REQUIRED_COLUMNS, DEFAULT_LAYOUT } from './config.js';

// Quantities are read by two unrelated methods: the OCR engine and glyph
// template matching. A value is accepted silently only when both agree.
const QTY_OCR = { inkHeight: 40, padding: 24 };
const MIN_GLYPH_SCORE = 0.68;
const MIN_GLYPH_MARGIN = 0.08;
// Below this a glyph resembles no digit at all (a letter, unit or bracket).
const NOT_A_DIGIT_SCORE = 0.5;

const HEADING_OCR = { inkHeight: 44, padding: 24 };

function tightCrop(cell, margin = 8) {
  const box = inkBox(cell);
  if (!box) return null;
  return crop(cell, box.x0 - margin, box.y0 - margin, box.x1 + margin, box.y1 + margin);
}

function textLines(img) {
  const lines = [];
  let start = -1, gap = 0;
  for (let y = 0; y < img.h; y++) {
    let ink = 0;
    for (let x = 0; x < img.w; x++) if (img.data[y * img.w + x] < 128) ink++;
    if (ink >= 3) { if (start < 0) start = y; gap = 0; }
    else if (start >= 0 && ++gap >= 10) { lines.push({ y0: start, y1: y - gap }); start = -1; gap = 0; }
  }
  if (start >= 0) lines.push({ y0: start, y1: img.h - 1 });
  return lines.filter((l) => l.y1 - l.y0 >= 15);
}

// Work out which column holds what by reading the header row. Returns
// { columns: { code, name, qty }, complete } or { error }. `complete` means all
// three headings were read; otherwise the row was only confirmed as a header
// in the usual layout.
async function identifyColumns(img, grid, ocr) {
  const kinds = [];
  for (let c = 0; c < grid.cols.length; c++) {
    const cell = normalizeCell(cropCell(img, grid, 0, c), HEADING_OCR);
    const text = cell ? (await ocr.cjk(cell)).text.replace(/\s/g, '') : '';
    const hit = HEADER_KEYWORDS.find(([, pattern]) => pattern.test(text));
    kinds.push(hit ? hit[0] : null);
  }
  const positions = (kind) => kinds.flatMap((k, i) => (k === kind ? [i] : []));
  const found = Object.fromEntries(Object.keys(REQUIRED_COLUMNS).map((k) => [k, positions(k)]));

  for (const [kind, label] of Object.entries(REQUIRED_COLUMNS)) {
    if (found[kind].length > 1) return { error: `表頭有 ${found[kind].length} 個「${label}」欄，無法判斷要讀哪一欄` };
  }
  if (Object.values(found).every((p) => p.length === 1)) {
    return { columns: { code: found.code[0], name: found.name[0], qty: found.qty[0] }, complete: true };
  }

  const known = kinds.filter(Boolean).length;
  const matchesDefault = kinds.length === DEFAULT_LAYOUT.length && kinds.every((k, i) => !k || k === DEFAULT_LAYOUT[i]);
  if (matchesDefault && known >= 2) {
    const at = (kind) => DEFAULT_LAYOUT.indexOf(kind);
    return { columns: { code: at('code'), name: at('name'), qty: at('qty') }, complete: false };
  }
  const missing = Object.entries(REQUIRED_COLUMNS).filter(([k]) => !found[k].length).map(([, label]) => `「${label}」`).join('');
  return { error: `表格第一列讀不到 ${missing} 欄位名稱，這一頁可能沒有表頭列，或版面與預期不同` };
}

// Find the table and its columns, trying the other page orientations when the
// page as given has no readable header row (upside-down or sideways scans).
async function locateTable(upright, ocr) {
  let fallback = null, error = '找不到表格格線';
  for (const turn of [0, 180, 90, 270]) {
    const img = rotateQuarter(upright, turn);
    const grid = detectGrid(img);
    if (!grid) continue;
    const cols = await identifyColumns(img, grid, ocr);
    if (cols.complete) return { img, grid, columns: cols.columns, turn };
    if (turn !== 0) continue;
    if (cols.columns) fallback = { img, grid, columns: cols.columns, turn };
    else error = cols.error;
  }
  return fallback || { error };
}

// The header's third text line carries the site name. Mixed-language OCR of
// the whole header sometimes renders it in Latin letters, so it is also read
// on its own with the CJK-only model.
async function readSite(header, lines, headerText, ocr, sites) {
  const fromBlock = matchSite(headerText, sites);
  if (lines.length < 3) return fromBlock;
  const band = crop(header, 0, lines[2].y0 - 10, header.w - 1, lines[2].y1 + 10);
  const img = normalizeCell(band, HEADING_OCR);
  if (!img) return fromBlock;
  const fromLine = matchSite((await ocr.cjk(img)).text, sites);
  if (!sites.length) return fromLine.site ? fromLine : fromBlock;
  if (!fromLine.flag) return fromLine;
  if (!fromBlock.flag) return fromBlock;
  return fromLine.site ? fromLine : fromBlock;
}

// Thumbnail shown next to the site selector: the date-range and site lines.
function headerThumb(header, lines) {
  const band = lines.length >= 3
    ? crop(header, 0, lines[1].y0 - 12, header.w - 1, lines[2].y1 + 12)
    : header;
  return tightCrop(band, 12) || band;
}

// Returns { qty, flag, cell } where cell is the cleaned crop that was read.
async function readQty(rawCell, ocr) {
  // Quantities are centred, so ink touching the crop border is table rule.
  const { img: cell, tallest } = stripEdgeInk(rawCell);
  const box = inkBox(cell);
  const cutOff = tallest >= (box ? (box.y1 - box.y0 + 1) * 0.5 : 20);
  const result = await readQtyDigits(cell, ocr);
  if (cutOff) result.flag = '數量可能緊貼格線而沒有讀完整，請對照原圖';
  return { ...result, cell: cutOff ? rawCell : cell };
}

async function readQtyDigits(cell, ocr) {
  const img = normalizeCell(cell, QTY_OCR);
  if (!img) return { qty: '', flag: '數量空白' };
  const ocrText = (await ocr.digits(img)).text.replace(/\s/g, '');
  const glyph = readDigits(cell);
  const ocrValid = parseQty(ocrText) !== null;
  const agree = ocrValid && glyph.text === ocrText;
  const glyphSure = glyph.text !== null && parseQty(glyph.text) !== null &&
    glyph.score >= MIN_GLYPH_SCORE && glyph.margin >= MIN_GLYPH_MARGIN;
  const qty = agree || (!glyphSure && ocrValid) ? ocrText : (glyph.text || '');

  // Both readers only know digits, so anything else in the cell must be
  // reported even when they agree on the digits themselves.
  if (glyph.extra) return { qty, flag: '數量裡有數字以外的符號（可能是負號、小數點或逗號），請對照原圖' };
  if (agree && glyph.score < NOT_A_DIGIT_SCORE) return { qty, flag: '數量裡有不像數字的字元，請對照原圖' };
  if (agree) return { qty, flag: null };
  return { qty, flag: `兩種辨識方法結果不一致（${ocrText || '空白'}／${glyph.text || '無法判讀'}），請對照原圖` };
}

// lists: { sites: string[], catalog: [{ code, name }] } as configured by the user.
export async function extractPage(gray, ocr, lists) {
  const { img: upright, deg } = deskew(normalizeContrast(gray));
  const table = await locateTable(upright, ocr);
  if (table.error) return { error: table.error };
  const { img, grid, columns, turn } = table;

  const header = crop(img, 0, 0, img.w - 1, grid.top - 8);
  const headerInk = tightCrop(header, 30) || header;
  const headerText = (await ocr.block(headerInk)).text;
  const lines = textLines(header);
  const site = await readSite(header, lines, headerText, ocr, lists.sites);
  const period = parsePeriod(headerText);
  const declared = parseDeclaredCount(headerText);

  const rows = [];
  for (let r = 1; r < grid.rows.length; r++) {
    const codeCell = cropCell(img, grid, r, columns.code);
    const nameCell = cropCell(img, grid, r, columns.name);
    const qtyCell = cropCell(img, grid, r, columns.qty);
    const codeImg = normalizeCell(codeCell), nameImg = normalizeCell(nameCell);
    if (!codeImg && !nameImg && !inkBox(qtyCell)) continue; // empty table row

    const codeText = codeImg ? (await ocr.code(codeImg)).text : '';
    const nameText = nameImg ? (await ocr.line(nameImg)).text : '';
    const drug = matchCatalog(codeText, nameText, lists.catalog);
    const qty = await readQty(qtyCell, ocr);
    rows.push({
      code: drug.code,
      name: drug.name,
      qty: qty.qty,
      flags: { code: drug.flag, qty: qty.flag },
      crops: { code: tightCrop(codeCell), qty: tightCrop(qty.cell) },
      raw: { code: codeText, name: nameText },
    });
  }

  const warnings = [];
  if (!rows.length) warnings.push('表格裡沒有讀到任何資料列');
  if (declared !== null && declared !== rows.length) {
    warnings.push(`表頭的申請筆數為 ${declared}，但表格讀到 ${rows.length} 列`);
  }

  return {
    skew: deg,
    turn,
    site: site.site,
    period: period.period,
    flags: { site: site.flag, period: period.flag },
    warnings,
    headerCrop: headerThumb(header, lines),
    headerText,
    rows,
  };
}
