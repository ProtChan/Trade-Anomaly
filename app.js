const DAY = 86_400_000;
const HOUR = 3_600_000;
const JST = 9 * HOUR;

const state = { rows: [], byTs: new Map(), meta: null, period: 180, results: [], selected: null };
const $ = id => document.getElementById(id);
const els = {
  dataStatus: $('dataStatus'), periodPresets: $('periodPresets'), customDates: $('customDates'),
  fromDate: $('fromDate'), toDate: $('toDate'), direction: $('direction'), entryHour: $('entryHour'),
  holdHours: $('holdHours'), minTrades: $('minTrades'), sortMetric: $('sortMetric'),
  strategyCount: $('strategyCount'), bestSharpe: $('bestSharpe'), bestWin: $('bestWin'),
  barsUsed: $('barsUsed'), rangeLabel: $('rangeLabel'), resultsBody: $('resultsBody'),
  mobileResults: $('mobileResults'), emptyState: $('emptyState'), detailPanel: $('detailPanel'),
  detailTitle: $('detailTitle'), detailMetrics: $('detailMetrics'), equityChart: $('equityChart'),
  recentTrades: $('recentTrades'), closeDetail: $('closeDetail'), footerMeta: $('footerMeta')
};

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map(x => x.trim().toLowerCase());
  const idx = Object.fromEntries(header.map((k, i) => [k, i]));
  return lines.slice(1).map(line => {
    const c = line.split(',');
    return {
      timestamp: Number(c[idx.timestamp]), open: Number(c[idx.open]), high: Number(c[idx.high]),
      low: Number(c[idx.low]), close: Number(c[idx.close]), volume: idx.volume === undefined ? 0 : Number(c[idx.volume])
    };
  }).filter(r => Number.isFinite(r.timestamp) && Number.isFinite(r.open) && r.open > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
}

function jstParts(ts) {
  const d = new Date(ts + JST);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours() };
}
function jstHour(ts) { return jstParts(ts).h; }
function dateInputJst(ts) { const p = jstParts(ts); return `${p.y}-${String(p.m).padStart(2,'0')}-${String(p.d).padStart(2,'0')}`; }
function dateLabelJst(ts) { const p = jstParts(ts); return `${p.y}/${String(p.m).padStart(2,'0')}/${String(p.d).padStart(2,'0')}`; }
function dateTimeLabelJst(ts) { const p = jstParts(ts); return `${p.y}/${String(p.m).padStart(2,'0')}/${String(p.d).padStart(2,'0')} ${String(p.h).padStart(2,'0')}:00`; }
function timeLabel(h) { return `${String(h).padStart(2,'0')}:00`; }
function exitHour(entry, hold) { return (entry + hold) % 24; }
function pct(x, d=4) { return `${(x*100).toFixed(d)}%`; }
function fixed(x, d=3) { return Number.isFinite(x) ? x.toFixed(d) : '—'; }
function signedPct(x, d=4) { return `${x >= 0 ? '+' : ''}${(x*100).toFixed(d)}%`; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function getRange() {
  const last = state.rows.at(-1)?.timestamp ?? Date.now();
  const first = state.rows[0]?.timestamp ?? last;
  if (state.period === 'custom') {
    const from = els.fromDate.value ? Date.parse(`${els.fromDate.value}T00:00:00+09:00`) : first;
    const to = els.toDate.value ? Date.parse(`${els.toDate.value}T23:59:59+09:00`) : last;
    return { start: Math.max(first, from), end: Math.min(last, to) };
  }
  return { start: Math.max(first, last - Number(state.period) * DAY), end: last };
}

function sampleStd(values, mean) {
  if (values.length < 2) return NaN;
  let s = 0;
  for (const v of values) s += (v - mean) ** 2;
  return Math.sqrt(s / (values.length - 1));
}

function calcMetrics(trades) {
  const r = trades.map(t => t.ret), n = r.length;
  const mean = n ? r.reduce((a,b)=>a+b,0)/n : NaN;
  const std = sampleStd(r, mean), wins = r.filter(v=>v>0).length;
  const grossWin = r.filter(v=>v>0).reduce((a,b)=>a+b,0);
  const grossLoss = Math.abs(r.filter(v=>v<0).reduce((a,b)=>a+b,0));
  let equity = 0, peak = 0, maxDd = 0;
  for (const v of r) { equity += v; peak = Math.max(peak, equity); maxDd = Math.min(maxDd, equity - peak); }
  return {
    trades:n, avgRet:mean, winRate:n?wins/n:NaN, sharpe:std>0?mean/std:NaN, std,
    totalRet:r.reduce((a,b)=>a+b,0), maxDd,
    profitFactor:grossLoss>0?grossWin/grossLoss:grossWin>0?Infinity:NaN,
    best:n?Math.max(...r):NaN, worst:n?Math.min(...r):NaN
  };
}

function buildTrades(entryHour, hold, direction, range) {
  const sign = direction === 'long' ? 1 : -1, out = [];
  for (const row of state.rows) {
    if (row.timestamp < range.start || row.timestamp > range.end || jstHour(row.timestamp) !== entryHour) continue;
    const exitTs = row.timestamp + hold * HOUR;
    if (exitTs > range.end) continue;
    const exitRow = state.byTs.get(exitTs);
    if (!exitRow) continue;
    const raw = exitRow.open / row.open - 1;
    out.push({ entryTs:row.timestamp, exitTs, entry:row.open, exit:exitRow.open, ret:sign*raw });
  }
  return out;
}

function screen() {
  if (!state.rows.length) return;
  const range = getRange(), minTrades = Number(els.minTrades.value);
  const entries = els.entryHour.value === 'all' ? [...Array(24).keys()] : [Number(els.entryHour.value)];
  const holds = els.holdHours.value === 'all' ? [...Array(24).keys()].map(i=>i+1) : [Number(els.holdHours.value)];
  const dirs = els.direction.value === 'both' ? ['long','short'] : [els.direction.value];
  const results = [];
  for (const entry of entries) for (const hold of holds) for (const direction of dirs) {
    const trades = buildTrades(entry, hold, direction, range);
    if (trades.length < minTrades) continue;
    const metrics = calcMetrics(trades);
    if (!Number.isFinite(metrics.sharpe) && els.sortMetric.value === 'sharpe') continue;
    results.push({ entry, hold, exit:exitHour(entry,hold), direction, trades, ...metrics });
  }
  const key = els.sortMetric.value;
  results.sort((a,b) => {
    const av = Number.isFinite(a[key]) ? a[key] : -Infinity, bv = Number.isFinite(b[key]) ? b[key] : -Infinity;
    if (bv !== av) return bv-av;
    if (b.sharpe !== a.sharpe) return b.sharpe-a.sharpe;
    return b.trades-a.trades;
  });
  state.results = results;
  renderResults(range);
}

function renderResults(range) {
  const top = state.results.slice(0,100);
  els.strategyCount.textContent = state.results.length.toLocaleString();
  const finite = state.results.filter(x=>Number.isFinite(x.sharpe));
  els.bestSharpe.textContent = finite.length ? fixed(Math.max(...finite.map(x=>x.sharpe)),3) : '—';
  els.bestWin.textContent = state.results.length ? `${(Math.max(...state.results.map(x=>x.winRate))*100).toFixed(1)}%` : '—';
  const bars = state.rows.filter(r=>r.timestamp>=range.start && r.timestamp<=range.end).length;
  els.barsUsed.textContent = bars.toLocaleString();
  els.rangeLabel.textContent = `${dateLabelJst(range.start)} – ${dateLabelJst(range.end)}`;
  els.emptyState.classList.toggle('hidden', top.length > 0);

  els.resultsBody.innerHTML = top.map((s,i)=>`<tr data-index="${i}">
    <td class="rank">${i+1}</td><td><span class="dir ${s.direction}">${s.direction.toUpperCase()}</span></td>
    <td>${timeLabel(s.entry)}</td><td>${timeLabel(s.exit)}</td><td>${s.hold}h</td><td>${s.trades}</td>
    <td>${(s.winRate*100).toFixed(1)}</td><td class="${s.avgRet>=0?'positive':'negative'}">${(s.avgRet*100).toFixed(4)}</td>
    <td class="metric-strong ${s.sharpe>=0?'positive':'negative'}">${fixed(s.sharpe,3)}</td></tr>`).join('');

  els.mobileResults.innerHTML = top.map((s,i)=>`<article class="mobile-card" data-index="${i}">
    <div class="mobile-top"><div class="mobile-top-left"><span class="mobile-rank">#${i+1}</span><span class="dir ${s.direction}">${s.direction.toUpperCase()}</span></div>
    <div><div class="mobile-strategy">${timeLabel(s.entry)} → ${timeLabel(s.exit)}</div><div class="mobile-sub">Hold ${s.hold}h · ${s.trades} trades</div></div></div>
    <div class="mobile-metrics"><div class="mobile-metric"><span>Sharpe</span><strong class="${s.sharpe>=0?'positive':'negative'}">${fixed(s.sharpe,3)}</strong></div>
    <div class="mobile-metric"><span>Win%</span><strong>${(s.winRate*100).toFixed(1)}</strong></div>
    <div class="mobile-metric"><span>AvgRet</span><strong class="${s.avgRet>=0?'positive':'negative'}">${(s.avgRet*100).toFixed(4)}%</strong></div>
    <div class="mobile-metric"><span>Trades</span><strong>${s.trades}</strong></div></div></article>`).join('');

  document.querySelectorAll('[data-index]').forEach(el => el.addEventListener('click', ()=>showDetail(top[Number(el.dataset.index)])));
  if (state.selected) {
    const match = top.find(s=>s.entry===state.selected.entry && s.hold===state.selected.hold && s.direction===state.selected.direction);
    if (!match) hideDetail();
  }
}

function showDetail(s) {
  if (!s) return;
  state.selected = s;
  els.detailPanel.classList.remove('hidden');
  els.detailTitle.innerHTML = `${timeLabel(s.entry)} → ${timeLabel(s.exit)} · ${s.hold}h · <span class="${s.direction==='long'?'positive':'negative'}">${s.direction.toUpperCase()}</span>`;
  const pf = Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : s.profitFactor===Infinity ? '∞' : '—';
  els.detailMetrics.innerHTML = [
    ['Sharpe',fixed(s.sharpe,3)],['Win rate',`${(s.winRate*100).toFixed(1)}%`],['Avg return',signedPct(s.avgRet,4)],
    ['Total return',signedPct(s.totalRet,2)],['Max drawdown',signedPct(s.maxDd,2)],['Profit factor',pf],['Trades',String(s.trades)],
    ['Best trade',signedPct(s.best,3)],['Worst trade',signedPct(s.worst,3)],['Volatility',pct(s.std,3)]
  ].map(([k,v])=>`<div class="metric-box"><span>${k}</span><strong>${v}</strong></div>`).join('');
  els.recentTrades.innerHTML = s.trades.slice(-12).reverse().map(t=>`<div class="trade-chip">${dateTimeLabelJst(t.entryTs)}<b class="${t.ret>=0?'positive':'negative'}">${signedPct(t.ret,3)}</b></div>`).join('');
  drawEquity(s);
  els.detailPanel.scrollIntoView({behavior:'smooth',block:'nearest'});
}

function hideDetail() { state.selected = null; els.detailPanel.classList.add('hidden'); }

function drawEquity(s) {
  let cum = 0;
  const raw = [{cum:0, trade:null}];
  for (const t of s.trades) { cum += t.ret; raw.push({cum, trade:t}); }

  const maxPoints = 180;
  let pts = raw;
  if (raw.length > maxPoints) {
    const step = (raw.length - 1) / (maxPoints - 1);
    pts = Array.from({length:maxPoints}, (_,i)=>raw[Math.min(raw.length-1, Math.round(i*step))]);
  }

  let ymin = Math.min(0, ...pts.map(p=>p.cum));
  let ymax = Math.max(0, ...pts.map(p=>p.cum));
  if (ymin === ymax) { ymin -= .001; ymax += .001; }
  const pad = (ymax-ymin)*.08;
  ymin -= pad; ymax += pad;
  const span = ymax-ymin;
  const yPct = v => clamp((ymax-v)/span*100, 0, 100);
  const zero = yPct(0);
  const positiveTotal = s.totalRet >= 0;

  const labels = [ymax, (ymax+ymin)/2, ymin].map(v=>`<span>${(v*100).toFixed(1)}%</span>`).join('');
  const bars = pts.map((p,i)=>{
    const y = yPct(p.cum), top = Math.min(y,zero), height = Math.max(1.2, Math.abs(y-zero));
    const left = pts.length===1 ? 0 : i/(pts.length-1)*100;
    const tip = p.trade ? `${dateTimeLabelJst(p.trade.entryTs)} JST · cumulative ${signedPct(p.cum,2)}` : 'Start · 0.00%';
    return `<i class="equity-stem ${p.cum>=0?'up':'down'}" style="left:${left.toFixed(3)}%;top:${top.toFixed(3)}%;height:${height.toFixed(3)}%" title="${tip}"></i>`;
  }).join('');

  els.equityChart.innerHTML = `
    <div class="equity-ylabels">${labels}</div>
    <div class="equity-plot ${positiveTotal?'finish-up':'finish-down'}">
      <div class="equity-zero" style="top:${zero.toFixed(3)}%"></div>${bars}
      <span class="equity-edge oldest">oldest</span><span class="equity-edge latest">latest</span>
    </div>
    <div class="equity-summary"><span>HTML/CSS bars</span><strong class="${positiveTotal?'positive':'negative'}">${signedPct(s.totalRet,2)}</strong></div>`;
  els.equityChart.setAttribute('aria-label', `Cumulative return ${signedPct(s.totalRet,2)} across ${s.trades.length} trades`);
}

function populateControls() {
  for (let h=0; h<24; h++) {
    els.entryHour.insertAdjacentHTML('beforeend', `<option value="${h}">${timeLabel(h)} JST</option>`);
    els.holdHours.insertAdjacentHTML('beforeend', `<option value="${h+1}">${h+1}h</option>`);
  }
}
function setStatus(kind,text) { els.dataStatus.className=`data-pill ${kind||''}`.trim(); els.dataStatus.querySelector('span:last-child').textContent=text; }

async function loadData() {
  try {
    const stamp = Date.now();
    const [csvRes, metaRes] = await Promise.all([
      fetch(`data/usdjpy_h1.csv?v=${stamp}`,{cache:'no-store'}),
      fetch(`data/meta.json?v=${stamp}`,{cache:'no-store'}).catch(()=>null)
    ]);
    if (!csvRes.ok) throw new Error(`CSV HTTP ${csvRes.status}`);
    state.rows = parseCsv(await csvRes.text());
    if (state.rows.length < 100) throw new Error('insufficient rows');
    state.byTs = new Map(state.rows.map(r=>[r.timestamp,r]));
    if (metaRes?.ok) state.meta = await metaRes.json();

    const first = state.rows[0].timestamp, last = state.rows.at(-1).timestamp;
    els.fromDate.min=dateInputJst(first); els.fromDate.max=dateInputJst(last);
    els.toDate.min=dateInputJst(first); els.toDate.max=dateInputJst(last);
    els.fromDate.value=dateInputJst(Math.max(first,last-180*DAY)); els.toDate.value=dateInputJst(last);
    const source = state.meta?.source || 'Dukascopy Bid+Ask → Mid H1';
    setStatus('ready',`${state.rows.length.toLocaleString()} BARS · ${dateLabelJst(last)} JST`);
    els.footerMeta.textContent=`${source} · ${dateLabelJst(first)} – ${dateLabelJst(last)} JST`;
    screen();
  } catch (err) {
    console.error(err); setStatus('error','DATA NOT READY');
    els.emptyState.classList.remove('hidden');
    els.emptyState.textContent='データ生成中、または取得に失敗しています。GitHub Actionsの更新完了後に再読み込みしてください。';
  }
}

function bindEvents() {
  els.periodPresets.addEventListener('click',e=>{
    const btn=e.target.closest('button[data-period]'); if(!btn)return;
    state.period=btn.dataset.period==='custom'?'custom':Number(btn.dataset.period);
    els.periodPresets.querySelectorAll('button').forEach(b=>b.classList.toggle('active',b===btn));
    els.customDates.classList.toggle('hidden',state.period!=='custom'); screen();
  });
  [els.fromDate,els.toDate,els.direction,els.entryHour,els.holdHours,els.minTrades,els.sortMetric].forEach(el=>el.addEventListener('change',screen));
  els.closeDetail.addEventListener('click',hideDetail);
}

populateControls(); bindEvents(); loadData();
