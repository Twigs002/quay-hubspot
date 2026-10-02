/* Quay 1 — Dealflow Figures ("Ryan Dashboard")
 *
 * Standalone GH Pages dashboard of Quay 1 group sales & commission, rolled up
 * from the Dealflow Raw Data sheet by scripts/fetch_dealflow.py into
 * data/dealflow_figures.json (refreshed daily 05:00 SAST).
 *
 * Figures (locked with the user):
 *   - periods keyed on acceptanceDate, ALL deals counted
 *   - Gross = commissionExclVat (full commission excl VAT)
 *   - Nett  = totalGrossComm  (what Quay 1 makes excluding outside referral)
 *   - also: salesVolume (purchasePrice) and quay1 share (quay1GrossComm)
 *
 * Access is gated by the shared Supabase PIN login (super/admin only) — the
 * same auth layer as quay-leads / quay-clock.
 */
(() => {
  'use strict';

  // ─── Inline icons ────────────────────────────────────────────────────
  const s = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const I = {
    coins:  s('<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18M7 6h1v4M16.71 13.88l.7.71-2.82 2.82"/>'),
    wallet: s('<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/>'),
    house:  s('<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M9 22V12h6v10"/>'),
    file:   s('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>'),
  };

  // ─── Formatting ──────────────────────────────────────────────────────
  const esc = (str) => String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const n0 = (n) => (n == null || isNaN(n)) ? '0' : Math.round(+n).toLocaleString('en-GB');
  const money = (n) => 'R ' + n0(n);
  const moneyShort = (n) => {
    n = +n || 0;
    const a = Math.abs(n);
    if (a >= 1e6) return 'R' + (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'm';
    if (a >= 1e3) return 'R' + Math.round(n / 1e3) + 'k';
    return 'R' + Math.round(n);
  };
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Series colours — two tints of the Quay blue on one Rand axis. Dark = Nett
  // (what we keep), light = Gross (the whole commission). Amber is reserved
  // for the hero KPI accent, never a series.
  const C_GROSS = '#6B90D8';
  const C_NETT  = '#3D5BA6';

  // ─── State ───────────────────────────────────────────────────────────
  let _data = null;
  let _year = 'all';            // 'all' | 2024 | 2025 | ...
  let _divSort = 'nett';        // division table sort key
  let _currentUser = null;

  // ─── Data load ───────────────────────────────────────────────────────
  async function loadData() {
    const res = await fetch('data/dealflow_figures.json?cb=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  const years = () => (_data && _data.byYear ? _data.byYear.map(y => y.year) : []);
  const yearRow = (y) => (_data.byYear || []).find(r => r.year === y) || null;

  // Totals for the active scope (a specific year, or all-time).
  function scopeTotals() {
    if (_year === 'all') return _data.overall;
    return yearRow(_year) || { count: 0, salesVolume: 0, gross: 0, nett: 0, quay1: 0 };
  }

  // Months to plot for the active scope.
  function scopeMonths() {
    const all = _data.byMonth || [];
    if (_year === 'all') return all;
    return all.filter(m => m.ym.slice(0, 4) === String(_year));
  }

  function divisionsForScope() {
    const dy = _data.byDivisionYear || {};
    if (_year !== 'all') return (dy[String(_year)] || []).slice();
    // All-time: merge every year's division rows.
    const acc = {};
    Object.values(dy).forEach(list => list.forEach(d => {
      const t = acc[d.division] || (acc[d.division] =
        { division: d.division, count: 0, salesVolume: 0, gross: 0, nett: 0, quay1: 0 });
      t.count += d.count; t.salesVolume += d.salesVolume;
      t.gross += d.gross; t.nett += d.nett; t.quay1 += d.quay1;
    }));
    return Object.values(acc);
  }

  // ─── SVG chart helpers ───────────────────────────────────────────────
  // Nice axis ceiling + evenly-spaced ticks.
  function niceTicks(max, count) {
    if (max <= 0) return { top: 1, ticks: [0, 1] };
    const raw = max / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    const top = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = 0; v <= top + 1e-6; v += step) ticks.push(v);
    return { top, ticks };
  }

  const PLOT = { w: 860, h: 360, l: 70, r: 20, t: 24, b: 54 };
  const px = (x) => PLOT.l + x * (PLOT.w - PLOT.l - PLOT.r);
  const py = (v, top) => PLOT.t + (1 - v / top) * (PLOT.h - PLOT.t - PLOT.b);

  function axisG(top) {
    const { ticks } = niceTicks(top, 4);
    const base = PLOT.h - PLOT.b;
    let g = '';
    ticks.forEach(v => {
      const y = py(v, top);
      g += `<line class="grid" x1="${PLOT.l}" y1="${y.toFixed(1)}" x2="${PLOT.w - PLOT.r}" y2="${y.toFixed(1)}"/>`;
      g += `<text class="ax-y" x="${PLOT.l - 10}" y="${(y + 4).toFixed(1)}">${moneyShort(v)}</text>`;
    });
    g += `<line class="axis" x1="${PLOT.l}" y1="${base}" x2="${PLOT.w - PLOT.r}" y2="${base}"/>`;
    return g;
  }

  // Grouped bars: Gross + Nett per year.
  function annualChartSVG() {
    const data = _data.byYear || [];
    if (!data.length) return '';
    const max = Math.max(...data.map(d => Math.max(d.gross, d.nett)), 1);
    const { top } = niceTicks(max, 4);
    const base = PLOT.h - PLOT.b;
    const n = data.length;
    const slot = (PLOT.w - PLOT.l - PLOT.r) / n;
    const bw = Math.min(46, slot * 0.30);
    let bars = '';
    data.forEach((d, i) => {
      const cx = PLOT.l + slot * (i + 0.5);
      const pairs = [
        { key: 'Gross', val: d.gross, col: C_GROSS, dx: -bw - 3 },
        { key: 'Nett',  val: d.nett,  col: C_NETT,  dx: 3 },
      ];
      pairs.forEach(p => {
        const y = py(p.val, top);
        const h = Math.max(base - y, 0);
        bars += `<rect class="bar" x="${(cx + p.dx).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${p.col}" data-tip="${esc(d.year + ' · ' + p.key + ': ' + money(p.val))}"/>`;
        if (h > 16) bars += `<text class="bar-lbl" x="${(cx + p.dx + bw / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}">${moneyShort(p.val)}</text>`;
      });
      bars += `<text class="ax-x" x="${cx.toFixed(1)}" y="${base + 22}">${d.year}</text>`;
    });
    return `<svg class="chart" viewBox="0 0 ${PLOT.w} ${PLOT.h}" role="img" aria-label="Gross and nett commission by year">${axisG(top)}${bars}</svg>`;
  }

  // Two lines: Gross + Nett month on month.
  function monthChartSVG() {
    const data = scopeMonths();
    if (!data.length) return '';
    const max = Math.max(...data.map(d => Math.max(d.gross, d.nett)), 1);
    const { top } = niceTicks(max, 4);
    const base = PLOT.h - PLOT.b;
    const n = data.length;
    const xAt = (i) => (n === 1 ? px(0.5) : px(i / (n - 1)));
    const label = (d) => (_year === 'all' ? d.ym.slice(2).replace('-', "'").replace(/^(\d\d)'(\d\d)$/, "$2 '$1") : MONTHS[+d.ym.slice(5, 7) - 1]);
    const line = (key, col) => {
      let pts = data.map((d, i) => `${xAt(i).toFixed(1)},${py(d[key], top).toFixed(1)}`).join(' ');
      let dots = data.map((d, i) =>
        `<circle class="dot" cx="${xAt(i).toFixed(1)}" cy="${py(d[key], top).toFixed(1)}" r="4" fill="${col}" data-tip="${esc(d.ym + ' · ' + (key === 'gross' ? 'Gross' : 'Nett') + ': ' + money(d[key]))}"/>`).join('');
      return `<polyline class="ln" points="${pts}" stroke="${col}"/>${dots}`;
    };
    // x labels — thin out if crowded.
    const every = Math.ceil(n / 14);
    let xlabels = '';
    data.forEach((d, i) => {
      if (i % every === 0 || i === n - 1) {
        xlabels += `<text class="ax-x" x="${xAt(i).toFixed(1)}" y="${base + 22}">${esc(label(d))}</text>`;
      }
    });
    return `<svg class="chart" viewBox="0 0 ${PLOT.w} ${PLOT.h}" role="img" aria-label="Gross and nett commission month on month">${axisG(top)}${xlabels}${line('gross', C_GROSS)}${line('nett', C_NETT)}</svg>`;
  }

  const legend = () => `
    <div class="legend">
      <span class="lg"><i style="background:${C_NETT}"></i>Nett <span class="muted">(what we keep)</span></span>
      <span class="lg"><i style="background:${C_GROSS}"></i>Gross <span class="muted">(total commission)</span></span>
    </div>`;

  // ─── Sections ────────────────────────────────────────────────────────
  function controls() {
    const opts = ['all', ...years()];
    const btns = opts.map(y => {
      const lbl = y === 'all' ? 'All years' : y;
      return `<button class="chip${String(_year) === String(y) ? ' active' : ''}" data-year="${y}">${lbl}</button>`;
    }).join('');
    const gen = _data.generatedAt
      ? 'Updated ' + new Date(_data.generatedAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : 'Awaiting first sync';
    return `
      <div class="fig-controls">
        <div>
          <p class="d-eyebrow">QUAY 1 GROUP</p>
          <h2 class="d-title">${_year === 'all' ? 'All-time figures' : _year + ' figures'}</h2>
        </div>
        <div class="fig-controls-right">
          <div class="chips" id="yearChips">${btns}</div>
          <span class="fig-updated">${esc(gen)}</span>
        </div>
      </div>`;
  }

  function kpis() {
    const t = scopeTotals();
    let nettFoot = _year === 'all' ? 'All time' : 'FY' + _year;
    // YoY delta on nett when a specific year is chosen and a prior year exists.
    if (_year !== 'all') {
      const prev = yearRow(_year - 1);
      if (prev && prev.nett > 0) {
        const d = (t.nett - prev.nett) / prev.nett;
        const up = d >= 0;
        nettFoot = `FY${_year} · <span class="kpi-delta kpi-delta--${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(d * 100).toFixed(0)}% vs ${_year - 1}</span>`;
      }
    }
    const tile = (ic, label, val, foot, hero) => `
      <div class="card kpi${hero ? ' kpi--accent' : ''}">
        <div class="kpi-top">
          <span class="kpi-label">${label}</span>
          <span class="kpi-ic">${ic}</span>
        </div>
        <div class="kpi-val">${val}</div>
        <div class="kpi-foot">${foot}</div>
      </div>`;
    return `<div class="row kpis">
      ${tile(I.coins,  'Nett commission',  money(t.nett),  nettFoot, true)}
      ${tile(I.wallet, 'Gross commission', money(t.gross), 'Total commission excl VAT')}
      ${tile(I.house,  'Sales volume',     money(t.salesVolume), 'Sum of purchase prices')}
      ${tile(I.file,   'Deals',            n0(t.count), _year === 'all' ? 'All deals, all time' : 'Deals accepted in ' + _year)}
    </div>`;
  }

  function annualCard() {
    const data = _data.byYear || [];
    const rows = data.map(d => `
      <tr>
        <td><b>${d.year}</b></td>
        <td class="num tnum">${n0(d.count)}</td>
        <td class="num tnum">${money(d.salesVolume)}</td>
        <td class="num tnum">${money(d.gross)}</td>
        <td class="num tnum"><b>${money(d.nett)}</b></td>
        <td class="num tnum">${money(d.quay1)}</td>
      </tr>`).join('');
    const o = _data.overall;
    const total = `
      <tr class="tbl-total">
        <td><b>All years</b></td>
        <td class="num tnum">${n0(o.count)}</td>
        <td class="num tnum">${money(o.salesVolume)}</td>
        <td class="num tnum">${money(o.gross)}</td>
        <td class="num tnum"><b>${money(o.nett)}</b></td>
        <td class="num tnum">${money(o.quay1)}</td>
      </tr>`;
    return `
      <section class="card card-pad mt">
        <div class="card-head">
          <h3 class="d-subtitle">Annual figures</h3>
          ${legend()}
        </div>
        <div class="chart-wrap">${annualChartSVG()}</div>
        <div class="tbl-wrap mt">
          <table class="tbl">
            <thead><tr>
              <th>Year</th><th class="num">Deals</th><th class="num">Sales volume</th>
              <th class="num">Gross</th><th class="num">Nett</th><th class="num">Quay 1 share</th>
            </tr></thead>
            <tbody>${rows}${total}</tbody>
          </table>
        </div>
      </section>`;
  }

  function monthCard() {
    return `
      <section class="card card-pad mt">
        <div class="card-head">
          <h3 class="d-subtitle">Month on month ${_year === 'all' ? '· all months' : '· ' + _year}</h3>
          ${legend()}
        </div>
        <div class="chart-wrap">${monthChartSVG() || '<p class="sub">No deals in this period.</p>'}</div>
      </section>`;
  }

  function divisionCard() {
    let divs = divisionsForScope();
    divs.sort((a, b) => (b[_divSort] || 0) - (a[_divSort] || 0));
    const maxNett = Math.max(...divs.map(d => d.nett), 1);
    const col = (k, lbl) => `<th class="num sortable${_divSort === k ? ' sorted' : ''}" data-sort="${k}">${lbl}${_divSort === k ? ' <span class="sort-ind sort-ind--active">▼</span>' : ''}</th>`;
    const rows = divs.map(d => `
      <tr>
        <td class="div-name">${esc(d.division)}</td>
        <td class="num tnum">${n0(d.count)}</td>
        <td class="num tnum">${money(d.salesVolume)}</td>
        <td class="num tnum">${money(d.gross)}</td>
        <td class="num tnum"><b>${money(d.nett)}</b></td>
        <td class="bar-cell">
          <span class="minibar"><span class="minibar-fill" style="width:${Math.max(2, (d.nett / maxNett) * 100).toFixed(1)}%"></span></span>
        </td>
      </tr>`).join('');
    return `
      <section class="card card-pad mt">
        <div class="card-head">
          <h3 class="d-subtitle">By division ${_year === 'all' ? '· all time' : '· ' + _year}</h3>
          <span class="sub">${divs.length} division${divs.length === 1 ? '' : 's'}</span>
        </div>
        <div class="tbl-wrap mt">
          <table class="tbl tbl-sortable">
            <thead><tr>
              <th>Division</th>${col('count', 'Deals')}${col('salesVolume', 'Sales volume')}${col('gross', 'Gross')}${col('nett', 'Nett')}
              <th class="bar-col">Nett share</th>
            </tr></thead>
            <tbody>${rows || '<tr><td colspan="6" class="sub">No deals in this period.</td></tr>'}</tbody>
          </table>
        </div>
      </section>`;
  }

  function footnote() {
    const sc = _data.statusCounts || {};
    const statusBits = Object.entries(sc)
      .map(([k, v]) => `<span class="st-chip">${esc(k.replace(/_/g, ' ').toLowerCase())} <b>${n0(v)}</b></span>`).join('');
    const undated = _data.undated && _data.undated.count ? _data.undated.count : 0;
    return `
      <section class="card card-pad mt fig-notes">
        <h3 class="d-subtitle">Definitions &amp; notes</h3>
        <ul class="notes-list">
          <li><b>Gross</b> — total commission earned excl VAT (<code>commissionExclVat</code>).</li>
          <li><b>Nett</b> — what Quay 1 makes excluding outside referral (<code>totalGrossComm</code>).</li>
          <li><b>Quay 1 share</b> — Quay 1's portion of the commission (<code>quay1GrossComm</code>).</li>
          <li>Figures are keyed on <b>acceptance date</b> and include <b>all deals</b> regardless of status.</li>
          ${undated ? `<li>${n0(undated)} deal${undated === 1 ? '' : 's'} have no acceptance date and are excluded from the annual / monthly split.</li>` : ''}
        </ul>
        ${statusBits ? `<div class="st-row"><span class="sub">Deal status mix:</span> ${statusBits}</div>` : ''}
      </section>`;
  }

  function emptyState() {
    return `
      <section class="card card-pad mt" style="text-align:center;padding:48px 24px">
        <h3 class="d-subtitle" style="justify-content:center">Awaiting first data sync</h3>
        <p class="sub" style="max-width:520px;margin:10px auto 0">
          Figures will appear after the daily 05:00 refresh. If this persists, the source
          Dealflow sheet still needs to be shared (read-only) with the automation service
          account so the scheduled job can read it.
        </p>
      </section>`;
  }

  // ─── Render ──────────────────────────────────────────────────────────
  function render() {
    const root = document.getElementById('content');
    if (!root) return;
    if (!_data) { root.innerHTML = '<p class="sub">Loading…</p>'; return; }

    const empty = _data.placeholder || !(_data.overall && _data.overall.count > 0);
    root.className = 'main figures-view';
    root.innerHTML = empty
      ? controls() + emptyState()
      : controls() + kpis() + annualCard() + monthCard() + divisionCard() + footnote();

    // Year chips
    root.querySelectorAll('#yearChips .chip').forEach(b =>
      b.addEventListener('click', () => {
        const y = b.dataset.year;
        _year = (y === 'all') ? 'all' : +y;
        render();
      }));
    // Division sort
    root.querySelectorAll('th.sortable').forEach(th =>
      th.addEventListener('click', () => { _divSort = th.dataset.sort; render(); }));

    wireTooltip(root);
  }

  // Single shared HTML tooltip driven by [data-tip] on bars + dots.
  function wireTooltip(root) {
    let tip = document.getElementById('figTip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'figTip'; tip.className = 'fig-tip'; tip.hidden = true;
      document.body.appendChild(tip);
    }
    root.querySelectorAll('[data-tip]').forEach(el => {
      el.addEventListener('mouseenter', (e) => {
        tip.textContent = el.getAttribute('data-tip');
        tip.hidden = false;
      });
      el.addEventListener('mousemove', (e) => {
        tip.style.left = (e.clientX + 12) + 'px';
        tip.style.top = (e.clientY + 12) + 'px';
      });
      el.addEventListener('mouseleave', () => { tip.hidden = true; });
    });
  }

  // ─── Auth wiring (ported from the HubSpot build) ──────────────────────
  function enterApp(user) {
    _currentUser = user || null;
    document.body.classList.remove('pre-auth');
    if (window.QuayNav) window.QuayNav.mount({ isSuper: !!(user && user.isSuper), current: 'hubspot' });
    const gate = document.getElementById('loginGate');
    if (gate) gate.remove();
    const so = document.getElementById('signOutBtn');
    if (so) {
      so.hidden = false;
      const who = document.getElementById('signOutWho');
      if (who && user && user.name) who.textContent = user.name.split(' ')[0] + ' · ';
      so.addEventListener('click', async () => {
        so.disabled = true;
        await window.AUTH.signOut();
        location.reload();
      });
    }
    render();
    loadData()
      .then(d => { _data = d; _year = years().length ? years()[years().length - 1] : 'all'; render(); })
      .catch(() => { _data = { placeholder: true, overall: { count: 0 }, byYear: [] }; render(); });
  }

  function showLoginGate(prefillError) {
    const gate  = document.getElementById('loginGate');
    const errEl = document.getElementById('loginError');
    const dots  = document.getElementById('pinDots');
    const keypad = document.getElementById('loginKeypad');
    const userIn = document.getElementById('loginUser');
    if (prefillError && errEl) { errEl.textContent = prefillError; errEl.hidden = false; }
    if (!gate || !keypad) return;

    let pin = '';
    let busy = false;
    const paintDots = () => {
      if (!dots) return;
      Array.from(dots.children).forEach((d, i) => d.classList.toggle('filled', i < pin.length));
    };
    const setError = (msg) => { if (!errEl) return; errEl.textContent = msg || ''; errEl.hidden = !msg; };

    async function submit() {
      if (busy) return;
      const u = (userIn && userIn.value || '').trim();
      if (!u) { setError('Enter your username first.'); flash(); pin = ''; paintDots(); return; }
      if (pin.length !== 6) return;
      busy = true; setError('');
      let r;
      try { r = await window.AUTH.signIn(u, pin); }
      catch (_) { r = { ok: false, error: 'Sign-in service unavailable — try again.' }; }
      if (r && r.ok) { enterApp(r.user); return; }
      busy = false;
      setError((r && r.error) || 'Sign-in failed.');
      flash(); pin = ''; paintDots();
    }
    function flash() {
      gate.classList.add('pin-error');
      setTimeout(() => gate.classList.remove('pin-error'), 500);
    }
    function press(d) {
      if (busy || pin.length >= 6) return;
      pin += d; paintDots();
      if (pin.length === 6) submit();
    }

    keypad.querySelectorAll('.key[data-d]').forEach(b =>
      b.addEventListener('click', () => { setError(''); press(b.dataset.d); }));
    const back = keypad.querySelector('.key[data-back]');
    if (back) back.addEventListener('click', () => { pin = pin.slice(0, -1); paintDots(); });
    const clr = keypad.querySelector('.key[data-clear]');
    if (clr) clr.addEventListener('click', () => { pin = ''; setError(''); paintDots(); });

    document.addEventListener('keydown', (e) => {
      if (!document.getElementById('loginGate')) return;
      if (e.key >= '0' && e.key <= '9') { setError(''); press(e.key); }
      else if (e.key === 'Backspace' && document.activeElement !== userIn) { pin = pin.slice(0, -1); paintDots(); }
      else if (e.key === 'Enter') { submit(); }
    });

    if (userIn) userIn.focus();
  }

  document.addEventListener('DOMContentLoaded', async () => {
    if (!window.AUTH || !window.supabase) {
      showLoginGate('Could not reach the sign-in service. Refresh to try again.');
      return;
    }
    let user = null;
    try { user = await window.AUTH.getSession(); } catch (_) { user = null; }
    if (user) enterApp(user);
    else showLoginGate();
  });
})();
