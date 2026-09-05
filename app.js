const DAY = 86_400_000;
const HOUR = 3_600_000;
const JST = 9 * HOUR;

const state = {
  rows: [],
  byTs: new Map(),
  meta: null,
  period: 180,
  results: [],
  selected: null,
};

const $ = (id) => document.getElementById(id);
const els = {
  dataStatus: $('dataStatus'),
  periodPresets: $('periodPresets'),
  customDates: $('customDates'),
  fromDate: $('fromDate'),
  toDate: $('toDate'),
  direction: $('direction'),
  entryHour: $('entryHour'),
  holdHours: $('holdHours'),
  minTrades: $('minTrades'),
  sortMetric: $('sortMetric'),
  strategyCount: $('strategyCount'),
  bestSharpe: $('bestSharpe'),
  bestWin: $('bestWin'),
  barsUsed: $('barsUsed'),
  rangeLabel: $('rangeLabel'),
  resultsBody: $('resultsBody'),
  mobileResults: $('mobileResults'),
  emptyState: $('emptyState'),
  detailPanel: $('detailPanel'),
  detailTitle: $('detailTitle'),
  detailMetrics: $('detailMetrics'),
  equityChart: $('equityChart'),
  recentTrades: $('recentTrades'),
  closeDetail: $('closeDetail'),
  footerMeta: $('footerMeta'),
};

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map(x => x.trim().toLowerCase());
  const idx = Object.fromEntries(header.map((k, i) => [k, i]));
  return lines.slice(1).map(line => {
    const c = line.split(',');
    const timestamp = Number(c[idx.timestamp]);
    return {
      timestamp,
      open: Number(c[idx.open]),
      high: Number(c[idx.high]),
      low: Number(c[idx.low]),
      close: Number(c[idx.close]),
      volume: idx.volume === undefined ? 0 : Number(c[idx.volume]),
    };
  }).filter(r => Number.isFinite(r.timestamp) && Number.isFinite(r.open) && r.open > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
}

function jstParts(ts) {
  const d = new Date(ts + JST);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
  };
}

function jstHour(ts) { return jstParts(ts).h; }

function dateInputJst(ts) {
  const p = jstParts(ts);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

function dateLabelJst(ts) {
  const p = jstParts(ts);
  return `${p.y}/${String(p.m).padStart(2, '0')}/${String(p.d).padStart(2, '0')}`;
}

function dateTimeLabelJst(ts) {
  const p = jstParts(ts);
  return `${p.y}/${String(p.m).padStart(2, '0')}/${String(p.d).padStart(2, '0')} ${String(p.h).padStart(2, '0')}:00`;
}

function timeLabel(hour) { return `${String(hour).padStart(2, '0')}:00`; }
function exitHour(entry, hold) { return (entry + hold) % 24; }
function pct(x, digits = 4) { return `${(x * 100).toFixed(digits)}%`; }
function fixed(x, digits = 3) { return Number.isFinite(x) ? x.toFixed(digits) : '—'; }
function signedPct(x, digits = 4) { return `${x >= 0 ? '+' : ''}${(x * 100).toFixed(digits)}%`; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function getRange() {
  const last = state.rows.at(-1)?.timestamp ?? Date.now();
  const first = state.rows[0]?.timestamp ?? last;
  if (state.period === 'custom') {
    const from = els.fromDate.value ? Date.parse(`${els.fromDate.value}T00:00:00+09:00`) : first;
    const to = els.toDate.value ? Date.parse(`${els.toDate.value}T23:59:59+09:00`) : last;
    return { start: Math.max(first, from), end: Math.min(last, to) };
  }
  const days = Number(state.period);
  return { start: Math.max(first, last - days * DAY), end: last };
}

function sampleStd(values, mean) {
  if (values.length < 2) return NaN;
  let s = 0;
  for (const v of values) s += (v - mean) ** 2;
  return Math.sqrt(s / (values.length - 1));
}

function calcMetrics(trades) {
  const r = trades.map(t => t.ret);
  const n = r.length;
  const mean = n ? r.reduce((a, b) => a + b, 0) / n : NaN;
  const std = sampleStd(r, mean);
  const wins = r.filter(v => v > 0).length;
  const grossWin = r.filter(v => v > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(r.filter(v => v < 0).reduce((a, b) => a + b, 0));
  let equity = 0, peak = 0, maxDd = 0;
  for (const v of r) {
    equity += v;
    peak = Math.max(peak, equity);
    maxDd = Math.min(maxDd, equity - peak);
  }
  return {
    trades: n,
    avgRet: mean,
    winRate: n ? wins / n : NaN,
    sharpe: std > 0 ? mean / std : NaN,
    std,
    totalRet: r.reduce((a, b) => a + b, 0),
    maxDd,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : NaN,
    best: n ? Math.max(...r) : NaN,
    worst: n ? Math.min(...r) : NaN,
  };
}

function buildTrades(entryHour, hold, direction, range) {
  const sign = direction === 'long' ? 1 : -1;
  const out = [];
  for (const row of state.rows) {
    if (row.timestamp < range.start || row.timestamp > range.end) continue;
    if (jstHour(row.timestamp) !== entryHour) continue;
    const exitTs = row.timestamp + hold * HOUR;
    if (exitTs > range.end) continue;
    const exitRow = state.byTs.get(exitTs);
    if (!exitRow) continue;
    const raw = exitRow.open / row.open - 1;
    out.push({
      entryTs: row.timestamp,
      exitTs,
      entry: row.open,
      exit: exitRow.open,
      ret: sign * raw,
    });
  }
  return out;
}

function screen() {
  if (!state.rows.length) return;
  const range = getRange();
  const minTrades = Number(els.minTrades.value);
  const entryFilter = els.entryHour.value;
  const holdFilter = els.holdHours.value;
  const dirFilter = els.direction.value;
  const entries = entryFilter === 'all' ? [...Array(24).keys()] : [Number(entryFilter)];
  const holds = holdFilter === 'all' ? [...Array(24).keys()].map(i => i + 1) : [Number(holdFilter)];
  const dirs = dirFilter === 'both' ? ['long', 'short'] : [dirFilter];
  const results = [];

  for (const entry of entries) {
    for (const hold of holds) {
      for (const direction of dirs) {
        const trades = buildTrades(entry, hold, direction, range);
        if (trades.length < minTrades) continue;
        const metrics = calcMetrics(trades);
        if (!Number.isFinite(metrics.sharpe) && els.sortMetric.value === 'sharpe') continue;
        results.push({ entry, hold, exit: exitHour(entry, hold), direction, trades, ...metrics });
      }
    }
  }

  const sortKey = els.sortMetric.value;
  results.sort((a, b) => {
    const av = Number.isFinite(a[sortKey]) ? a[sortKey] : -Infinity;
    const bv = Number.isFinite(b[sortKey]) ? b[sortKey] : -Infinity;
    if (bv !== av) return bv - av;
    if (b.sharpe !== a.sharpe) return b.sharpe - a.sharpe;
    return b.trades - a.trades;
  });
  state.results = results;
  renderResults(range);
}

function renderResults(range) {
  const top = state.results.slice(0, 100);
  els.strategyCount.textContent = state.results.length.toLocaleString();
  const finiteSharpe = state.results.filter(x => Number.isFinite(x.sharpe));
  const bestS = finiteSharpe.length ? Math.max(...finiteSharpe.map(x => x.sharpe)) : NaN;
  const bestW = state.results.length ? Math.max(...state.results.map(x => x.winRate)) : NaN;
  els.bestSharpe.textContent = fixed(bestS, 3);
  els.bestWin.textContent = Number.isFinite(bestW) ? `${(bestW * 100).toFixed(1)}%` : '—';
  const bars = state.rows.filter(r => r.timestamp >= range.start && r.timestamp <= range.end).length;
  els.barsUsed.textContent = bars.toLocaleString();
  els.rangeLabel.textContent = `${dateLabelJst(range.start)} – ${dateLabelJst(range.end)}`;

  els.emptyState.classList.toggle('hidden', top.length > 0);
  els.resultsBody.innerHTML = top.map((s, i) => `
    <tr data-index="${i}">
      <td class="rank">${i + 1}</td>
      <td><span class="dir ${s.direction}">${s.direction.toUpperCase()}</span></td>
      <td>${timeLabel(s.entry)}</td>
      <td>${timeLabel(s.exit)}</td>
      <td>${s.hold}h</td>
      <td>${s.trades}</td>
      <td>${(s.winRate * 100).toFixed(1)}</td>
      <td class="${s.avgRet >= 0 ? 'positive' : 'negative'}">${(s.avgRet * 100).toFixed(4)}</td>
      <td class="metric-strong ${s.sharpe >= 0 ? 'positive' : 'negative'}">${fixed(s.sharpe, 3)}</td>
    </tr>`).join('');

  els.mobileResults.innerHTML = top.map((s, i) => `
    <article class="mobile-card" data-index="${i}">
      <div class="mobile-top">
        <div class="mobile-top-left"><span class="mobile-rank">#${i + 1}</span><span class="dir ${s.direction}">${s.direction.toUpperCase()}</span></div>
        <div><div class="mobile-strategy">${timeLabel(s.entry)} → ${timeLabel(s.exit)}</div><div class="mobile-sub">Hold ${s.hold}h · ${s.trades} trades</div></div>
      </div>
      <div class="mobile-metrics">
        <div class="mobile-metric"><span>Sharpe</span><strong class="${s.sharpe >= 0 ? 'positive' : 'negative'}">${fixed(s.sharpe, 3)}</strong></div>
        <div class="mobile-metric"><span>Win%</span><strong>${(s.winRate * 100).toFixed(1)}</strong></div>
        <div class="mobile-metric"><span>AvgRet</span><strong class="${s.avgRet >= 0 ? 'positive' : 'negative'}">${(s.avgRet * 100).toFixed(4)}%</strong></div>
        <div class="mobile-metric"><span>Trades</span><strong>${s.trades}</strong></div>
      </div>
    </article>`).join('');

  document.querySelectorAll('[data-index]').forEach(el => {
    el.addEventListener('click', () => showDetail(top[Number(el.dataset.index)]));
  });

  if (state.selected) {
    const match = top.find(s => s.entry === state.selected.entry && s.hold === state.selected.hold && s.direction === state.selected.direction);
    if (!match) hideDetail();
  }
}

function showDetail(s) {
  if (!s) return;
  state.selected = s;
  els.detailPanel.classList.remove('hidden');
  els.detailTitle.innerHTML = `${timeLabel(s.entry)} → ${timeLabel(s.exit)} · ${s.hold}h · <span class="${s.direction === 'long' ? 'positive' : 'negative'}">${s.direction.toUpperCase()}</span>`;
  const pf = Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : s.profitFactor === Infinity ? '∞' : '—';
  els.detailMetrics.innerHTML = [
    ['Sharpe', fixed(s.sharpe, 3)],
    ['Win rate', `${(s.winRate * 100).toFixed(1)}%`],
    ['Avg return', signedPct(s.avgRet, 4)],
    ['Total return', signedPct(s.totalRet, 2)],
    ['Max drawdown', signedPct(s.maxDd, 2)],
    ['Profit factor', pf],
    ['Trades', String(s.trades)],
    ['Best trade', signedPct(s.best, 3)],
    ['Worst trade', signedPct(s.worst, 3)],
    ['Volatility', pct(s.std, 3)],
  ].map(([k, v]) => `<div class="metric-box"><span>${k}</span><strong>${v}</strong></div>`).join('');

  const recent = s.trades.slice(-12).reverse();
  els.recentTrades.innerHTML = recent.map(t => `
    <div class="trade-chip">${dateTimeLabelJst(t.entryTs)}<b class="${t.ret >= 0 ? 'positive' : 'negative'}">${signedPct(t.ret, 3)}</b></div>`).join('');
  drawEquity(s);
  els.detailPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideDetail() {
  state.selected = null;
  els.detailPanel.classList.add('hidden');
}

function drawEquity(s) {
  const canvas = els.equityChart;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(320, Math.floor(rect.width));
  const h = 260;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const pad = { l: 46, r: 14, t: 14, b: 28 };
  const cw = w - pad.l - pad.r;
  const ch = h - pad.t - pad.b;
  let cum = 0;
  const pts = [{ x: 0, y: 0 }];
  s.trades.forEach((t, i) => { cum += t.ret; pts.push({ x: i + 1, y: cum }); });
  const ys = pts.map(p => p.y);
  let ymin = Math.min(...ys, 0), ymax = Math.max(...ys, 0);
  if (ymax === ymin) { ymax += .001; ymin -= .001; }
  const margin = (ymax - ymin) * .08;
  ymin -= margin; ymax += margin;
  const xScale = x => pad.l + (x / Math.max(1, pts.length - 1)) * cw;
  const yScale = y => pad.t + (1 - (y - ymin) / (ymax - ymin)) * ch;

  ctx.font = '10px ui-sans-serif, system-ui';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const yv = ymin + (ymax - ymin) * i / 4;
    const y = yScale(yv);
    ctx.strokeStyle = 'rgba(91,126,160,.16)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillStyle = '#6f879f';
    ctx.fillText(`${(yv * 100).toFixed(1)}%`, pad.l - 7, y);
  }

  const zeroY = yScale(0);
  ctx.strokeStyle = 'rgba(143,170,196,.28)';
  ctx.beginPath(); ctx.moveTo(pad.l, zeroY); ctx.lineTo(w - pad.r, zeroY); ctx.stroke();

  const grad = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
  if (s.totalRet >= 0) {
    grad.addColorStop(0, 'rgba(82,168,255,.28)');
    grad.addColorStop(1, 'rgba(82,168,255,0)');
  } else {
    grad.addColorStop(0, 'rgba(255,111,125,.24)');
    grad.addColorStop(1, 'rgba(255,111,125,0)');
  }
  ctx.beginPath();
  pts.forEach((p, i) => { const x = xScale(p.x), y = yScale(p.y); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.lineTo(xScale(pts.at(-1).x), yScale(0));
  ctx.lineTo(xScale(0), yScale(0));
  ctx.closePath(); ctx.fillStyle = grad; ctx.fill();

  ctx.beginPath();
  pts.forEach((p, i) => { const x = xScale(p.x), y = yScale(p.y); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.strokeStyle = s.totalRet >= 0 ? '#67b5ff' : '#ff7c89';
  ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();

  ctx.fillStyle = '#6f879f';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText('oldest', pad.l, h - pad.b + 8);
  ctx.fillText('latest', w - pad.r, h - pad.b + 8);
}

function populateControls() {
  for (let h = 0; h < 24; h++) {
    els.entryHour.insertAdjacentHTML('beforeend', `<option value="${h}">${timeLabel(h)} JST</option>`);
    els.holdHours.insertAdjacentHTML('beforeend', `<option value="${h + 1}">${h + 1}h</option>`);
  }
}

function setStatus(kind, text) {
  els.dataStatus.className = `data-pill ${kind || ''}`.trim();
  els.dataStatus.querySelector('span:last-child').textContent = text;
}

async function loadData() {
  try {
    const [csvRes, metaRes] = await Promise.all([
      fetch('data/usdjpy_h1.csv', { cache: 'no-store' }),
      fetch('data/meta.json', { cache: 'no-store' }).catch(() => null),
    ]);
    if (!csvRes.ok) throw new Error(`CSV HTTP ${csvRes.status}`);
    const text = await csvRes.text();
    state.rows = parseCsv(text);
    if (state.rows.length < 100) throw new Error('insufficient rows');
    state.byTs = new Map(state.rows.map(r => [r.timestamp, r]));
    if (metaRes?.ok) state.meta = await metaRes.json();

    const first = state.rows[0].timestamp;
    const last = state.rows.at(-1).timestamp;
    els.fromDate.min = dateInputJst(first); els.fromDate.max = dateInputJst(last);
    els.toDate.min = dateInputJst(first); els.toDate.max = dateInputJst(last);
    els.fromDate.value = dateInputJst(Math.max(first, last - 180 * DAY));
    els.toDate.value = dateInputJst(last);
    const source = state.meta?.source || 'Dukascopy bid H1';
    setStatus('ready', `${state.rows.length.toLocaleString()} BARS · ${dateLabelJst(last)} JST`);
    els.footerMeta.textContent = `${source} · ${dateLabelJst(first)} – ${dateLabelJst(last)} JST`;
    screen();
  } catch (err) {
    console.error(err);
    setStatus('error', 'DATA NOT READY');
    els.emptyState.classList.remove('hidden');
    els.emptyState.textContent = 'データ生成中、または取得に失敗しています。GitHub Actionsの更新完了後に再読み込みしてください。';
  }
}

function bindEvents() {
  els.periodPresets.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-period]');
    if (!btn) return;
    state.period = btn.dataset.period === 'custom' ? 'custom' : Number(btn.dataset.period);
    els.periodPresets.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    els.customDates.classList.toggle('hidden', state.period !== 'custom');
    screen();
  });
  [els.fromDate, els.toDate, els.direction, els.entryHour, els.holdHours, els.minTrades, els.sortMetric]
    .forEach(el => el.addEventListener('change', screen));
  els.closeDetail.addEventListener('click', hideDetail);
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.selected) drawEquity(state.selected); }, 120);
  });
}

populateControls();
bindEvents();
loadData();
