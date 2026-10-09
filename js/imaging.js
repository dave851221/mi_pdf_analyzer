// Pure image-processing helpers (no DOM access) so the same code runs in the
// browser and in the Node test harness. Images are 8-bit grayscale:
// { data: Uint8Array, w, h }.

const DARK = 128;

export function rgbaToGray(rgba, w, h) {
  const data = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    data[i] = (rgba[j] * 299 + rgba[j + 1] * 587 + rgba[j + 2] * 114) / 1000;
  }
  return { data, w, h };
}

// Stretch contrast so ink sits near 0 and paper near 255. Every threshold in
// this file assumes that, so faint or grey scans must be normalised first.
export function normalizeContrast(img) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < img.data.length; i++) hist[img.data[i]]++;
  const percentile = (fraction) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= img.data.length * fraction) return v; }
    return 255;
  };
  const ink = percentile(0.002), paper = percentile(0.5);
  if (paper - ink < 40 || (ink <= 8 && paper >= 247)) return img; // blank, or already fine
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.max(0, Math.min(255, Math.round(((v - ink) * 255) / (paper - ink))));
  const data = new Uint8Array(img.data.length);
  for (let i = 0; i < data.length; i++) data[i] = lut[img.data[i]];
  return { data, w: img.w, h: img.h };
}

// Rotate by a multiple of 90 degrees (clockwise).
export function rotateQuarter(img, degrees) {
  const { w, h, data } = img;
  const turns = ((degrees % 360) + 360) % 360 / 90;
  if (turns === 0) return img;
  if (turns === 2) return { data: Uint8Array.from(data).reverse(), w, h };
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = turns === 1 ? h - 1 - y : y, ny = turns === 1 ? x : w - 1 - x;
      out[ny * h + nx] = data[y * w + x];
    }
  }
  return { data: out, w: h, h: w };
}

// Estimate page skew in degrees by maximising the sharpness of the horizontal
// projection profile. Table rules dominate the profile, so the peak is crisp.
export function estimateSkew(img, maxDeg = 3) {
  const f = 4;
  const sw = Math.floor(img.w / f), sh = Math.floor(img.h / f);
  const xs = [], ys = [];
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let dark = false;
      for (let dy = 0; dy < f && !dark; dy++) {
        const row = (y * f + dy) * img.w + x * f;
        for (let dx = 0; dx < f; dx++) if (img.data[row + dx] < DARK) { dark = true; break; }
      }
      if (dark) { xs.push(x); ys.push(y); }
    }
  }
  if (!xs.length) return 0;
  const hist = new Float64Array(sh * 3);
  const score = (deg) => {
    hist.fill(0);
    const t = Math.tan(deg * Math.PI / 180);
    for (let i = 0; i < xs.length; i++) hist[Math.round(ys[i] - xs[i] * t) + sh]++;
    let s = 0;
    for (let i = 0; i < hist.length; i++) s += hist[i] * hist[i];
    return s;
  };
  const search = (from, to, step) => {
    let best = from, bestScore = -1;
    for (let d = from; d <= to + 1e-9; d += step) {
      const s = score(d);
      if (s > bestScore) { bestScore = s; best = d; }
    }
    return best;
  };
  const coarse = search(-maxDeg, maxDeg, 0.1);
  return search(coarse - 0.1, coarse + 0.1, 0.01);
}

// Rotate so that a line running at `deg` in the source becomes horizontal.
export function rotate(img, deg) {
  const { w, h, data } = img;
  const out = new Uint8Array(w * h).fill(255);
  const a = deg * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
  const cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) {
    const dy = y - cy;
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const sx = cx + dx * cos - dy * sin, sy = cy + dx * sin + dy * cos;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) continue;
      const fx = sx - x0, fy = sy - y0, i = y0 * w + x0;
      out[y * w + x] =
        (data[i] * (1 - fx) + data[i + 1] * fx) * (1 - fy) +
        (data[i + w] * (1 - fx) + data[i + w + 1] * fx) * fy;
    }
  }
  return { data: out, w, h };
}

export function deskew(img) {
  const deg = estimateSkew(img);
  return { img: Math.abs(deg) > 0.1 ? rotate(img, deg) : img, deg };
}

function runs(flags) {
  const out = [];
  let s = -1;
  for (let i = 0; i <= flags.length; i++) {
    if (i < flags.length && flags[i]) { if (s < 0) s = i; }
    else if (s >= 0) { out.push({ start: s, end: i - 1 }); s = -1; }
  }
  return out;
}

// Locate the table rules. A pixel counts towards a rule if anything within
// +-tol px across the rule is dark, which absorbs residual skew and jitter.
// Returns { rows: [{y0, y1}], cols: [{x0, x1}] } as the cell interiors.
export function detectGrid(img, tol = 3) {
  const { w, h, data } = img;
  const rowCount = new Int32Array(h);
  for (let x = 0; x < w; x++) {
    let win = 0;
    for (let y = 0; y < Math.min(tol, h); y++) if (data[y * w + x] < DARK) win++;
    for (let y = 0; y < h; y++) {
      const add = y + tol, drop = y - tol - 1;
      if (add < h && data[add * w + x] < DARK) win++;
      if (drop >= 0 && data[drop * w + x] < DARK) win--;
      if (win > 0) rowCount[y]++;
    }
  }
  const hLines = runs(Array.from(rowCount, (c) => c > w * 0.45));
  if (hLines.length < 3) return null;
  const top = hLines[0].start, bottom = hLines[hLines.length - 1].end;
  const span = bottom - top + 1;

  const colCount = new Int32Array(w);
  for (let y = top; y <= bottom; y++) {
    let win = 0;
    const row = y * w;
    for (let x = 0; x < Math.min(tol, w); x++) if (data[row + x] < DARK) win++;
    for (let x = 0; x < w; x++) {
      const add = x + tol, drop = x - tol - 1;
      if (add < w && data[row + add] < DARK) win++;
      if (drop >= 0 && data[row + drop] < DARK) win--;
      if (win > 0) colCount[x]++;
    }
  }
  const vLines = runs(Array.from(colCount, (c) => c > span * 0.9));
  if (vLines.length < 2) return null;

  const rows = [], cols = [];
  for (let i = 0; i + 1 < hLines.length; i++) rows.push({ y0: hLines[i].end + 1, y1: hLines[i + 1].start - 1 });
  for (let i = 0; i + 1 < vLines.length; i++) cols.push({ x0: vLines[i].end + 1, x1: vLines[i + 1].start - 1 });
  return { rows, cols, top, bottom };
}

export function crop(img, x0, y0, x1, y1) {
  x0 = Math.max(0, x0); y0 = Math.max(0, y0);
  x1 = Math.min(img.w - 1, x1); y1 = Math.min(img.h - 1, y1);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) data.set(img.data.subarray((y0 + y) * img.w + x0, (y0 + y) * img.w + x0 + w), y * w);
  return { data, w, h };
}

// Returns a copy with every blob of ink that touches the image border erased,
// plus the height of the tallest blob removed. In a crop of a cell whose
// content is centred, such ink is leftover table rule (rules are never
// perfectly straight); a tall blob may instead be content cut off by the edge.
export function stripEdgeInk(img, thresh = 160) {
  const { w, h } = img;
  const data = Uint8Array.from(img.data);
  let tallest = 0;
  const flood = (sx, sy) => {
    if (data[sy * w + sx] >= thresh) return;
    const stack = [sy * w + sx];
    data[sy * w + sx] = 255;
    let top = sy, bottom = sy;
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i - x) / w;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (data[j] < thresh) { data[j] = 255; stack.push(j); }
        }
      }
    }
    tallest = Math.max(tallest, bottom - top + 1);
  };
  for (let x = 0; x < w; x++) { flood(x, 0); flood(x, h - 1); }
  for (let y = 0; y < h; y++) { flood(0, y); flood(w - 1, y); }
  return { img: { data, w, h }, tallest };
}

export function cropCell(img, grid, row, col, inset = 6) {
  const r = grid.rows[row], c = grid.cols[col];
  return crop(img, c.x0 + inset, r.y0 + inset, c.x1 - inset, r.y1 - inset);
}

// Bounding box of the ink, ignoring rows/columns holding only a stray pixel.
export function inkBox(img, thresh = 160) {
  const { w, h, data } = img;
  const rowInk = new Int32Array(h), colInk = new Int32Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[y * w + x] < thresh) { rowInk[y]++; colInk[x]++; }
  let y0 = 0, y1 = h - 1, x0 = 0, x1 = w - 1;
  while (y0 < h && rowInk[y0] < 2) y0++;
  while (y1 >= 0 && rowInk[y1] < 2) y1--;
  while (x0 < w && colInk[x0] < 2) x0++;
  while (x1 >= 0 && colInk[x1] < 2) x1--;
  if (y0 > y1 || x0 > x1) return null;
  return { x0, y0, x1, y1 };
}

export function scale(img, factor) {
  const w = Math.max(1, Math.round(img.w * factor)), h = Math.max(1, Math.round(img.h * factor));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.h - 1, (y + 0.5) / factor - 0.5), y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(img.h - 1, y0 + 1), fy = Math.max(0, sy - y0);
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.w - 1, (x + 0.5) / factor - 0.5), x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(img.w - 1, x0 + 1), fx = Math.max(0, sx - x0);
      out[y * w + x] =
        (img.data[y0 * img.w + x0] * (1 - fx) + img.data[y0 * img.w + x1] * fx) * (1 - fy) +
        (img.data[y1 * img.w + x0] * (1 - fx) + img.data[y1 * img.w + x1] * fx) * fy;
    }
  }
  return { data: out, w, h };
}

export function pad(img, px) {
  const w = img.w + px * 2, h = img.h + px * 2;
  const data = new Uint8Array(w * h).fill(255);
  for (let y = 0; y < img.h; y++) data.set(img.data.subarray(y * img.w, (y + 1) * img.w), (y + px) * w + px);
  return { data, w, h };
}

// Trim a cell to its ink and rescale so the glyphs are `inkHeight` px tall,
// the size the OCR engine handles best. Returns null for an empty cell.
export function normalizeCell(cell, { inkHeight = 40, padding = 24, binarize = false } = {}) {
  const box = inkBox(cell);
  if (!box) return null;
  let out = crop(cell, box.x0, box.y0, box.x1, box.y1);
  out = scale(out, inkHeight / out.h);
  if (binarize) for (let i = 0; i < out.data.length; i++) out.data[i] = out.data[i] < 150 ? 0 : 255;
  return pad(out, padding);
}

// Binary PGM, which the OCR engine reads directly without a canvas round trip.
export function encodePGM(img) {
  const head = new TextEncoder().encode(`P5\n${img.w} ${img.h}\n255\n`);
  const out = new Uint8Array(head.length + img.data.length);
  out.set(head);
  out.set(img.data, head.length);
  return out;
}
