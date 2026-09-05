// Detail hotfix v6: preserve strategy metrics while rebuilding the actual trade list on click.
// The original result object stores `trades` as a numeric count (from calcMetrics), so calling
// s.trades.slice(...) throws before the graph renderer runs. This capture-phase handler bypasses
// that path, rebuilds the trade list deterministically, and renders the detail panel + graph.

(function () {
  function renderEquityHtml(tradeList, totalRet) {
    let cum = 0;
    const raw = [{ cum: 0, trade: null }];
    for (const t of tradeList) {
      cum += t.ret;
      raw.push({ cum, trade: t });
    }

    const maxPoints = 160;
    let pts = raw;
    if (raw.length > maxPoints) {
      const step = (raw.length - 1) / (maxPoints - 1);
      pts = Array.from({ length: maxPoints }, (_, i) => raw[Math.min(raw.length - 1, Math.round(i * step))]);
    }

    let ymin = Math.min(0, ...pts.map(p => p.cum));
    let ymax = Math.max(0, ...pts.map(p => p.cum));
    if (ymin === ymax) { ymin -= 0.001; ymax += 0.001; }
    const pad = (ymax - ymin) * 0.08;
    ymin -= pad;
    ymax += pad;
    const span = ymax - ymin;
    const yPct = v => clamp((ymax - v) / span * 100, 0, 100);
    const zero = yPct(0);

    const labels = [ymax, (ymax + ymin) / 2, ymin]
      .map(v => `<span>${(v * 100).toFixed(1)}%</span>`)
      .join('');

    const bars = pts.map((p, i) => {
      const y = yPct(p.cum);
      const top = Math.min(y, zero);
      const height = Math.max(1.2, Math.abs(y - zero));
      const left = pts.length === 1 ? 0 : i / (pts.length - 1) * 100;
      const tip = p.trade
        ? `${dateTimeLabelJst(p.trade.entryTs)} JST · 累積 ${signedPct(p.cum, 2)}`
        : 'Start · 0.00%';
      return `<i class="equity-stem ${p.cum >= 0 ? 'up' : 'down'}" style="left:${left.toFixed(3)}%;top:${top.toFixed(3)}%;height:${height.toFixed(3)}%" title="${tip}"></i>`;
    }).join('');

    const positive = totalRet >= 0;
    els.equityChart.innerHTML = `
      <div class="equity-ylabels">${labels}</div>
      <div class="equity-plot ${positive ? 'finish-up' : 'finish-down'}">
        <div class="equity-zero" style="top:${zero.toFixed(3)}%"></div>
        ${bars}
        <span class="equity-edge oldest">oldest</span>
        <span class="equity-edge latest">latest</span>
      </div>
      <div class="equity-summary">
        <span>${tradeList.length} trades · reconstructed from Mid H1</span>
        <strong class="${positive ? 'positive' : 'negative'}">${signedPct(totalRet, 2)}</strong>
      </div>`;
    els.equityChart.setAttribute('aria-label', `Cumulative return ${signedPct(totalRet, 2)} across ${tradeList.length} trades`);
  }

  function renderDetailFixed(s) {
    if (!s) return;

    const tradeList = buildTrades(s.entry, s.hold, s.direction, getRange());
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
      ['Trades', String(tradeList.length)],
      ['Best trade', signedPct(s.best, 3)],
      ['Worst trade', signedPct(s.worst, 3)],
      ['Volatility', pct(s.std, 3)]
    ].map(([k, v]) => `<div class="metric-box"><span>${k}</span><strong>${v}</strong></div>`).join('');

    els.recentTrades.innerHTML = tradeList.slice(-12).reverse().map(t => `
      <div class="trade-chip">${dateTimeLabelJst(t.entryTs)}<b class="${t.ret >= 0 ? 'positive' : 'negative'}">${signedPct(t.ret, 3)}</b></div>`).join('');

    renderEquityHtml(tradeList, s.totalRet);
    els.detailPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Capture phase ensures the broken legacy click handler never gets a chance to throw.
  window.addEventListener('click', function (event) {
    const target = event.target.closest?.('[data-index]');
    if (!target) return;
    const index = Number(target.dataset.index);
    if (!Number.isInteger(index) || index < 0) return;
    const s = state.results.slice(0, 100)[index];
    if (!s) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    renderDetailFixed(s);
  }, true);

  // Expose a tiny diagnostic hook for manual console verification.
  window.__tradeAnomalyDetailV6 = { renderDetailFixed };
})();