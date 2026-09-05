(() => {
  const HOUR = 3_600_000;
  const JST = 9 * HOUR;
  const clampLocal = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const pct = (x, digits = 3) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(digits)}%`;

  const ui = {
    root: null,
    stage: null,
    svg: null,
    tooltip: null,
    live: null,
    current: null,
    points: [],
    geometry: null,
    active: null,
    resizeObserver: null,
  };

  function jstLabel(ts) {
    const d = new Date(ts + JST);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const h = String(d.getUTCHours()).padStart(2, '0');
    return `${y}/${m}/${day} ${h}:00`;
  }

  function svgEl(name, attrs = {}) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  }

  function injectStyles() {
    if (document.getElementById('pnlChartStylesV2')) return;
    const style = document.createElement('style');
    style.id = 'pnlChartStylesV2';
    style.textContent = `
      #equityChart{display:none!important}
      .pnl-chart-v2{position:relative;min-width:0}
      .pnl-chart-live{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;min-height:28px;margin:0 2px 6px;color:#829ab2;font-size:10px;font-variant-numeric:tabular-nums}
      .pnl-chart-live strong{color:#e7f0fa;font-size:11px}.pnl-chart-live .pos{color:#75ddb2}.pnl-chart-live .neg{color:#ff8e99}
      .pnl-chart-stage{position:relative;width:100%;height:280px;border-radius:10px;overflow:hidden;touch-action:pan-y;outline:none}
      .pnl-chart-stage:focus-visible{box-shadow:0 0 0 2px rgba(82,168,255,.78)}
      .pnl-chart-svg{display:block;width:100%;height:100%;overflow:visible}
      .pnl-chart-tooltip{position:absolute;z-index:5;pointer-events:none;min-width:186px;padding:9px 10px;border:1px solid rgba(89,126,164,.46);border-radius:10px;background:rgba(5,16,28,.95);box-shadow:0 12px 30px rgba(0,0,0,.35);backdrop-filter:blur(10px);opacity:0;transform:translateY(3px);transition:opacity .08s ease,transform .08s ease;color:#dce8f4;font-size:10px;line-height:1.45}
      .pnl-chart-tooltip.show{opacity:1;transform:translateY(0)}
      .pnl-tip-date{font-weight:850;color:#f3f8fd;margin-bottom:4px}.pnl-tip-row{display:flex;justify-content:space-between;gap:14px;color:#8097ad}.pnl-tip-row b{color:#dce8f4}.pnl-tip-row b.pos{color:#75ddb2}.pnl-tip-row b.neg{color:#ff8e99}
      @media(max-width:720px){.pnl-chart-stage{height:240px}.pnl-chart-live{align-items:flex-start;flex-direction:column;gap:2px}.pnl-chart-tooltip{min-width:166px;padding:8px 9px}}
    `;
    document.head.appendChild(style);
  }

  function ensureRoot() {
    injectStyles();
    const canvas = document.getElementById('equityChart');
    if (!canvas) return null;
    const wrap = canvas.closest('.chart-wrap');
    if (!wrap) return null;

    if (!ui.root || !ui.root.isConnected) {
      const root = document.createElement('div');
      root.className = 'pnl-chart-v2';
      root.innerHTML = `
        <div class="pnl-chart-live" aria-live="polite"><span>Interactive P&amp;L</span><span>hover / tap / ← →</span></div>
        <div class="pnl-chart-stage" tabindex="0" role="img" aria-label="Interactive cumulative return chart">
          <svg class="pnl-chart-svg" aria-hidden="true"></svg>
          <div class="pnl-chart-tooltip" aria-hidden="true"></div>
        </div>`;
      canvas.insertAdjacentElement('afterend', root);
      ui.root = root;
      ui.live = root.querySelector('.pnl-chart-live');
      ui.stage = root.querySelector('.pnl-chart-stage');
      ui.svg = root.querySelector('.pnl-chart-svg');
      ui.tooltip = root.querySelector('.pnl-chart-tooltip');

      ui.stage.addEventListener('pointermove', onPointerMove);
      ui.stage.addEventListener('pointerdown', onPointerDown);
      ui.stage.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') clearActive(); });
      ui.stage.addEventListener('keydown', onKeyDown);

      if ('ResizeObserver' in window) {
        ui.resizeObserver = new ResizeObserver(() => {
          if (ui.current) render(ui.current, false);
        });
        ui.resizeObserver.observe(ui.stage);
      }
    }
    return ui.root;
  }

  function getSelected() {
    try {
      return typeof state !== 'undefined' ? state.selected : null;
    } catch (_) {
      return null;
    }
  }

  function buildPoints(strategy) {
    let cum = 0;
    const out = [{ index: 0, cum: 0, trade: null }];
    for (let i = 0; i < strategy.trades.length; i++) {
      const trade = strategy.trades[i];
      cum += trade.ret;
      out.push({ index: i + 1, cum, trade });
    }
    return out;
  }

  function niceBounds(values) {
    let lo = Math.min(0, ...values);
    let hi = Math.max(0, ...values);
    if (lo === hi) { lo -= .001; hi += .001; }
    const span = hi - lo;
    lo -= span * .08;
    hi += span * .08;
    return [lo, hi];
  }

  function pathFor(points, xScale, yScale) {
    return points.map((p, i) => `${i ? 'L' : 'M'}${xScale(p.index).toFixed(2)},${yScale(p.cum).toFixed(2)}`).join(' ');
  }

  function render(strategy, resetActive = true) {
    if (!strategy?.trades?.length) return;
    if (!ensureRoot()) return;
    ui.current = strategy;
    ui.points = buildPoints(strategy);
    if (resetActive) ui.active = null;

    const width = Math.max(320, Math.round(ui.stage.clientWidth || 760));
    const height = Math.max(220, Math.round(ui.stage.clientHeight || 280));
    const pad = { l: width < 520 ? 42 : 50, r: 12, t: 14, b: 28 };
    const innerW = width - pad.l - pad.r;
    const innerH = height - pad.t - pad.b;
    const [ymin, ymax] = niceBounds(ui.points.map(p => p.cum));
    const xScale = x => pad.l + (x / Math.max(1, ui.points.length - 1)) * innerW;
    const yScale = y => pad.t + (1 - (y - ymin) / (ymax - ymin)) * innerH;
    ui.geometry = { width, height, pad, innerW, innerH, ymin, ymax, xScale, yScale };

    const svg = ui.svg;
    svg.replaceChildren();
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('preserveAspectRatio', 'none');

    const defs = svgEl('defs');
    const grad = svgEl('linearGradient', { id: 'pnlAreaGradV2', x1: '0', y1: '0', x2: '0', y2: '1' });
    const positive = strategy.totalRet >= 0;
    grad.append(
      svgEl('stop', { offset: '0%', 'stop-color': positive ? '#52a8ff' : '#ff6f7d', 'stop-opacity': '.28' }),
      svgEl('stop', { offset: '100%', 'stop-color': positive ? '#52a8ff' : '#ff6f7d', 'stop-opacity': '0' })
    );
    defs.appendChild(grad);
    svg.appendChild(defs);

    for (let i = 0; i <= 4; i++) {
      const value = ymin + (ymax - ymin) * i / 4;
      const y = yScale(value);
      svg.appendChild(svgEl('line', { x1: pad.l, y1: y, x2: width - pad.r, y2: y, stroke: 'rgba(91,126,160,.17)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }));
      const label = svgEl('text', { x: pad.l - 7, y: y + 3, fill: '#6f879f', 'font-size': 10, 'text-anchor': 'end', 'font-family': 'ui-sans-serif,system-ui' });
      label.textContent = `${(value * 100).toFixed(1)}%`;
      svg.appendChild(label);
    }

    const zeroY = yScale(0);
    svg.appendChild(svgEl('line', { x1: pad.l, y1: zeroY, x2: width - pad.r, y2: zeroY, stroke: 'rgba(143,170,196,.34)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }));

    const linePath = pathFor(ui.points, xScale, yScale);
    const firstX = xScale(0);
    const lastX = xScale(ui.points.at(-1).index);
    const area = svgEl('path', { d: `${linePath} L${lastX.toFixed(2)},${zeroY.toFixed(2)} L${firstX.toFixed(2)},${zeroY.toFixed(2)} Z`, fill: 'url(#pnlAreaGradV2)' });
    svg.appendChild(area);
    svg.appendChild(svgEl('path', { d: linePath, fill: 'none', stroke: positive ? '#67b5ff' : '#ff7c89', 'stroke-width': 2.2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }));

    const oldest = svgEl('text', { x: pad.l, y: height - 6, fill: '#6f879f', 'font-size': 10, 'text-anchor': 'start', 'font-family': 'ui-sans-serif,system-ui' });
    oldest.textContent = 'oldest';
    const latest = svgEl('text', { x: width - pad.r, y: height - 6, fill: '#6f879f', 'font-size': 10, 'text-anchor': 'end', 'font-family': 'ui-sans-serif,system-ui' });
    latest.textContent = 'latest';
    svg.append(oldest, latest);

    const totalClass = strategy.totalRet >= 0 ? 'pos' : 'neg';
    ui.live.innerHTML = `<span>Latest cumulative <strong class="${totalClass}">${pct(strategy.totalRet, 2)}</strong></span><span>${strategy.trades.length} trades · mid-price basis</span>`;
    ui.tooltip.classList.remove('show');
    ui.tooltip.setAttribute('aria-hidden', 'true');

    if (ui.active != null) showPoint(clampLocal(ui.active, 0, ui.points.length - 1));
  }

  function nearestIndex(clientX) {
    const g = ui.geometry;
    if (!g) return 0;
    const rect = ui.stage.getBoundingClientRect();
    const x = clientX - rect.left;
    const ratio = clampLocal((x - g.pad.l) / Math.max(1, g.innerW), 0, 1);
    return Math.round(ratio * (ui.points.length - 1));
  }

  function showPoint(index) {
    if (!ui.current || !ui.geometry || !ui.points.length) return;
    const idx = clampLocal(index, 0, ui.points.length - 1);
    ui.active = idx;
    renderOverlay(idx);
  }

  function renderOverlay(index) {
    const g = ui.geometry;
    const p = ui.points[index];
    if (!g || !p) return;

    ui.svg.querySelectorAll('[data-overlay="1"]').forEach(n => n.remove());
    if (!p.trade) {
      ui.live.innerHTML = '<span>Start <strong>0.000%</strong></span><span>Trade #0</span>';
      ui.tooltip.classList.remove('show');
      return;
    }

    const x = g.xScale(p.index);
    const y = g.yScale(p.cum);
    const tradePositive = p.trade.ret >= 0;
    const cumPositive = p.cum >= 0;
    const v = svgEl('line', { x1: x, y1: g.pad.t, x2: x, y2: g.height - g.pad.b, stroke: 'rgba(205,224,242,.42)', 'stroke-width': 1, 'stroke-dasharray': '4 4', 'vector-effect': 'non-scaling-stroke', 'data-overlay': '1' });
    const h = svgEl('line', { x1: g.pad.l, y1: y, x2: g.width - g.pad.r, y2: y, stroke: 'rgba(205,224,242,.34)', 'stroke-width': 1, 'stroke-dasharray': '4 4', 'vector-effect': 'non-scaling-stroke', 'data-overlay': '1' });
    const dot = svgEl('circle', { cx: x, cy: y, r: 4.5, fill: '#071423', stroke: tradePositive ? '#75ddb2' : '#ff8e99', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', 'data-overlay': '1' });
    ui.svg.append(v, h, dot);

    ui.live.innerHTML = `<span>${jstLabel(p.trade.entryTs)} JST</span><span>Trade <strong class="${tradePositive ? 'pos' : 'neg'}">${pct(p.trade.ret, 3)}</strong> · Cumulative <strong class="${cumPositive ? 'pos' : 'neg'}">${pct(p.cum, 2)}</strong></span>`;
    ui.tooltip.innerHTML = `
      <div class="pnl-tip-date">${jstLabel(p.trade.entryTs)} JST</div>
      <div class="pnl-tip-row"><span>Trade P&amp;L</span><b class="${tradePositive ? 'pos' : 'neg'}">${pct(p.trade.ret, 3)}</b></div>
      <div class="pnl-tip-row"><span>Cumulative</span><b class="${cumPositive ? 'pos' : 'neg'}">${pct(p.cum, 2)}</b></div>
      <div class="pnl-tip-row"><span>Entry → Exit</span><b>${p.trade.entry.toFixed(3)} → ${p.trade.exit.toFixed(3)}</b></div>
      <div class="pnl-tip-row"><span>Trade #</span><b>${p.index} / ${ui.points.length - 1}</b></div>`;
    ui.tooltip.classList.add('show');
    ui.tooltip.setAttribute('aria-hidden', 'false');

    const stageRect = ui.stage.getBoundingClientRect();
    const scaleX = stageRect.width / g.width;
    const scaleY = stageRect.height / g.height;
    const px = x * scaleX;
    const py = y * scaleY;
    const tipW = ui.tooltip.offsetWidth || 186;
    const tipH = ui.tooltip.offsetHeight || 96;
    let left = px + 12;
    if (left + tipW > ui.stage.clientWidth - 8) left = px - tipW - 12;
    left = clampLocal(left, 8, Math.max(8, ui.stage.clientWidth - tipW - 8));
    const top = clampLocal(py - tipH / 2, 8, Math.max(8, ui.stage.clientHeight - tipH - 8));
    ui.tooltip.style.left = `${left}px`;
    ui.tooltip.style.top = `${top}px`;
  }

  function clearActive() {
    if (!ui.current) return;
    ui.active = null;
    ui.svg?.querySelectorAll('[data-overlay="1"]').forEach(n => n.remove());
    ui.tooltip?.classList.remove('show');
    const totalClass = ui.current.totalRet >= 0 ? 'pos' : 'neg';
    ui.live.innerHTML = `<span>Latest cumulative <strong class="${totalClass}">${pct(ui.current.totalRet, 2)}</strong></span><span>${ui.current.trades.length} trades · mid-price basis</span>`;
  }

  function onPointerMove(e) {
    if (!ui.current) return;
    showPoint(nearestIndex(e.clientX));
  }

  function onPointerDown(e) {
    if (!ui.current) return;
    showPoint(nearestIndex(e.clientX));
  }

  function onKeyDown(e) {
    if (!ui.current) return;
    if (e.key === 'Escape') { clearActive(); return; }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const start = ui.active == null ? ui.points.length - 1 : ui.active;
    showPoint(start + (e.key === 'ArrowRight' ? 1 : -1));
  }

  function renderSelected() {
    const selected = getSelected();
    if (!selected) return;
    render(selected, true);
  }

  ensureRoot();

  document.addEventListener('click', e => {
    if (e.target.closest('[data-index]')) requestAnimationFrame(renderSelected);
  });

  const detail = document.getElementById('detailPanel');
  if (detail && 'MutationObserver' in window) {
    const observer = new MutationObserver(() => {
      if (!detail.classList.contains('hidden')) requestAnimationFrame(renderSelected);
    });
    observer.observe(detail, { attributes: true, subtree: true, childList: true, characterData: true });
  }
})();
