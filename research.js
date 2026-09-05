const $ = id => document.getElementById(id);
const state = { data: null, selected: null };

function fmt(x, d=2) { return Number.isFinite(x) ? x.toFixed(d) : '—'; }
function pct(x, d=0) { return Number.isFinite(x) ? `${(x*100).toFixed(d)}%` : '—'; }
function bp(x, d=2) { return Number.isFinite(x) ? `${x>=0?'+':''}${x.toFixed(d)} bp` : '—'; }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function setStatus(kind, text) {
  const el = $('researchStatus');
  el.className = `data-pill ${kind||''}`.trim();
  el.querySelector('span:last-child').textContent = text;
}

function renderSummary(data) {
  const years = data.data?.years || [];
  $('historyYears').textContent = years.length ? String(years.length) : '—';
  $('historyRange').textContent = years.length ? `${years[0]}–${years.at(-1)}` : '—';
  $('strategyTotal').textContent = (data.strategy_summaries?.length || 0).toLocaleString();
  const scores = (data.strategy_summaries || []).map(x=>x.robustness_score).filter(Number.isFinite);
  $('bestRobust').textContent = scores.length ? fmt(Math.max(...scores),2) : '—';
  const wf = (data.strategy_summaries || []).map(x=>x.walk_forward_mean_bp).filter(Number.isFinite);
  $('bestWf').textContent = wf.length ? bp(Math.max(...wf),2) : '—';
  $('researchMeta').textContent = `${data.data?.first_utc?.slice(0,10) || '—'} → ${data.data?.last_utc?.slice(0,10) || '—'} · generated ${data.generated_utc?.slice(0,10) || '—'}`;

  const defs = data.state_definitions || {};
  $('stateDefinitions').innerHTML = Object.entries(defs).map(([k,v])=>`<b>${esc(k)}</b>: ${esc(v)}`).join(' · ');
}

function renderList(data) {
  const detailsById = new Map((data.strategy_details || []).map(x=>[x.id,x]));
  const items = (data.strategy_summaries || []).slice(0,120);
  $('strategyList').innerHTML = items.map((s,i)=>`
    <div class="research-row" data-id="${esc(s.id)}">
      <strong>#${i+1}</strong>
      <div><b>${String(s.entry_hour_jst).padStart(2,'0')}:00 → ${String(s.exit_hour_jst).padStart(2,'0')}:00</b><br><small>${s.direction.toUpperCase()} · ${s.hold_hours}h · ${s.trades} trades</small></div>
      <div><small>Score</small><br><strong>${fmt(s.robustness_score,2)}</strong></div>
      <div><small>WF mean</small><br><strong class="${(s.walk_forward_mean_bp||0)>=0?'positive':'negative'}">${bp(s.walk_forward_mean_bp,2)}</strong></div>
      <div class="desktop-extra"><small>Years +</small><br><strong>${pct(s.year_positive_ratio)}</strong></div>
      <div class="desktop-extra"><small>t-stat</small><br><strong>${fmt(s.t_stat,2)}</strong></div>
    </div>`).join('');

  document.querySelectorAll('.research-row').forEach(el => el.addEventListener('click', ()=>{
    const detail = detailsById.get(el.dataset.id);
    if (detail) renderDetail(detail);
  }));
  const first = data.strategy_details?.[0];
  if (first) renderDetail(first);
}

function renderDetail(s) {
  state.selected = s;
  document.querySelectorAll('.research-row').forEach(el=>el.classList.toggle('active', el.dataset.id===s.id));
  $('researchTitle').textContent = `${String(s.entry_hour_jst).padStart(2,'0')}:00 JST → ${String(s.exit_hour_jst).padStart(2,'0')}:00 · ${s.direction.toUpperCase()} · ${s.hold_hours}h`;
  const metrics = [
    ['Mean', bp(s.mean_bp,2)], ['t-stat', fmt(s.t_stat,2)], ['Win rate', pct(s.win_rate,1)],
    ['Months +', pct(s.month_positive_ratio)], ['Years +', pct(s.year_positive_ratio)], ['WF years +', pct(s.walk_forward_positive_ratio)],
    ['WF mean', bp(s.walk_forward_mean_bp,2)], ['Trades', String(s.trades)], ['Robust score', fmt(s.robustness_score,2)]
  ];
  $('researchMetrics').innerHTML = metrics.map(([k,v])=>`<div class="mini"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('');

  const wf = s.walk_forward_years || [];
  $('wfYears').innerHTML = wf.length ? wf.map(x=>`<div class="wf-row"><span>${x.year} · prior-years ${x.train_direction.toUpperCase()}</span><b class="${(x.mean_bp||0)>=0?'positive':'negative'}">${bp(x.mean_bp,2)} · ${pct(x.win_rate,0)}</b></div>`).join('') : '<p class="muted">履歴年数が不足しています。</p>';

  renderRegimes(s);
  renderMonths(s);
  renderChangePoints(s);
}

function renderRegimes(s) {
  const labels = {volatility:'Volatility', activity:'Activity', round_distance:'Round distance', trend24:'24h trend'};
  const rows = [];
  for (const [factor, vals] of Object.entries(s.regime_effects || {})) {
    const maxAbs = Math.max(1, ...vals.map(x=>Math.abs(x.mean_bp||0)));
    rows.push(`<div class="eyebrow" style="margin-top:8px">${labels[factor]||esc(factor)}</div>`);
    for (const x of vals) {
      const width = Math.min(50, Math.abs(x.mean_bp||0)/maxAbs*50);
      const pos = (x.mean_bp||0) >= 0;
      rows.push(`<div class="bar-row"><span>${esc(x.bucket)} · n=${x.trades}</span><div class="bar-track"><i class="bar-fill ${pos?'':'neg'}" style="width:${width}%;color:${pos?'#22c55e':'#ef4444'}"></i></div><b class="${pos?'positive':'negative'}">${bp(x.mean_bp,2)}</b></div>`);
    }
  }
  $('regimeEffects').innerHTML = rows.join('') || '<p class="muted">No regime data</p>';
}

function renderMonths(s) {
  const monthly = s.monthly || [];
  const maxAbs = Math.max(0.01, ...monthly.map(x=>Math.abs(x.mean_bp||0)));
  $('monthMap').innerHTML = monthly.map(x=>{
    const pos = (x.mean_bp||0) >= 0;
    const strong = Math.abs(x.mean_bp||0) >= maxAbs*0.66;
    const m = x.month?.slice(5) || '';
    const title = `${x.month}: actual ${bp(x.mean_bp,2)}, composition ${bp(x.composition_bp,2)}, residual ${bp(x.structural_residual_bp,2)}`;
    return `<div class="month-cell ${pos?'pos':'neg'} ${strong?'strong':''}" title="${esc(title)}">${esc(m)}</div>`;
  }).join('');
  const residuals = monthly.map(x=>x.structural_residual_bp).filter(Number.isFinite);
  const actual = monthly.map(x=>x.mean_bp).filter(Number.isFinite);
  const medResidual = residuals.length ? residuals.sort((a,b)=>a-b)[Math.floor(residuals.length/2)] : null;
  const medActual = actual.length ? actual.sort((a,b)=>a-b)[Math.floor(actual.length/2)] : null;
  $('monthNote').textContent = `各セルは月平均edge。hoverで state composition と structural residual を表示。median actual ${bp(medActual,2)} / median residual ${bp(medResidual,2)}.`;
}

function renderChangePoints(s) {
  const cps = s.change_points || [];
  $('changePoints').innerHTML = cps.length ? cps.map(x=>`<div class="cp"><b>${esc(x.month)}</b> · shift score ${fmt(x.score,2)} · ${bp(x.before_mean_bp,2)} → ${bp(x.after_mean_bp,2)}</div>`).join('<div style="height:7px"></div>') : '<p class="muted">明瞭な平均シフト候補なし（この単純検出器の閾値内）。</p>';
}

async function init() {
  try {
    const res = await fetch(`data/anomaly_research.json?v=${Date.now()}`, {cache:'no-store'});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.data = data;
    renderSummary(data); renderList(data);
    setStatus('ok', 'RESEARCH DATA READY');
  } catch (err) {
    console.error(err);
    setStatus('error', 'RESEARCH DATA ERROR');
    $('strategyList').innerHTML = `<p class="warning">anomaly_research.json を読み込めませんでした。次回GitHub Actions更新後に生成されます。</p>`;
  }
}

document.addEventListener('DOMContentLoaded', init);
