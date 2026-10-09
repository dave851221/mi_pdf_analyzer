import { extractPage } from './extract.js';
import { createEngine, openPdf, renderPageGray, grayToDataUrl } from './ocr.js';
import { matchCatalog, matchSite, parseQty, periodLabel } from './matching.js';
import { toCsv, parseDetailCsv, decodeCsvBytes, DETAIL_COLUMNS } from './csv.js';
import {
  loadSettings, saveSettings, parseSettingsJson,
  sitesToText, parseSitesText, catalogToText, parseCatalogText,
} from './settings.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => n.toLocaleString('en-US');

const state = {
  settings: loadSettings(),
  pages: [],
  selectedSites: new Set(),
  selectedPeriods: new Set(),
  knownPeriods: new Set(),
};
window.__state = state; // for debugging and automated tests

let engine = null;
let nextId = 1;
let queue = Promise.resolve();

// ---------- messages & progress ----------

function addMessage(text, cls = '') {
  const li = document.createElement('li');
  li.className = cls;
  li.textContent = text;
  $('messages').append(li);
}

function setStatus(text, fraction) {
  $('status').hidden = text === null;
  if (text === null) return;
  $('status-text').textContent = text;
  $('progress-bar').style.width = `${Math.round((fraction ?? 0) * 100)}%`;
}

// ---------- file intake ----------

function handleFiles(fileList) {
  const files = [...fileList];
  queue = queue.then(() => processFiles(files)).catch((err) => {
    console.error(err);
    addMessage(`發生錯誤：${err.message || err}`, 'error');
    setStatus(null);
  });
  return queue;
}

async function processFiles(files) {
  const isType = (f, ext) => f.name.toLowerCase().endsWith(ext);
  const csvs = files.filter((f) => isType(f, '.csv'));
  const pdfs = files.filter((f) => isType(f, '.pdf'));
  for (const f of files) if (!csvs.includes(f) && !pdfs.includes(f)) addMessage(`${f.name}：不支援的檔案類型（只接受 PDF 或 CSV）`, 'error');

  if (csvs.length) await importCsv(csvs);
  for (let i = 0; i < pdfs.length; i++) await processPdf(pdfs[i], i, pdfs.length);
  setStatus(null);
}

async function processPdf(file, index, total) {
  if (!engine) {
    setStatus('正在載入辨識引擎（第一次會比較久）…', 0);
    engine = await createEngine();
  }
  let pdf, close;
  try {
    ({ pdf, close } = await openPdf(await file.arrayBuffer()));
  } catch (err) {
    addMessage(`${file.name}：無法開啟這個 PDF（${err.message || err}）`, 'error');
    return;
  }
  const pageCount = pdf.numPages;
  for (let n = 1; n <= pageCount; n++) {
    setStatus(`${file.name}：辨識第 ${n} / ${pageCount} 頁`, (index + (n - 1) / pageCount) / total);
    const gray = await renderPageGray(pdf, n);
    const result = await extractPage(gray, engine, state.settings);
    state.pages.push(toPage(file.name, n, result));
    renderAll();
  }
  await close();
  addMessage(`${file.name}：完成，共 ${pageCount} 頁`, 'ok');
}

function toPage(fileName, pageNo, r) {
  const base = { id: nextId++, source: 'pdf', file: fileName, pageNo, edited: {}, warnings: [], rows: [], flags: { site: null, period: null } };
  if (r.error) return { ...base, error: r.error, site: '', period: '' };
  return {
    ...base,
    site: r.site,
    period: r.period,
    flags: r.flags,
    warnings: r.warnings,
    headerText: r.headerText,
    headerImg: grayToDataUrl(r.headerCrop),
    rows: r.rows.map((row) => ({
      code: row.code, name: row.name, qty: row.qty,
      flags: row.flags, raw: row.raw, edited: {},
      codeImg: grayToDataUrl(row.crops.code), qtyImg: grayToDataUrl(row.crops.qty),
    })),
  };
}

async function importCsv(files) {
  const records = [];
  for (const file of files) {
    const parsed = parseDetailCsv(decodeCsvBytes(await file.arrayBuffer()));
    if (parsed.errors.length) {
      addMessage(`${file.name}：內容有問題，沒有匯入。`, 'error');
      parsed.errors.slice(0, 10).forEach((e) => addMessage(`　${e}`, 'error'));
      if (parsed.errors.length > 10) addMessage(`　…還有 ${parsed.errors.length - 10} 個問題`, 'error');
      return;
    }
    records.push(...parsed.records.map((rec) => ({ ...rec, file: rec.file || file.name })));
  }
  if (state.pages.length && !confirm('匯入 CSV 會取代目前的所有資料，確定嗎？')) return;

  const groups = new Map();
  for (const rec of records) {
    const key = [rec.file, rec.page, rec.period, rec.site].join('\u0001');
    if (!groups.has(key)) {
      groups.set(key, {
        id: nextId++, source: 'csv', file: rec.file, pageNo: rec.page, site: rec.site, period: rec.period,
        edited: {}, warnings: [], rows: [], flags: { site: null, period: null },
      });
    }
    groups.get(key).rows.push({ code: rec.code, name: rec.name, qty: rec.qty, flags: { code: null, qty: null }, edited: {} });
  }
  state.pages = [...groups.values()];
  state.knownPeriods.clear();
  state.selectedPeriods.clear();
  addMessage(`已從 CSV 匯入 ${records.length} 筆資料`, 'ok');
  renderAll();
}

// ---------- learning from confirmed data ----------

function learn(site, drugs) {
  const s = state.settings;
  if (site && !s.sites.includes(site)) s.sites.push(site);
  for (const d of drugs) if (d.code && !s.catalog.some((e) => e.code === d.code)) s.catalog.push({ code: d.code, name: d.name });
  state.settings = saveSettings(s);
  renderSettings();
  rematch();
}

// Re-run list matching on everything still unconfirmed, using the stored OCR text.
function rematch() {
  for (const page of state.pages) {
    if (page.source !== 'pdf' || page.error) continue;
    if (page.flags.site && !page.edited.site) {
      const m = matchSite(page.headerText, state.settings.sites);
      page.site = m.site;
      page.flags.site = m.flag;
    }
    for (const row of page.rows) {
      if (!row.flags.code || row.edited.code) continue;
      const m = matchCatalog(row.raw.code, row.raw.name, state.settings.catalog);
      row.code = m.code;
      row.name = m.name;
      row.flags.code = m.flag;
    }
  }
}

// ---------- derived data ----------

const qtyProblem = (row) => (parseQty(row.qty) === null ? '數量必須是 0 以上的整數' : null);

function pendingCount(page) {
  if (page.error) return 0;
  let n = 0;
  if (page.flags.site || !page.site) n++;
  if (page.flags.period) n++;
  for (const row of page.rows) {
    if (row.flags.code || !row.code) n++;
    if (row.flags.qty || qtyProblem(row)) n++;
  }
  return n;
}

function allSites() {
  const sites = [...state.settings.sites];
  for (const p of state.pages) if (p.site && !sites.includes(p.site)) sites.push(p.site);
  return sites;
}

function allPeriods() {
  return [...new Set(state.pages.filter((p) => !p.error).map((p) => p.period))].sort();
}

function computeResults() {
  const drugs = new Map();
  for (const page of state.pages) {
    if (page.error || !state.selectedPeriods.has(page.period)) continue;
    for (const row of page.rows) {
      const qty = parseQty(row.qty);
      if (qty === null || !row.code) continue;
      if (!drugs.has(row.code)) drugs.set(row.code, { code: row.code, name: row.name, selected: 0, total: 0, bySite: new Map() });
      const d = drugs.get(row.code);
      d.total += qty;
      d.bySite.set(page.site, (d.bySite.get(page.site) || 0) + qty);
      if (state.selectedSites.has(page.site)) d.selected += qty;
    }
  }
  const order = new Map(state.settings.catalog.map((e, i) => [e.code, i]));
  const list = [...drugs.values()];
  list.forEach((d, i) => { d.rank = order.has(d.code) ? order.get(d.code) : 1e6 + i; d.share = d.total ? d.selected / d.total : null; });
  return list.sort((a, b) => a.rank - b.rank);
}

function collectWarnings() {
  const out = [];
  const pending = state.pages.reduce((n, p) => n + pendingCount(p), 0);
  if (pending) out.push(`還有 <b>${pending}</b> 格待確認，確認前結果可能不正確。<a href="#details">前往校對</a>`);

  for (const p of state.pages) if (p.error) out.push(`${esc(p.file)} 第 ${esc(p.pageNo)} 頁無法判讀（${esc(p.error)}），這一頁沒有計入。`);

  const groups = new Map();
  for (const p of state.pages) {
    if (p.error || !p.site) continue;
    const key = `${p.period}\u0001${p.site}`;
    groups.set(key, [...(groups.get(key) || []), p]);
  }
  for (const pages of groups.values()) {
    if (pages.length < 2) continue;
    const where = pages.map((p) => `${esc(p.file)} 第 ${esc(p.pageNo)} 頁`).join('、');
    out.push(`${esc(periodLabel(pages[0].period))}「${esc(pages[0].site)}」出現 ${pages.length} 次（${where}），數量會被重複計算。請刪除多餘的頁面。`);
  }

  const expected = allSites();
  for (const period of allPeriods()) {
    const present = new Set(state.pages.filter((p) => !p.error && p.period === period).map((p) => p.site));
    const missing = expected.filter((s) => !present.has(s));
    if (missing.length) out.push(`${esc(periodLabel(period))} 缺少院區：${missing.map(esc).join('、')}，總數量（分母）會偏低。`);
  }
  return out;
}

// ---------- rendering ----------

function renderAll() {
  const active = document.activeElement && document.activeElement.dataset ? { ...document.activeElement.dataset } : null;
  for (const period of allPeriods()) {
    if (!state.knownPeriods.has(period)) { state.knownPeriods.add(period); state.selectedPeriods.add(period); }
  }
  const has = state.pages.length > 0;
  $('results').hidden = !has;
  $('details').hidden = !has;
  if (has) { renderResults(); renderPages(); }
  if (active && active.field) {
    const sel = `[data-page="${active.page}"][data-field="${active.field}"]` + (active.row !== undefined ? `[data-row="${active.row}"]` : '');
    const el = document.querySelector(sel);
    if (el) el.focus();
  }
}

function renderResults() {
  const title = state.settings.title;
  $('results-title').textContent = title ? `${title}｜分析結果` : '分析結果';

  const warnings = collectWarnings();
  $('banners').innerHTML = warnings.length
    ? `<div class="banner">請留意：<ul>${warnings.map((w) => `<li>${w}</li>`).join('')}</ul></div>` : '';

  const sites = allSites();
  for (const s of [...state.selectedSites]) if (!sites.includes(s)) state.selectedSites.delete(s);
  $('site-filter').innerHTML = sites.map((s) =>
    `<label><input type="checkbox" data-filter="site" value="${esc(s)}" ${state.selectedSites.has(s) ? 'checked' : ''}> ${esc(s)}</label>`).join('')
    || '<span class="hint">尚無院區</span>';
  $('period-filter').innerHTML = allPeriods().map((p) =>
    `<label><input type="checkbox" data-filter="period" value="${esc(p)}" ${state.selectedPeriods.has(p) ? 'checked' : ''}> ${esc(periodLabel(p))}</label>`).join('');

  const chosen = sites.filter((s) => state.selectedSites.has(s));
  $('formula').textContent = chosen.length
    ? `佔比 = 選定院區（${chosen.join('、')}）的數量 ÷ 全部院區的總數量`
    : '請先勾選上方的「選定院區」，就會算出各藥材碼的佔比。';

  const results = computeResults();
  renderChart(results, chosen.length > 0);
  renderResultTable(results);
  renderMatrix(results, sites);
}

const pct = (share, digits) => (share === null ? '—' : `${(share * 100).toFixed(digits)}%`);

function renderChart(results, hasSelection) {
  const el = $('chart');
  if (!results.length || !hasSelection) {
    el.innerHTML = `<div class="chart-empty">${results.length ? '勾選院區後會在這裡顯示長條圖。' : '所選期間沒有資料。'}</div>`;
    return;
  }
  const maxPct = Math.max(...results.map((d) => (d.share || 0) * 100));
  const axisMax = [5, 10, 20, 25, 50, 100].find((v) => v >= maxPct) || 100;
  const step = { 5: 1, 10: 2, 20: 5, 25: 5, 50: 10, 100: 20 }[axisMax];
  const ticks = [];
  for (let t = 0; t <= axisMax; t += step) ticks.push(t);
  const grid = ticks.map((t) => `<i class="gridline" style="left:${(t / axisMax) * 100}%"></i>`).join('');

  const rows = results.map((d, i) => {
    const width = d.share === null ? 0 : (d.share * 100 / axisMax) * 100;
    return `<div class="chart-row-hit" data-index="${i}">
      <div class="chart-label">${esc(d.code)}</div>
      <div class="chart-track" tabindex="0" aria-label="${esc(d.code)} ${pct(d.share, 1)}">
        ${grid}
        ${d.share === null ? '' : `<div class="chart-bar" style="width:${width}%"></div>`}
        <div class="chart-value" style="left:${width}%">${pct(d.share, 1)}</div>
      </div>
    </div>`;
  }).join('');
  const axis = ticks.map((t) => `<span style="left:${(t / axisMax) * 100}%">${t}%</span>`).join('');
  el.innerHTML = `<div class="chart-rows">${rows}<div></div><div class="chart-axis">${axis}</div></div>`;
  el._results = results;
}

function renderResultTable(results) {
  const body = results.map((d) => `<tr>
    <td>${esc(d.code)}</td><td>${esc(d.name)}</td>
    <td class="num">${fmt(d.selected)}</td><td class="num">${fmt(d.total)}</td><td class="num">${pct(d.share, 2)}</td>
  </tr>`).join('');
  $('result-table').innerHTML = `<thead><tr>
    <th>藥材碼</th><th>品名</th><th class="num">選定院區數量</th><th class="num">全部院區總數量</th><th class="num">佔比</th>
  </tr></thead><tbody>${body}</tbody>`;
}

function renderMatrix(results, sites) {
  const head = sites.map((s) => `<th class="num">${esc(s)}</th>`).join('');
  const body = results.map((d) => `<tr><td>${esc(d.code)}</td>${sites.map((s) => `<td class="num">${fmt(d.bySite.get(s) || 0)}</td>`).join('')}<td class="num"><b>${fmt(d.total)}</b></td></tr>`).join('');
  $('matrix-table').innerHTML = `<thead><tr><th>藥材碼</th>${head}<th class="num">合計</th></tr></thead><tbody>${body}</tbody>`;
}

function renderPages() {
  $('pages').innerHTML = state.pages.map(renderPage).join('');
  $('site-options')?.remove();
  const list = document.createElement('datalist');
  list.id = 'site-options';
  list.innerHTML = allSites().map((s) => `<option value="${esc(s)}">`).join('');
  document.body.append(list);
}

function renderPage(page) {
  const pending = pendingCount(page);
  const name = `<span class="name">${esc(page.file)}</span><span>第 ${esc(page.pageNo) || '—'} 頁</span>`;
  const remove = `<button class="small danger" data-action="delete" data-page="${page.id}">刪除本頁</button>`;
  if (page.error) {
    return `<div class="page-card has-flag"><div class="page-head">${name}<span class="spacer"></span>${remove}</div>
      <div class="page-warn">無法自動判讀：${esc(page.error)}。請改用 CSV 補上這一頁的資料。</div></div>`;
  }
  const siteFlag = page.flags.site || (!page.site ? '請輸入院區' : null);
  const rows = page.rows.map((row, i) => {
    const codeFlag = row.flags.code || (!row.code ? '藥材碼空白' : null);
    const qtyFlag = row.flags.qty || qtyProblem(row);
    const notes = [codeFlag, qtyFlag].filter(Boolean).map(esc).join('<br>');
    const img = (src) => (src ? `<img class="cell" src="${src}" alt="">` : '');
    const attrs = `data-page="${page.id}" data-row="${i}"`;
    return `<tr class="row ${codeFlag || qtyFlag ? 'has-flag' : ''}">
      <td class="num">${i + 1}</td>
      <td>${img(row.codeImg)}</td>
      <td><input type="text" class="code ${codeFlag ? 'flagged' : ''}" value="${esc(row.code)}" ${attrs} data-field="code" spellcheck="false"></td>
      <td>${esc(row.name)}</td>
      <td>${img(row.qtyImg)}</td>
      <td><input type="text" inputmode="numeric" class="qty ${qtyFlag ? 'flagged' : ''}" value="${esc(row.qty)}" ${attrs} data-field="qty"></td>
      <td class="flag-note">${notes}</td>
    </tr>`;
  }).join('');
  const hasImages = page.source === 'pdf';
  return `<div class="page-card ${pending ? 'has-flag' : ''}">
    <div class="page-head">
      ${name}
      ${page.headerImg ? `<img src="${page.headerImg}" alt="表頭原圖">` : ''}
      <label>期間 <input type="text" class="${page.flags.period ? 'flagged' : ''}" value="${esc(page.period)}" data-page="${page.id}" data-field="period" title="${esc(page.flags.period || '')}"></label>
      <label>院區 <input type="text" class="site ${siteFlag ? 'flagged' : ''}" value="${esc(page.site)}" list="site-options" data-page="${page.id}" data-field="site" title="${esc(siteFlag || '')}"></label>
      <span class="badge ${pending ? 'pending' : ''}">${pending ? `待確認 ${pending} 格` : '已確認'}</span>
      <span class="spacer"></span>
      ${pending ? `<button class="small primary" data-action="confirm" data-page="${page.id}">本頁確認無誤</button>` : ''}
      ${remove}
    </div>
    ${page.warnings.map((w) => `<div class="page-warn">${esc(w)}</div>`).join('')}
    ${siteFlag || page.flags.period ? `<div class="page-warn">${[siteFlag, page.flags.period].filter(Boolean).map(esc).join('；')}</div>` : ''}
    <div class="table-wrap"><table class="data"><thead><tr>
      <th class="num">列</th><th>${hasImages ? '藥材碼原圖' : ''}</th><th>藥材碼</th><th>品名</th><th>${hasImages ? '數量原圖' : ''}</th><th>數量</th><th>備註</th>
    </tr></thead><tbody>${rows}</tbody></table></div>
  </div>`;
}

function renderSettings() {
  $('set-title').value = state.settings.title;
  $('set-sites').value = sitesToText(state.settings.sites);
  $('set-catalog').value = catalogToText(state.settings.catalog);
}

// ---------- editing ----------

const pageById = (id) => state.pages.find((p) => p.id === +id);

function onEdit(input) {
  const page = pageById(input.dataset.page);
  if (!page) return;
  const value = input.value.trim();
  const field = input.dataset.field;
  if (field === 'site') {
    page.site = value;
    page.flags.site = null;
    page.edited.site = true;
    if (value) learn(value, []);
  } else if (field === 'period') {
    page.period = value;
    page.flags.period = null;
  } else {
    const row = page.rows[+input.dataset.row];
    row[field] = value;
    row.flags[field] = null;
    row.edited[field] = true;
    if (field === 'code' && value) learn('', [{ code: value, name: row.name }]);
  }
  renderAll();
}

function confirmPage(page) {
  page.flags.period = null;
  if (page.site) { page.flags.site = null; page.edited.site = true; }
  for (const row of page.rows) {
    if (row.code) { row.flags.code = null; row.edited.code = true; }
    if (!qtyProblem(row)) row.flags.qty = null;
  }
  learn(page.site, page.rows.filter((r) => r.code));
  renderAll();
}

// ---------- export ----------

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function detailCsv() {
  const rows = [DETAIL_COLUMNS];
  for (const p of state.pages) for (const r of p.rows) rows.push([p.file, p.pageNo, p.period, p.site, r.code, r.name, r.qty]);
  return toCsv(rows);
}

function resultCsv() {
  const sites = allSites().filter((s) => state.selectedSites.has(s)).join('、');
  const periods = allPeriods().filter((p) => state.selectedPeriods.has(p)).map(periodLabel).join('、');
  const rows = [['藥材碼', '品名', '選定院區數量', '全部院區總數量', '佔比(%)', '選定院區', '期間']];
  for (const d of computeResults()) rows.push([d.code, d.name, d.selected, d.total, d.share === null ? '' : (d.share * 100).toFixed(2), sites, periods]);
  return toCsv(rows);
}

// ---------- tooltip ----------

function showTooltip(target, x, y) {
  const hit = target.closest('.chart-row-hit');
  const tip = $('tooltip');
  const results = $('chart')._results;
  if (!hit || !results) { tip.hidden = true; return; }
  const d = results[+hit.dataset.index];
  tip.innerHTML = `<b>${esc(d.code)}　${pct(d.share, 2)}</b><span>${esc(d.name)}</span><br>
    <span>選定院區 ${fmt(d.selected)} ÷ 全部院區 ${fmt(d.total)}</span>`;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(x + 14, window.innerWidth - r.width - 8)}px`;
  tip.style.top = `${Math.min(y + 14, window.innerHeight - r.height - 8)}px`;
}

// ---------- wiring ----------

function init() {
  const drop = $('dropzone'), input = $('file-input');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => { handleFiles(input.files); input.value = ''; });
  for (const type of ['dragenter', 'dragover']) {
    document.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('over'); });
  }
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('over'); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });

  $('results').addEventListener('change', (e) => {
    const { filter } = e.target.dataset;
    if (!filter) return;
    const set = filter === 'site' ? state.selectedSites : state.selectedPeriods;
    if (e.target.checked) set.add(e.target.value); else set.delete(e.target.value);
    renderResults();
  });
  $('pages').addEventListener('change', (e) => { if (e.target.dataset.field) onEdit(e.target); });
  $('pages').addEventListener('click', (e) => {
    const { action, page } = e.target.dataset;
    if (action === 'confirm') confirmPage(pageById(page));
    if (action === 'delete') { state.pages = state.pages.filter((p) => p.id !== +page); renderAll(); }
  });
  $('only-pending').addEventListener('change', (e) => $('pages').classList.toggle('only-pending', e.target.checked));

  $('export-detail').addEventListener('click', () => download('明細.csv', detailCsv(), 'text/csv;charset=utf-8'));
  $('export-result').addEventListener('click', () => download('佔比結果.csv', resultCsv(), 'text/csv;charset=utf-8'));
  $('clear-all').addEventListener('click', () => {
    if (!confirm('確定要清除目前所有資料嗎？（設定不會被清除）')) return;
    state.pages = [];
    state.knownPeriods.clear();
    state.selectedPeriods.clear();
    $('messages').innerHTML = '';
    renderAll();
  });

  $('set-save').addEventListener('click', () => {
    state.settings = saveSettings({
      title: $('set-title').value,
      sites: parseSitesText($('set-sites').value),
      catalog: parseCatalogText($('set-catalog').value),
    });
    renderSettings();
    rematch();
    renderAll();
    $('set-note').textContent = '已儲存。';
  });
  $('set-export').addEventListener('click', () => download('設定檔.json', JSON.stringify(state.settings, null, 2), 'application/json'));
  $('set-import').addEventListener('click', () => $('set-file').click());
  $('set-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      state.settings = saveSettings(parseSettingsJson(await file.text()));
      renderSettings();
      rematch();
      renderAll();
      $('set-note').textContent = '已匯入設定檔。';
    } catch {
      $('set-note').textContent = '這不是有效的設定檔。';
    }
  });

  const chart = $('chart');
  chart.addEventListener('mousemove', (e) => showTooltip(e.target, e.clientX, e.clientY));
  chart.addEventListener('mouseleave', () => { $('tooltip').hidden = true; });
  chart.addEventListener('focusin', (e) => {
    const r = e.target.getBoundingClientRect();
    showTooltip(e.target, r.left + 40, r.bottom - 10);
  });
  chart.addEventListener('focusout', () => { $('tooltip').hidden = true; });

  renderSettings();
  if (!state.settings.sites.length && !state.settings.catalog.length) $('settings').open = true;
}

init();
