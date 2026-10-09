// Page -> structured rows. Environment-agnostic: the caller supplies a
// grayscale page image and an OCR engine ({ digits, code, line, block, cjk },
// each taking an image and resolving to { text, conf }).

import { deskew, detectGrid, cropCell, crop, inkBox, normalizeCell } from './imaging.js';
import { readDigits } from './digits.js';
import { matchCatalog, matchSite, parsePeriod, parseDeclaredCount, parseQty } from './matching.js';
import { COLUMNS, COLUMN_COUNT } from './config.js';

// Quantities are read by two unrelated methods: the OCR engine and glyph
// template matching. A value is accepted silently only when both agree.
const QTY_OCR = { inkHeight: 40, padding: 24 };
const MIN_GLYPH_SCORE = 0.68;
const MIN_GLYPH_MARGIN = 0.08;

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

// The header's third text line carries the site name. Mixed-language OCR of
// the whole header sometimes renders it in Latin letters, so it is also read
// on its own with the CJK-only model.
async function readSite(header, lines, headerText, ocr, sites) {
  const fromBlock = matchSite(headerText, sites);
  if (lines.length < 3) return fromBlock;
  const band = crop(header, 0, lines[2].y0 - 10, header.w - 1, lines[2].y1 + 10);
  const img = normalizeCell(band, { inkHeight: 44, padding: 24 });
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

async function readQty(cell, ocr) {
  const img = normalizeCell(cell, QTY_OCR);
  if (!img) return { qty: '', flag: '數量空白' };
  const ocrText = (await ocr.digits(img)).text.replace(/\s/g, '');
  const glyph = readDigits(cell);
  const ocrValid = parseQty(ocrText) !== null;
  if (ocrValid && glyph.text === ocrText) return { qty: ocrText, flag: null };

  const glyphSure = glyph.text !== null && parseQty(glyph.text) !== null &&
    glyph.score >= MIN_GLYPH_SCORE && glyph.margin >= MIN_GLYPH_MARGIN;
  const qty = glyphSure || !ocrValid ? (glyph.text || '') : ocrText;
  return { qty, flag: `兩種辨識方法結果不一致（${ocrText || '空白'}／${glyph.text || '無法判讀'}），請對照原圖` };
}

// lists: { sites: string[], catalog: [{ code, name }] } as configured by the user.
export async function extractPage(gray, ocr, lists) {
  const { img, deg } = deskew(gray);
  const grid = detectGrid(img);
  if (!grid) return { error: '找不到表格格線' };
  if (grid.cols.length !== COLUMN_COUNT) {
    return { error: `表格應為 ${COLUMN_COUNT} 欄，但偵測到 ${grid.cols.length} 欄` };
  }

  const header = crop(img, 0, 0, img.w - 1, grid.top - 8);
  const headerInk = tightCrop(header, 30) || header;
  const headerText = (await ocr.block(headerInk)).text;
  const lines = textLines(header);
  const site = await readSite(header, lines, headerText, ocr, lists.sites);
  const period = parsePeriod(headerText);
  const declared = parseDeclaredCount(headerText);

  const rows = [];
  for (let r = 1; r < grid.rows.length; r++) {
    const codeCell = cropCell(img, grid, r, COLUMNS.code);
    const nameCell = cropCell(img, grid, r, COLUMNS.name);
    const qtyCell = cropCell(img, grid, r, COLUMNS.qty);
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
      crops: { code: tightCrop(codeCell), qty: tightCrop(qtyCell) },
      raw: { code: codeText, name: nameText },
    });
  }

  const warnings = [];
  if (declared !== null && declared !== rows.length) {
    warnings.push(`表頭的申請筆數為 ${declared}，但表格讀到 ${rows.length} 列`);
  }
  const seen = new Set();
  for (const row of rows) {
    if (row.code && seen.has(row.code)) warnings.push(`藥材碼 ${row.code} 在本頁出現不只一次`);
    seen.add(row.code);
  }

  return {
    skew: deg,
    site: site.site,
    period: period.period,
    flags: { site: site.flag, period: period.flag },
    warnings,
    headerCrop: headerThumb(header, lines),
    headerText,
    rows,
  };
}
