(() => {
  if (typeof drawEquity !== 'function') return;

  const originalDrawEquity = drawEquity;
  const ui = {
    activeIndex: null,
    selectedStrategy: null,
    tooltip: null,
    summary: null,
    hint: null,
    canvas: null,
  };

  function injectStyles() {
    if (document.getElementById('interactiveChartStyles')) return;
    const style = document.createElement('style');
    style.id = 'interactiveChartStyles';
    style.textContent = `
      .chart-wrap{position:relative;overflow:hidden}
      #equityChart{cursor:crosshair;touch-action:pan-y;border-radius:8px}
      #equityChart:focus-visible{outline:2px solid rgba(82,168,255,.75);outline-offset:3px}
      .pnl-live-row{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:25px;margin:0 2px 4px;color:#829ab2;font-size:10px}
      .pnl-live-summary{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-variant-numeric:tabular-nums}
      .pnl-live-summary b{font-size:11px;color:#dce8f4}
      .pnl-live-summary .pos{color:#75ddb2}.pnl-live-summary .neg{color:#ff8e99}
      .pnl-live-hint{white-space:nowrap;color:#607a93}
      .pnl-tooltip{position:absolute;z-index:8;pointer-events:none;min-width:178px;padding:9px 10px;border-radius:10px;border:1px solid rgba(90,128,166,.42);background:rgba(6,17,30,.94);box-shadow:0 12px 30px rgba(0,0,0,.34);backdrop-filter:blur(10px);color:#dce8f4;font-size:10px;line-height:1.45;opacity:0;transform:translateY(3px);transition:opacity .08s ease,transform .08s ease}
      .pnl-tooltip.show{opacity:1;transform:translateY(0)}
      .pnl-tooltip .pnl-date{font-weight:800;color:#f1f7fd;margin-bottom:4px}
      .pnl-tooltip .pnl-line{display:flex;justify-content:space-between;gap:14px;color:#8198af}
      .pnl-tooltip .pnl-line strong{color:#dce8f4;font-weight:850}
      .pnl-tooltip .pnl-line strong.pos{color:#75ddb2}.pnl-tooltip .pnl-line strong.neg{color:#ff8e99}
      @media(max-width:720px){
        .pnl-live-row{align-items:flex-start;flex-direction:column;gap:2px;margin-bottom:5px}
        .pnl-live-hint{font-size:9px}
        .pnl-tooltip{min-width:164px;padding:8px 9px}
      }
    `;
    document.head.appendChild(style);
  }

  function ensureUi() {
    injectStyles();
    const canvas = document.getElementById('equityChart');
    if (!canvas) return null;
    ui.canvas = canvas;
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Interactive cumulative profit and loss chart. Move the pointer or use left and right arrow keys to inspect each trade.');

    const wrap = canvas.closest('.chart-wrap');
    if (!wrap) return canvas;

    if (!ui.summary || !ui.summary.isConnected) {
      const liveRow = document.createElement('div');
      liveRow.className = 'pnl-live-row';
      liveRow.innerHTML = '<div class="pnl-live-summary" aria-live="polite"><span>Hover / tap a point to inspect P&L</span></div><div class="pnl-live-hint">Drag / tap · ← → keys</div>';
      canvas.before(liveRow);
      ui.summary = liveRow.querySelector('.pnl-live-summary');
      ui.hint = liveRow.querySelector('.pnl-live-hint');
    }

    if (!ui.tooltip || !ui.tooltip.isConnected) {
      const tip = document.createElement('div');
      tip.className = 'pnl-tooltip';
      tip.setAttribute('aria-hidden', 'true');
      wrap.appendChild(tip);
      ui.tooltip = tip;
    }

    if (!canvas.dataset.interactiveBound) {
      canvas.dataset.interactiveBound = '1';
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointerleave', onPointerLeave);
      canvas.addEventListener('keydown', onKeyDown);
    }
    return canvas;
  }

  function buildGeometry(s) {
    const canvas = ui.canvas || document.getElementById('equityChart');
    if (!canvas || !s?.trades?.length) return null;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(320, Math.floor(rect.width));
    const h = 260;
    const pad = { l: 46, r: 14, t: 14, b: 28 };
    const cw = w - pad.l - pad.r;
    const ch = h - pad.t - pad.b;
    let cum = 0;
    const pts = [{ index: 0, x: 0, y: 0, cum: 0, trade: null }];
    s.trades.forEach((trade, i) => {
      cum += trade.ret;
      pts.push({ index: i + 1, x: i + 1, y: cum, cum, trade });
    });
    const ys = pts.map(p => p.y);
    let ymin = Math.min(...ys, 0);
    let ymax = Math.max(...ys, 0);
    if (ymax === ymin) { ymax += .001; ymin -= .001; }
    const margin = (ymax - ymin) * .08;
    ymin -= margin;
    ymax += margin;
    const xScale = x => pad.l + (x / Math.max(1, pts.length - 1)) * cw;
    const yScale = y => pad.t + (1 - (y - ymin) / (ymax - ymin)) * ch;
    return { rect, w, h, pad, cw, ch, pts, ymin, ymax, xScale, yScale };
  }

  function nearestIndexFromClientX(clientX, geometry) {
    const x = clientX - geometry.rect.left;
    const ratio = clamp((x - geometry.pad.l) / Math.max(1, geometry.cw), 0, 1);
    return Math.round(ratio * (geometry.pts.length - 1));
  }

  function formatPrice(x) {
    return Number.isFinite(x) ? x.toFixed(3) : '—';
  }

  function updateText(point, geometry) {
    if (!ui.summary || !ui.tooltip) return;
    if (!point?.trade) {
      ui.summary.innerHTML = '<span>Start · <b>0.000%</b></span>';
      ui.tooltip.classList.remove('show');
      ui.tooltip.setAttribute('aria-hidden', 'true');
      return;
    }

    const t = point.trade;
    const tradeClass = t.ret >= 0 ? 'pos' : 'neg';
    const cumClass = point.cum >= 0 ? 'pos' : 'neg';
    ui.summary.innerHTML = `
      <span>${dateTimeLabelJst(t.entryTs)}</span>
      <span>Trade <b class="${tradeClass}">${signedPct(t.ret, 3)}</b></span>
      <span>Cumulative <b class="${cumClass}">${signedPct(point.cum, 2)}</b></span>`;

    ui.tooltip.innerHTML = `
      <div class="pnl-date">${dateTimeLabelJst(t.entryTs)} JST</div>
      <div class="pnl-line"><span>Trade P&L</span><strong class="${tradeClass}">${signedPct(t.ret, 3)}</strong></div>
      <div class="pnl-line"><span>Cumulative</span><strong class="${cumClass}">${signedPct(point.cum, 2)}</strong></div>
      <div class="pnl-line"><span>Entry → Exit</span><strong>${formatPrice(t.entry)} → ${formatPrice(t.exit)}</strong></div>
      <div class="pnl-line"><span>Trade #</span><strong>${point.index} / ${geometry.pts.length - 1}</strong></div>`;
    ui.tooltip.classList.add('show');
    ui.tooltip.setAttribute('aria-hidden', 'false');
  }

  function drawOverlay(index) {
    const s = ui.selectedStrategy;
    if (!s) return;
    originalDrawEquity(s);
    ensureUi();
    const g = buildGeometry(s);
    if (!g) return;
    const idx = clamp(Number(index) || 0, 0, g.pts.length - 1);
    ui.activeIndex = idx;
    const p = g.pts[idx];
    updateText(p, g);
    if (!p.trade) return;

    const canvas = ui.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const ctx = canvas.getContext('2d');
    const x = g.xScale(p.x);
    const y = g.yScale(p.y);

    ctx.save();
    ctx.strokeStyle = 'rgba(196,218,239,.42)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(x, g.pad.t); ctx.lineTo(x, g.h - g.pad.b); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(g.pad.l, y); ctx.lineTo(g.w - g.pad.r, y); ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#071423';
    ctx.strokeStyle = p.trade.ret >= 0 ? '#75ddb2' : '#ff8e99';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();

    if (ui.tooltip) {
      const wrap = canvas.closest('.chart-wrap');
      const canvasRect = canvas.getBoundingClientRect();
      const wrapRect = wrap.getBoundingClientRect();
      const tipW = ui.tooltip.offsetWidth || 178;
      const tipH = ui.tooltip.offsetHeight || 92;
      let left = (canvasRect.left - wrapRect.left) + x + 12;
      if (left + tipW > wrap.clientWidth - 8) left = (canvasRect.left - wrapRect.left) + x - tipW - 12;
      left = clamp(left, 8, Math.max(8, wrap.clientWidth - tipW - 8));
      let top = (canvasRect.top - wrapRect.top) + y - tipH / 2;
      top = clamp(top, 42, Math.max(42, wrap.clientHeight - tipH - 8));
      ui.tooltip.style.left = `${left}px`;
      ui.tooltip.style.top = `${top}px`;
    }
  }

  function clearOverlay() {
    if (!ui.selectedStrategy) return;
    ui.activeIndex = null;
    originalDrawEquity(ui.selectedStrategy);
    ensureUi();
    if (ui.tooltip) {
      ui.tooltip.classList.remove('show');
      ui.tooltip.setAttribute('aria-hidden', 'true');
    }
    if (ui.summary) ui.summary.innerHTML = '<span>Hover / tap a point to inspect P&L</span>';
  }

  function onPointerMove(e) {
    if (!ui.selectedStrategy) return;
    const g = buildGeometry(ui.selectedStrategy);
    if (!g) return;
    drawOverlay(nearestIndexFromClientX(e.clientX, g));
  }

  function onPointerDown(e) {
    if (!ui.selectedStrategy) return;
    const g = buildGeometry(ui.selectedStrategy);
    if (!g) return;
    drawOverlay(nearestIndexFromClientX(e.clientX, g));
    if (e.pointerType !== 'mouse') {
      try { ui.canvas.setPointerCapture(e.pointerId); } catch (_) {}
    }
  }

  function onPointerLeave(e) {
    if (e.pointerType === 'mouse') clearOverlay();
  }

  function onKeyDown(e) {
    if (!ui.selectedStrategy) return;
    const g = buildGeometry(ui.selectedStrategy);
    if (!g) return;
    if (e.key === 'Escape') {
      clearOverlay();
      return;
    }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const current = ui.activeIndex == null ? g.pts.length - 1 : ui.activeIndex;
    const next = clamp(current + (e.key === 'ArrowRight' ? 1 : -1), 0, g.pts.length - 1);
    drawOverlay(next);
  }

  drawEquity = function interactiveDrawEquity(s) {
    ui.selectedStrategy = s;
    ui.activeIndex = null;
    originalDrawEquity(s);
    ensureUi();
    if (ui.tooltip) {
      ui.tooltip.classList.remove('show');
      ui.tooltip.setAttribute('aria-hidden', 'true');
    }
    if (ui.summary) ui.summary.innerHTML = `<span>Latest cumulative <b class="${s.totalRet >= 0 ? 'pos' : 'neg'}">${signedPct(s.totalRet, 2)}</b></span><span>${s.trades.length} trades</span>`;
  };
})();