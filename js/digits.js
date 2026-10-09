// Second, OCR-independent reader for the quantity column: split the cell into
// glyphs and match each against digit templates built from verified scans.
// Its only job is to disagree with the OCR engine when either one is wrong.

import { inkBox, crop } from './imaging.js';
import { TEMPLATES } from './digit-templates.js';

export const GLYPH_W = 20, GLYPH_H = 24;
const INK = 160;

// Returns { glyphs, extra }. glyphs holds one GLYPH_W x GLYPH_H darkness map
// (Float32Array, 0..1) per full-height glyph, or is null when the cell cannot
// be split cleanly. extra is true when the cell also contains a mark too small
// to be a digit but too large to be scanner noise: a minus sign, decimal point
// or thousands separator, any of which changes the value.
export function segmentGlyphs(cell) {
  const box = inkBox(cell, INK);
  if (!box) return { glyphs: [], extra: false };
  const img = crop(cell, box.x0, box.y0, box.x1, box.y1);
  const colInk = new Int32Array(img.w);
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) if (img.data[y * img.w + x] < INK) colInk[x]++;

  const glyphs = [];
  let start = -1, extra = false;
  for (let x = 0; x <= img.w; x++) {
    const ink = x < img.w && colInk[x] > 0;
    if (ink && start < 0) start = x;
    if (!ink && start >= 0) {
      const x0 = start, x1 = x - 1;
      start = -1;
      let y0 = img.h, y1 = -1, count = 0;
      for (let y = 0; y < img.h; y++) {
        for (let xx = x0; xx <= x1; xx++) {
          if (img.data[y * img.w + xx] < INK) { count++; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        }
      }
      const gh = y1 - y0 + 1, gw = x1 - x0 + 1;
      if (count < 12) continue; // scanner speck
      if (gh < img.h * 0.5) { extra = true; continue; }
      if (gw > gh * 0.9) return { glyphs: null, extra }; // touching glyphs
      glyphs.push(normalizeGlyph(crop(img, x0, y0, x1, y1)));
    }
  }
  return { glyphs, extra };
}

function normalizeGlyph(g) {
  const out = new Float32Array(GLYPH_W * GLYPH_H);
  const s = GLYPH_H / g.h;
  const w = Math.min(GLYPH_W, Math.max(1, Math.round(g.w * s)));
  const off = Math.floor((GLYPH_W - w) / 2);
  for (let y = 0; y < GLYPH_H; y++) {
    // area-average the source pixels covered by each target pixel
    const sy0 = Math.floor(y / s), sy1 = Math.max(sy0 + 1, Math.min(g.h, Math.ceil((y + 1) / s)));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x * g.w / w), sx1 = Math.max(sx0 + 1, Math.min(g.w, Math.ceil((x + 1) * g.w / w)));
      let sum = 0, n = 0;
      for (let yy = sy0; yy < sy1; yy++) for (let xx = sx0; xx < sx1; xx++) { sum += 255 - g.data[yy * g.w + xx]; n++; }
      out[y * GLYPH_W + off + x] = sum / n / 255;
    }
  }
  return out;
}

export function correlation(a, b) {
  let ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
  ma /= a.length; mb /= b.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

// templates: [{ digit, map }], possibly several per digit (one per typeface).
// Returns { text, score, margin, extra }: score is the weakest glyph's match
// and margin its lead over the best different digit. text is null if unreadable.
export function readDigits(cell, templates = TEMPLATES) {
  const { glyphs, extra } = segmentGlyphs(cell);
  if (glyphs === null) return { text: null, score: 0, margin: 0, extra };
  let text = '', score = 1, margin = 1;
  for (const g of glyphs) {
    const best = {};
    for (const t of templates) best[t.digit] = Math.max(best[t.digit] ?? -1, correlation(g, t.map));
    const ranked = Object.entries(best).sort((a, b) => b[1] - a[1]);
    text += ranked[0][0];
    score = Math.min(score, ranked[0][1]);
    margin = Math.min(margin, ranked[0][1] - ranked[1][1]);
  }
  return { text, score, margin, extra };
}
