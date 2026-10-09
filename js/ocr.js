// Browser-side wiring for the vendored OCR engine and PDF renderer. All
// assets are loaded from this site's own vendor/ folder; no third-party host.

import Tesseract from '../vendor/tesseract/tesseract.esm.min.js';
import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';
import { encodePGM, rgbaToGray } from './imaging.js';
import { RENDER_DPI } from './config.js';

const vendor = (path) => new URL(`../vendor/${path}`, import.meta.url).href;

pdfjs.GlobalWorkerOptions.workerSrc = vendor('pdfjs/pdf.worker.min.mjs');

const WORKER_OPTIONS = {
  workerPath: vendor('tesseract/worker.min.js'),
  corePath: vendor('tesseract/core'),
  langPath: vendor('tesseract/lang'),
};
const SINGLE_LINE = '7';

async function makeWorker(langs, params) {
  const worker = await Tesseract.createWorker(langs, 1, WORKER_OPTIONS);
  await worker.setParameters(params);
  return worker;
}

// Returns the { digits, code, line, block, cjk } interface extractPage expects.
// Workers are started in stages: the first one downloads the engine and the
// English data, the second adds the Chinese data, and the rest then start from
// the browser cache. Starting all five at once makes each of them download
// the same files again. onStage(step, total) reports progress.
export async function createEngine(onStage = () => {}) {
  const digitsOnly = { tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: SINGLE_LINE };
  const codeChars = { tessedit_char_whitelist: '*ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', tessedit_pageseg_mode: SINGLE_LINE };
  onStage(1, 3);
  const digits = await makeWorker('eng', digitsOnly);
  onStage(2, 3);
  const block = await makeWorker(['chi_tra', 'eng'], {});
  onStage(3, 3);
  const [code, line, cjk] = await Promise.all([
    makeWorker('eng', codeChars),
    makeWorker('eng', { tessedit_pageseg_mode: SINGLE_LINE }),
    makeWorker('chi_tra', { tessedit_pageseg_mode: SINGLE_LINE }),
  ]);
  const reader = (worker) => async (img) => {
    const { data } = await worker.recognize(encodePGM(img));
    return { text: data.text.trim(), conf: data.confidence };
  };
  return { digits: reader(digits), code: reader(code), line: reader(line), block: reader(block), cjk: reader(cjk) };
}

// Returns { pdf, close }.
export async function openPdf(arrayBuffer) {
  const task = pdfjs.getDocument({ data: arrayBuffer, wasmUrl: vendor('pdfjs/wasm/') });
  const pdf = await task.promise;
  return { pdf, close: () => task.destroy() };
}

export async function renderPageGray(pdf, pageNumber) {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: RENDER_DPI / 72 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport }).promise;
  const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const gray = rgbaToGray(rgba, canvas.width, canvas.height);
  canvas.width = canvas.height = 0; // release the bitmap
  page.cleanup();
  return gray;
}

export function grayToDataUrl(img) {
  if (!img) return '';
  const canvas = document.createElement('canvas');
  canvas.width = img.w;
  canvas.height = img.h;
  const ctx = canvas.getContext('2d');
  const out = ctx.createImageData(img.w, img.h);
  for (let i = 0, j = 0; i < img.data.length; i++, j += 4) {
    out.data[j] = out.data[j + 1] = out.data[j + 2] = img.data[i];
    out.data[j + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  return canvas.toDataURL('image/png');
}
