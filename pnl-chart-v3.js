(() => {
  const JST = 9 * 60 * 60 * 1000;
  const q = s => document.querySelector(s);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const fmtPct = (x, d = 3) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`;
  const fmtJst = ts => {
    const d = new Date(ts + JST);
    const z = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}/${z(d.getUTCMonth()+1)}/${z(d.getUTCDate())} ${z(d.getUTCHours())}:00`;
  };
  const ns = 'http://www.w3.org/2000/svg';
  const se = (tag, attrs = {}) => {
    const e = document.createElementNS(ns, tag);
    Object.entries(attrs).forEach(([k,v]) => e.setAttribute(k, String(v)));
    return e;
  };

  const ui = { root:null, stage:null, svg:null, tip:null, live:null, strategy:null, pts:[], g:null, active:null };

  function selectedStrategy() {
    try { return typeof state !== 'undefined' ? state.selected : null; }
    catch (_) { return null; }
  }

  function init() {
    const canvas = document.getElementById('equityChart');
    if (!canvas || ui.root) return;
    canvas.style.display = 'none';

    const style = document.createElement('style');
    style.textContent = `
      .pnl3{position:relative;min-width:0}.pnl3-live{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;min-height:26px;margin:1px 2px 6px;color:#8098b0;font-size:10px;font-variant-numeric:tabular-nums}.pnl3-live b{color:#e7f0fa}.pnl3-live .pos{color:#75ddb2}.pnl3-live .neg{color:#ff8e99}.pnl3-stage{position:relative;width:100%;height:280px;border-radius:10px;overflow:hidden;outline:none;touch-action:pan-y}.pnl3-stage:focus-visible{box-shadow:0 0 0 2px rgba(82,168,255,.75)}.pnl3-svg{display:block;width:100%;height:100%}.pnl3-tip{position:absolute;z-index:4;pointer-events:none;min-width:184px;padding:9px 10px;border:1px solid rgba(89,126,164,.45);border-radius:10px;background:rgba(5,16,28,.95);box-shadow:0 12px 30px rgba(0,0,0,.35);color:#dce8f4;font-size:10px;line-height:1.45;opacity:0;transition:opacity .08s ease}.pnl3-tip.show{opacity:1}.pnl3-tip .date{font-weight:850;color:#f3f8fd;margin-bottom:4px}.pnl3-tip .row{display:flex;justify-content:space-between;gap:14px;color:#8097ad}.pnl3-tip b{color:#dce8f4}.pnl3-tip b.pos{color:#75ddb2}.pnl3-tip b.neg{color:#ff8e99}@media(max-width:720px){.pnl3-stage{height:240px}.pnl3-live{flex-direction:column;gap:2px}.pnl3-tip{min-width:164px;padding:8px 9px}}
    `;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.className = 'pnl3';
    root.innerHTML = '<div class="pnl3-live" aria-live="polite"><span>Interactive P&amp;L</span><span>hover / tap / ← →</span></div><div class="pnl3-stage" tabindex="0" role="img" aria-label="Interactive cumulative return chart"><svg class="pnl3-svg" aria-hidden="true"></svg><div class="pnl3-tip" aria-hidden="true"></div></div>';
    canvas.insertAdjacentElement('afterend', root);
    ui.root = root; ui.live = q('.pnl3-live'); ui.stage = q('.pnl3-stage'); ui.svg = q('.pnl3-svg'); ui.tip = q('.pnl3-tip');

    ui.stage.addEventListener('pointermove', e => pointAt(e.clientX));
    ui.stage.addEventListener('pointerdown', e => pointAt(e.clientX));
    ui.stage.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') clearPoint(); });
    ui.stage.addEventListener('keydown', e => {
      if (!ui.strategy) return;
      if (e.key === 'Escape') { clearPoint(); return; }
      if (!['ArrowLeft','ArrowRight'].includes(e.key)) return;
      e.preventDefault();
      const i = ui.active == null ? ui.pts.length - 1 : ui.active;
      showPoint(clamp(i + (e.key === 'ArrowRight' ? 1 : -1), 0, ui.pts.length - 1));
    });

    document.addEventListener('click', e => {
      if (e.target.closest('[data-index]')) requestAnimationFrame(renderSelected);
    });

    const detail = document.getElementById('detailPanel');
    if (detail && 'MutationObserver' in window) {
      new MutationObserver(() => {
        if (!detail.classList.contains('hidden')) requestAnimationFrame(renderSelected);
      }).observe(detail, { attributes:true, attributeFilter:['class'] });
    }

    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (ui.strategy) draw(ui.strategy, false); }, 120);
    });
  }

  function buildPoints(s) {
    let cum = 0;
    const pts = [{i:0,cum:0,t:null}];
    s.trades.forEach((t, k) => { cum += t.ret; pts.push({i:k+1,cum,t}); });
    return pts;
  }

  function draw(s, reset = true) {
    if (!s?.trades?.length) return;
    init();
    ui.strategy = s; ui.pts = buildPoints(s); if (reset) ui.active = null;
    const W = Math.max(320, Math.round(ui.stage.clientWidth || 760));
    const H = Math.max(220, Math.round(ui.stage.clientHeight || 280));
    const p = {l: W < 520 ? 42 : 50, r:12, t:14, b:28};
    const iw = W-p.l-p.r, ih = H-p.t-p.b;
    let lo = Math.min(0, ...ui.pts.map(x=>x.cum)), hi = Math.max(0, ...ui.pts.map(x=>x.cum));
    if (lo === hi) { lo -= .001; hi += .001; }
    const span = hi-lo; lo -= span*.08; hi += span*.08;
    const xs = i => p.l + i/Math.max(1,ui.pts.length-1)*iw;
    const ys = y => p.t + (1-(y-lo)/(hi-lo))*ih;
    ui.g = {W,H,p,iw,ih,lo,hi,xs,ys};

    const svg = ui.svg; svg.replaceChildren(); svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
    const defs = se('defs');
    const grad = se('linearGradient',{id:'pnl3grad',x1:0,y1:0,x2:0,y2:1});
    const up = s.totalRet >= 0;
    grad.append(se('stop',{offset:'0%','stop-color':up?'#52a8ff':'#ff6f7d','stop-opacity':'.28'}),se('stop',{offset:'100%','stop-color':up?'#52a8ff':'#ff6f7d','stop-opacity':'0'}));
    defs.append(grad); svg.append(defs);

    for(let k=0;k<=4;k++){
      const v=lo+(hi-lo)*k/4, y=ys(v);
      svg.append(se('line',{x1:p.l,y1:y,x2:W-p.r,y2:y,stroke:'rgba(91,126,160,.17)','stroke-width':1}));
      const tx=se('text',{x:p.l-7,y:y+3,fill:'#6f879f','font-size':10,'text-anchor':'end','font-family':'ui-sans-serif,system-ui'}); tx.textContent=`${(v*100).toFixed(1)}%`; svg.append(tx);
    }
    const zy=ys(0); svg.append(se('line',{x1:p.l,y1:zy,x2:W-p.r,y2:zy,stroke:'rgba(143,170,196,.34)','stroke-width':1}));
    const d=ui.pts.map((x,k)=>`${k?'L':'M'}${xs(x.i).toFixed(2)},${ys(x.cum).toFixed(2)}`).join(' ');
    const last=ui.pts.at(-1);
    svg.append(se('path',{d:`${d} L${xs(last.i)},${zy} L${xs(0)},${zy} Z`,fill:'url(#pnl3grad)'}));
    svg.append(se('path',{d,fill:'none',stroke:up?'#67b5ff':'#ff7c89','stroke-width':2.2,'stroke-linejoin':'round','stroke-linecap':'round'}));
    const a=se('text',{x:p.l,y:H-6,fill:'#6f879f','font-size':10,'text-anchor':'start','font-family':'ui-sans-serif,system-ui'}); a.textContent='oldest';
    const b=se('text',{x:W-p.r,y:H-6,fill:'#6f879f','font-size':10,'text-anchor':'end','font-family':'ui-sans-serif,system-ui'}); b.textContent='latest'; svg.append(a,b);
    ui.live.innerHTML=`<span>Latest cumulative <b class="${up?'pos':'neg'}">${fmtPct(s.totalRet,2)}</b></span><span>${s.trades.length} trades · Mid H1 open</span>`;
    ui.tip.classList.remove('show');
  }

  function renderSelected(){ const s=selectedStrategy(); if(s) draw(s,true); }
  function nearest(clientX){ const r=ui.stage.getBoundingClientRect(), g=ui.g; const x=clientX-r.left; return Math.round(clamp((x-g.p.l)/Math.max(1,g.iw),0,1)*(ui.pts.length-1)); }
  function pointAt(clientX){ if(ui.strategy&&ui.g) showPoint(nearest(clientX)); }

  function showPoint(i){
    if(!ui.g||!ui.pts[i])return; ui.active=i;
    ui.svg.querySelectorAll('[data-o="1"]').forEach(n=>n.remove());
    const p=ui.pts[i], g=ui.g;
    if(!p.t){ clearPoint(); return; }
    const x=g.xs(p.i), y=g.ys(p.cum), tp=p.t.ret>=0, cp=p.cum>=0;
    ui.svg.append(se('line',{x1:x,y1:g.p.t,x2:x,y2:g.H-g.p.b,stroke:'rgba(205,224,242,.42)','stroke-width':1,'stroke-dasharray':'4 4','data-o':1}),se('line',{x1:g.p.l,y1:y,x2:g.W-g.p.r,y2:y,stroke:'rgba(205,224,242,.34)','stroke-width':1,'stroke-dasharray':'4 4','data-o':1}),se('circle',{cx:x,cy:y,r:4.5,fill:'#071423',stroke:tp?'#75ddb2':'#ff8e99','stroke-width':2,'data-o':1}));
    ui.live.innerHTML=`<span>${fmtJst(p.t.entryTs)} JST</span><span>Trade <b class="${tp?'pos':'neg'}">${fmtPct(p.t.ret,3)}</b> · Cumulative <b class="${cp?'pos':'neg'}">${fmtPct(p.cum,2)}</b></span>`;
    ui.tip.innerHTML=`<div class="date">${fmtJst(p.t.entryTs)} JST</div><div class="row"><span>Trade P&amp;L</span><b class="${tp?'pos':'neg'}">${fmtPct(p.t.ret,3)}</b></div><div class="row"><span>Cumulative</span><b class="${cp?'pos':'neg'}">${fmtPct(p.cum,2)}</b></div><div class="row"><span>Entry → Exit</span><b>${p.t.entry.toFixed(3)} → ${p.t.exit.toFixed(3)}</b></div><div class="row"><span>Trade #</span><b>${p.i} / ${ui.pts.length-1}</b></div>`;
    ui.tip.classList.add('show');
    const rr=ui.stage.getBoundingClientRect(), sx=rr.width/g.W, sy=rr.height/g.H, px=x*sx, py=y*sy, tw=ui.tip.offsetWidth||184, th=ui.tip.offsetHeight||95;
    let left=px+12;if(left+tw>ui.stage.clientWidth-8)left=px-tw-12;left=clamp(left,8,Math.max(8,ui.stage.clientWidth-tw-8));
    ui.tip.style.left=`${left}px`;ui.tip.style.top=`${clamp(py-th/2,8,Math.max(8,ui.stage.clientHeight-th-8))}px`;
  }

  function clearPoint(){
    if(!ui.strategy)return; ui.active=null; ui.svg.querySelectorAll('[data-o="1"]').forEach(n=>n.remove()); ui.tip.classList.remove('show');
    const up=ui.strategy.totalRet>=0; ui.live.innerHTML=`<span>Latest cumulative <b class="${up?'pos':'neg'}">${fmtPct(ui.strategy.totalRet,2)}</b></span><span>${ui.strategy.trades.length} trades · Mid H1 open</span>`;
  }

  init();
})();
