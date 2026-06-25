(() => {
  'use strict';

  // ─── Inline icons (vanilla SVG, mirrors quay-dashboard-v2's I object) ──
  const s = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const I = {
    layers: s('<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>'),
    alert:  s('<path d="M12 3 2 20h20L12 3Z"/><path d="M12 9v5M12 17h.01"/>'),
    target: s('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/>'),
    check:  s('<path d="M20 6 9 17l-5-5"/>'),
  };

  // ─── Helpers ─────────────────────────────────────────────────────────
  const escapeHtml = (str) => String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const fmt = (n) => {
    if (n == null || isNaN(n)) return '0';
    return Math.round(Number(n)).toLocaleString('en-GB');
  };

  // ─── HubSpot Out-of-Date Deals view ──────────────────────────────────
  // The 3 Dialfire-overlay columns (Avg Logged / Avg Answered / Avg NA)
  // are intentionally not in this list yet — they would render as 14 columns
  // of em-dashes until the Dialfire overlay lands. They'll come back as
  // additional entries once that data is wired in.
  const HUBSPOT_COLS = [
    { k: 'calling',    label: 'Calling',      tip: 'Calling leads — outdated / total',     isStage: true },
    { k: 'external',   label: 'External',     tip: 'External leads — outdated / total',    isStage: true },
    { k: 'inbound',    label: 'Inbound',      tip: 'Inbound leads — outdated / total',     isStage: true },
    { k: 'reconv',     label: 'Reconv',       tip: 'Reconverted leads — outdated / total', isStage: true },
    { k: 'rental',     label: 'Rental',       tip: 'Rental leads — outdated / total',      isStage: true },
    { k: 'nurture',    label: 'Nurture',      tip: 'Leads to nurture — outdated / total',  isStage: true },
    { k: 'warm',       label: 'Warm',         tip: 'Warm leads — outdated / total',        isStage: true },
    { k: 'hot',        label: 'Hot',          tip: 'Hot leads — outdated / total',         isStage: true },
    { k: 'outdated',   label: 'Outdated',     tip: 'Total outdated leads across all stages' },
    { k: 'upToHot',    label: 'Up to Hot',    tip: 'Total deals in stages up to Hot Lead' },
    { k: 'pctUpdated', label: '% Updated',    tip: 'Share of leads with a future next-activity date', isPct: true },
  ];

  // Filter chips above the table — restrict the visible roster to a
  // worth-acting-on subset. Director-mode triage.
  const HUBSPOT_FILTERS = [
    { k: 'all',       label: 'All teams',     test: () => true },
    { k: 'stale50',   label: 'Stale > 50%',   test: (r) => r._stalePct >= 0.5 && r._tot > 0 },
    { k: 'stale80',   label: 'Stale > 80%',   test: (r) => r._stalePct >= 0.8 && r._tot > 0 },
    { k: 'hot',       label: 'Hot leads only',test: (r) => (r.total && r.total.hot || 0) > 0 },
    { k: 'hotStale',  label: 'Hot + stale',   test: (r) => (r.outdated && r.outdated.hot || 0) > 0 },
  ];

  let _hubspot = null;
  let _hubspotLoading = false;
  let _hubspotGroup = '1';
  let _hubspotSortBy = 'pctUpdated';
  let _hubspotSortDir = 'asc';   // worst first
  let _hubspotShowEmpty = false; // hide rows with 0 deals
  let _hubspotFilter = 'all';

  async function loadHubspot() {
    if (_hubspotLoading) return;
    _hubspotLoading = true;
    try {
      const r = await fetch('data/hubspot_outdated.json?cb=' + Date.now());
      if (!r.ok) throw new Error('HTTP ' + r.status);
      _hubspot = await r.json();
    } catch (e) {
      console.warn('[hubspot] load failed', e);
      _hubspot = { error: String(e.message || e), generated: null, groups: { '1': [], '2': [], '3': [] } };
    } finally {
      _hubspotLoading = false;
      render();
    }
  }

  function render() {
    const host = document.getElementById('content');
    host.innerHTML = renderHubspot();
    wireHubspot();
    // Mirror the refresh badge into the sticky topbar so the freshness
    // signal stays visible when the user has scrolled past the title card.
    const topbarSlot = document.getElementById('topbarRefresh');
    if (topbarSlot && _hubspot && _hubspot.generated) {
      const d = new Date(_hubspot.generated);
      const hrs = (Date.now() - d.getTime()) / 3600000;
      const cls = hrs < 30 ? 'ok' : hrs < 72 ? 'warn' : 'bad';
      const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
      const rel = mins < 60 ? mins + 'm ago'
                : hrs  < 24 ? Math.round(hrs) + 'h ago'
                : Math.round(hrs / 24) + 'd ago';
      const abs = d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Johannesburg' }) + ' SAST';
      topbarSlot.innerHTML = `<span class="pill ${cls}" title="${escapeHtml(abs)}">Refreshed ${escapeHtml(rel)}</span>`;
    } else if (topbarSlot) {
      topbarSlot.innerHTML = '';
    }
  }

  // ─── Helpers shared across the render ──────────────────────────────
  const _num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
  const _stalePctOf = (r) => {
    const t = _num(r.total && r.total.deals);
    const o = _num(r.outdated && r.outdated.outdated);
    return t > 0 ? o / t : 0;
  };
  // Compact integer formatter for tight cells ("29.4k" instead of "29431").
  const _fmtK = (n) => {
    const v = Math.abs(Number(n) || 0);
    if (v >= 100000) return (v / 1000).toFixed(0) + 'k';
    if (v >= 10000)  return (v / 1000).toFixed(1) + 'k';
    return String(Math.round(Number(n) || 0));
  };

  function _hsKpiForGroup(rows) {
    const total = rows.reduce((s, r) => s + _num(r.total && r.total.deals), 0);
    const out   = rows.reduce((s, r) => s + _num(r.outdated && r.outdated.outdated), 0);
    const pctRows = rows.filter(r => r.outdated && r.outdated.pctUpdated != null);
    const avg = pctRows.length
      ? pctRows.reduce((s, r) => s + _num(r.outdated.pctUpdated), 0) / pctRows.length
      : 0;
    return { totalDeals: total, outdatedLeads: out,
             pctOutdated: total > 0 ? out / total : 0,
             avgPctUpdated: avg, reportingTeams: pctRows.length };
  }

  function renderHubspot() {
    if (_hubspot == null && !_hubspotLoading) loadHubspot();
    if (_hubspot == null) {
      return `<div class="tab-view"><div class="card card-pad" style="text-align:center;color:var(--muted);padding:60px 20px">Loading HubSpot figures…</div></div>`;
    }

    const groups     = (_hubspot.groups) || { '1': [], '2': [], '3': [] };
    const groupNames = (_hubspot.groupNames) || { '1': 'Group 1', '2': 'Group 2', '3': 'Group 3' };
    const allRows    = groups[_hubspotGroup] || [];
    const portalId   = _hubspot.portalId || null;

    // Decorate rows with cached _tot / _stalePct used by the filter, the
    // top-3 callout, and the sort comparator.
    allRows.forEach(r => {
      r._tot = _num(r.total && r.total.deals);
      r._out = _num(r.outdated && r.outdated.outdated);
      r._stalePct = r._tot > 0 ? r._out / r._tot : 0;
    });

    // Apply filter, then "hide empty teams" toggle, then sort.
    const filter = HUBSPOT_FILTERS.find(f => f.k === _hubspotFilter) || HUBSPOT_FILTERS[0];
    let visible = allRows.filter(filter.test);
    if (!_hubspotShowEmpty) visible = visible.filter(r => r._tot > 0);

    // Sort comparator. Default 'pctUpdated' asc puts the worst-performing
    // teams (with deals) at the top — that's the triage view a director
    // opens the dashboard for.
    visible = visible.slice().sort((a, b) => {
      const k = _hubspotSortBy;
      const av = (k === 'team'    ? (a.team || '').toLowerCase()
               : k === 'total'   ? a._tot
               : k === 'outdated' ? a._out
               : k === 'pctUpdated' ? (a.outdated && a.outdated.pctUpdated != null ? a.outdated.pctUpdated : 2)  // empty rows last
               : _num(a.outdated && a.outdated[k]));
      const bv = (k === 'team'    ? (b.team || '').toLowerCase()
               : k === 'total'   ? b._tot
               : k === 'outdated' ? b._out
               : k === 'pctUpdated' ? (b.outdated && b.outdated.pctUpdated != null ? b.outdated.pctUpdated : 2)
               : _num(b.outdated && b.outdated[k]));
      if (av < bv) return _hubspotSortDir === 'asc' ? -1 : 1;
      if (av > bv) return _hubspotSortDir === 'asc' ?  1 : -1;
      return 0;
    });

    const emptyCount  = allRows.filter(r => r._tot === 0).length;
    const hiddenByFil = allRows.length - visible.length - (_hubspotShowEmpty ? 0 : emptyCount);

    // ── Refresh badge ───────────────────────────────────────────────
    const genDate = _hubspot.generated ? new Date(_hubspot.generated) : null;
    const genAbs  = genDate
      ? genDate.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Johannesburg' }) + ' SAST'
      : null;
    const relAge = (d) => {
      if (!d) return null;
      const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
      if (mins < 60) return mins + 'm ago';
      const hrs = Math.round(mins / 60);
      if (hrs  < 24) return hrs  + 'h ago';
      return Math.round(hrs / 24) + 'd ago';
    };
    const ageClass = (() => {
      if (!genDate) return 'bad';
      const hrs = (Date.now() - genDate.getTime()) / 3600000;
      if (hrs < 30) return 'ok';
      if (hrs < 72) return 'warn';
      return 'bad';
    })();
    const refreshBadge = genDate
      ? `<span class="pill ${ageClass}" title="${escapeHtml(genAbs)}">Refreshed ${escapeHtml(relAge(genDate))}</span>`
      : `<span class="pill bad" title="Workflow has never populated data/hubspot_outdated.json">Snapshot — never refreshed</span>`;

    // ── KPIs + delta vs previous run ────────────────────────────────
    const kpi      = _hsKpiForGroup(allRows);
    const prevKpi  = (_hubspot._prev && _hubspot._prev.kpi && _hubspot._prev.kpi[_hubspotGroup]) || null;
    const deltaFmt = (cur, prev, unit, invertColour) => {
      if (prev == null || cur == null) return '';
      const d = cur - prev;
      if (Math.abs(d) < 0.0005) return '';
      const arrow = d > 0 ? '▲' : '▼';
      // For "% Outdated" and "Outdated Leads", UP is bad. For "% Updated"
      // and "Total Deals", UP is good. invertColour=true flips the
      // green/red mapping for the bad-is-up metrics.
      const up = d > 0;
      const good = invertColour ? !up : up;
      const cls = good ? 'kpi-delta kpi-delta--up' : 'kpi-delta kpi-delta--down';
      const txt = unit === '%' ? `${Math.abs(d * 100).toFixed(1)} pts` : fmt(Math.round(Math.abs(d)));
      return `<span class="${cls}" title="vs previous refresh">${arrow} ${txt}</span>`;
    };
    const kpiCard = (icon, label, val, foot, delta, heroClass) => `<div class="card kpi ${heroClass || ''}">
      <div class="kpi-top"><div class="kpi-ic">${icon}</div>${delta || ''}</div>
      <div class="kpi-label">${escapeHtml(label)}</div>
      <div class="kpi-val tnum">${val}</div>
      <div class="kpi-foot">${escapeHtml(foot)}</div>
    </div>`;

    // Hero KPI tint by current % outdated value.
    const heroClass = (() => {
      const p = kpi.pctOutdated * 100;
      if (p >= 60) return 'kpi--hero-bad';
      if (p >= 30) return 'kpi--hero-warn';
      return 'kpi--hero-ok';
    })();

    // ── Group seg control: now includes health % per group ──────────
    const segBtn = (k) => {
      const gRows = groups[k] || [];
      const gk    = _hsKpiForGroup(gRows);
      const stale = gk.totalDeals > 0 ? (gk.outdatedLeads / gk.totalDeals) * 100 : 0;
      const staleClass = stale >= 60 ? 'seg-stale-bad' : stale >= 30 ? 'seg-stale-warn' : 'seg-stale-ok';
      const name  = groupNames[k] || ('Group ' + k);
      return `<button class="${k === _hubspotGroup ? 'active' : ''}" data-hs-group="${k}">
        ${escapeHtml(name)}
        <span class="seg-meta">· ${gRows.length} teams</span>
        ${gk.totalDeals > 0 ? `<span class="seg-meta ${staleClass}">· ${stale.toFixed(0)}% stale</span>` : ''}
      </button>`;
    };

    // ── Top-3 needs-attention callout ───────────────────────────────
    // Score = absolute outdated count × outdated share. Rewards teams
    // that are both large and bad — the director's emails-to-send list.
    const top3 = allRows
      .filter(r => r._tot >= 5 && r._stalePct >= 0.3)
      .map(r => ({ row: r, score: r._out * r._stalePct }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    const hubspotLinkFor = (r) => {
      if (!portalId || !r.ownerIds || !r.ownerIds.length) return null;
      // Filter the HubSpot deal-list to this team's owners. Field name
      // 'hubspot_owner_id' is HubSpot's standard owner filter param.
      return `https://app.hubspot.com/contacts/${encodeURIComponent(portalId)}/objects/0-3/views/all/list` +
             `?query=&filters=%5B%7B%22property%22%3A%22hubspot_owner_id%22%2C%22operator%22%3A%22IN%22%2C%22values%22%3A%5B${r.ownerIds.map(encodeURIComponent).join('%2C')}%5D%7D%5D`;
    };
    const top3Html = top3.length === 0
      ? `<div class="muted" style="font-size:13px">No teams flagged for attention in ${escapeHtml(groupNames[_hubspotGroup])} — every team with ≥5 deals is below the 30% stale threshold.</div>`
      : top3.map(({ row: r }, i) => {
          const link = hubspotLinkFor(r);
          const stalePct = (r._stalePct * 100).toFixed(0);
          const inner = `
            <div class="t3-rank">${i + 1}</div>
            <div class="t3-body">
              <div class="t3-name">${escapeHtml(r.team)}</div>
              <div class="t3-stats">
                <span class="t3-stat"><b>${fmt(r._out)}</b> stale of <b>${fmt(r._tot)}</b></span>
                <span class="t3-stat t3-pct" style="color:${r._stalePct >= 0.6 ? 'var(--red)' : r._stalePct >= 0.3 ? 'var(--amber)' : 'var(--green)'}">${stalePct}% stale</span>
              </div>
            </div>
            ${link ? `<div class="t3-go" aria-hidden="true">→</div>` : ''}`;
          return link
            ? `<a class="t3-card" href="${link}" target="_blank" rel="noopener" title="Open this team's deals in HubSpot">${inner}</a>`
            : `<div class="t3-card t3-card--static">${inner}</div>`;
        }).join('');

    // ── Filter chips ────────────────────────────────────────────────
    const filterChips = HUBSPOT_FILTERS.map(f => {
      const count = allRows.filter(r => r._tot > 0).filter(f.test).length;
      return `<button class="chip ${f.k === _hubspotFilter ? 'active' : ''}" data-hs-filter="${f.k}">
        ${escapeHtml(f.label)}<span class="chip-count">${count}</span>
      </button>`;
    }).join('');

    // ── Cell formatters + colour ───────────────────────────────────
    const fmtCell = (v, isPct) => {
      if (v == null || v === '') return '<span class="muted">—</span>';
      if (isPct) return (Number(v) * 100).toFixed(1) + '%';
      const n = Number(v);
      return isFinite(n) ? n.toFixed(n % 1 === 0 ? 0 : 1) : escapeHtml(String(v));
    };
    // Stage cell: "outdated/total" with green/red colour + accessibility
    // marker so the meaning isn't carried only by hue. ✓ when none stale,
    // ⚠ when all stale.
    const stageCell = (outdatedN, totalN) => {
      if (!totalN) return '<td class="num"><span class="muted">—</span></td>';
      const out = Number(outdatedN || 0);
      const tot = Number(totalN);
      const allStale  = tot > 0 && out === tot;
      const noneStale = out === 0;
      const colour = allStale  ? 'color:var(--red);font-weight:700'
                   : noneStale ? 'color:var(--green);font-weight:700'
                               : 'color:var(--ink);font-weight:600';
      const marker = allStale ? ' ⚠'
                   : noneStale ? ' ✓'
                               : '';
      const display = `${_fmtK(out)}<span class="cell-slash">/</span>${_fmtK(tot)}${marker}`;
      const title = `${out} outdated of ${tot} total`;
      return `<td class="num tnum" style="${colour}" title="${title}">${display}</td>`;
    };
    const pctClass = (frac) => {
      if (frac == null) return '';
      const p = Number(frac) * 100;
      if (p >= 85) return 'ok';
      if (p >= 70) return 'warn';
      return 'bad';
    };
    const outdatedClass = (outdatedN, totalN) => {
      if (!totalN || totalN <= 0 || outdatedN == null) return '';
      const share = outdatedN / totalN;
      if (share >= 0.30) return 'bad';
      if (share >= 0.15) return 'warn';
      return 'ok';
    };
    const pctCell = (frac) => {
      if (frac == null) return '<td class="num"><span class="muted">—</span></td>';
      const cls = pctClass(frac);
      const sym = cls === 'ok' ? ' ✓' : cls === 'bad' ? ' ⚠' : '';
      return `<td class="num"><span class="pill ${cls}">${(Number(frac) * 100).toFixed(1)}%${sym}</span></td>`;
    };
    const outdatedCell = (outdatedN, totalN) => {
      if (outdatedN == null) return '<td class="num"><span class="muted">—</span></td>';
      const cls = outdatedClass(Number(outdatedN), Number(totalN));
      if (!cls) return `<td class="num tnum">${fmt(Math.round(outdatedN))}</td>`;
      const sym = cls === 'bad' ? ' ⚠' : cls === 'ok' ? ' ✓' : '';
      return `<td class="num"><span class="pill ${cls}" style="font-variant-numeric:tabular-nums">${fmt(Math.round(outdatedN))}${sym}</span></td>`;
    };
    const sumCol = (k) => visible.reduce((s, r) => s + _num(r.outdated && r.outdated[k]), 0);

    const STK_TH  = 'position:sticky;left:0;z-index:2;background:var(--paper-2);box-shadow:1px 0 0 var(--line-2)';
    const STK_TD  = 'position:sticky;left:0;z-index:1;background:var(--card);box-shadow:1px 0 0 var(--line-2);white-space:nowrap';
    const STK_TOT = 'position:sticky;left:0;z-index:1;background:#F7F8FC;box-shadow:1px 0 0 var(--line-2)';

    // Sort indicator on the active column header.
    const sortIndic = (k) => {
      if (k !== _hubspotSortBy) return '<span class="sort-ind"> ⇅</span>';
      return _hubspotSortDir === 'asc'
        ? '<span class="sort-ind sort-ind--active"> ▲</span>'
        : '<span class="sort-ind sort-ind--active"> ▼</span>';
    };

    const headerCellForStage = (c) =>
      `<th class="num" style="min-width:${c.k === 'pctUpdated' ? 96 : 78}px" title="${escapeHtml(c.tip)}" data-hs-sort="${c.k}">${escapeHtml(c.label)}${sortIndic(c.k)}</th>`;
    const headerNumeric = (k, label, tip, w) =>
      `<th class="num" style="min-width:${w}px" title="${escapeHtml(tip)}" data-hs-sort="${k}">${escapeHtml(label)}${sortIndic(k)}</th>`;
    const teamHeader = `<th style="${STK_TH};min-width:180px;text-align:left" data-hs-sort="team">Team${sortIndic('team')}</th>`;
    const totalHeader = headerNumeric('total', 'Total', 'Total deals for this team', 74);

    const emptyRow = `<tr><td colspan="${HUBSPOT_COLS.length + 2}" class="muted" style="text-align:center;padding:36px 20px;line-height:1.55">
      No data yet — generate a HubSpot Private App token and run the<br>
      <code style="background:var(--paper);padding:2px 6px;border-radius:4px;font-size:12px">fetch-hubspot</code> workflow to populate this view.
    </td></tr>`;
    const noVisibleRow = `<tr><td colspan="${HUBSPOT_COLS.length + 2}" class="muted" style="text-align:center;padding:36px 20px;line-height:1.55">
      No teams match the current filter / hidden-empties setting.
    </td></tr>`;

    return `<div class="tab-view">

      <div class="card card-pad hs-titlebar">
        <div style="display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start;justify-content:space-between">
          <div style="min-width:0;flex:1 1 320px">
            <div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px">
              <h3 style="margin:0;font-family:var(--serif);font-size:17px;color:var(--ink)">Out-of-Date Deals · per team</h3>
              ${refreshBadge}
            </div>
            <div class="sub" style="margin-top:6px">
              Mirrors the RAW DATA DEALS spreadsheet · pulled from HubSpot
              ${genAbs ? ` · ${escapeHtml(genAbs)}` : ''}
            </div>
          </div>
          <div class="seg seg-with-meta" id="hsGroupSeg" style="flex-wrap:wrap">
            ${segBtn('1')}${segBtn('2')}${segBtn('3')}
          </div>
        </div>
        ${_hubspot.error ? `<div class="banner" style="margin-top:12px;background:var(--red-tint);color:var(--red);padding:8px 10px;border-radius:6px;font-size:12.5px">Data not loaded — ${escapeHtml(_hubspot.error)}. The GH Action will populate it on its next run.</div>` : ''}
      </div>

      <div class="row kpis mt">
        ${kpiCard(I.alert,  'Outdated Leads',
                  fmt(kpi.outdatedLeads),
                  'sum of stale leads across the group',
                  deltaFmt(kpi.outdatedLeads, prevKpi && prevKpi.outdatedLeads, '', true))}
        ${kpiCard(I.target, '% Outdated',
                  (kpi.pctOutdated * 100).toFixed(1) + '%',
                  'outdated ÷ total deals',
                  deltaFmt(kpi.pctOutdated, prevKpi && prevKpi.pctOutdated, '%', true),
                  heroClass)}
        ${kpiCard(I.check,  'Avg % Updated',
                  (kpi.avgPctUpdated * 100).toFixed(1) + '%',
                  'mean across ' + kpi.reportingTeams + ' reporting team' + (kpi.reportingTeams === 1 ? '' : 's'),
                  deltaFmt(kpi.avgPctUpdated, prevKpi && prevKpi.avgPctUpdated, '%', false))}
        ${kpiCard(I.layers, 'Total Deals',
                  fmt(kpi.totalDeals),
                  escapeHtml(groupNames[_hubspotGroup] || ('Group ' + _hubspotGroup)) + ' · ' + allRows.length + ' team' + (allRows.length === 1 ? '' : 's'),
                  deltaFmt(kpi.totalDeals, prevKpi && prevKpi.totalDeals, '', false))}
      </div>

      <div class="card mt card-pad">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
          <div style="font-family:var(--serif);font-size:14px;font-weight:700;color:var(--ink);text-transform:uppercase;letter-spacing:.04em">Needs attention</div>
          <div class="sub">Top 3 worst stale ratios in ${escapeHtml(groupNames[_hubspotGroup])} (≥ 5 deals, ≥ 30% stale)</div>
        </div>
        <div class="t3-grid">${top3Html}</div>
      </div>

      <div class="card mt card-pad" style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between">
        <div class="chips">${filterChips}</div>
        <label style="display:inline-flex;gap:6px;align-items:center;font-size:12.5px;color:var(--slate);cursor:pointer">
          <input id="hsShowEmpty" type="checkbox" ${_hubspotShowEmpty ? 'checked' : ''}>
          Show ${emptyCount} teams with no deals
        </label>
      </div>

      <div class="card mt">
        <div class="tbl-wrap"><table class="tbl tbl-sortable">
          <thead><tr>
            ${teamHeader}
            ${totalHeader}
            ${HUBSPOT_COLS.map(c => headerCellForStage(c)).join('')}
            ${portalId ? `<th class="num" style="min-width:60px" title="Open this team's deals in HubSpot"></th>` : ''}
          </tr></thead>
          <tbody>
            ${allRows.length === 0 ? emptyRow : (visible.length === 0 ? noVisibleRow : visible.map(r => {
              const tot      = r._tot;
              const outdated = r.outdated ? r.outdated.outdated : null;
              const dim = r._tot === 0 ? ' style="opacity:.55"' : '';
              const link = hubspotLinkFor(r);
              return `<tr${dim}>
                <td style="${STK_TD}"><div class="agent-cell"><div class="agent-name">${escapeHtml(r.team || '—')}</div>${r._tot === 0 ? '<span class="pill" style="background:var(--paper);color:var(--muted);font-size:10px;margin-left:6px">No deals</span>' : ''}</div></td>
                <td class="num tnum">${fmt(tot)}</td>
                ${HUBSPOT_COLS.map(c => {
                  if (c.k === 'pctUpdated') return pctCell(r.outdated ? r.outdated[c.k] : null);
                  if (c.k === 'outdated')   return outdatedCell(outdated, tot);
                  if (c.isStage) {
                    const o = r.outdated ? r.outdated[c.k] : null;
                    const t = r.total    ? r.total[c.k]    : null;
                    return stageCell(o, t);
                  }
                  return `<td class="num tnum">${fmtCell(r.outdated ? r.outdated[c.k] : null, c.isPct)}</td>`;
                }).join('')}
                ${portalId ? `<td class="num">${link ? `<a class="row-go" href="${link}" target="_blank" rel="noopener" title="Open in HubSpot" aria-label="Open ${escapeHtml(r.team || '')} deals in HubSpot">↗</a>` : '<span class="muted">—</span>'}</td>` : ''}
              </tr>`;
            }).join(''))}
            ${visible.length > 0 ? `<tr style="background:#F7F8FC;font-weight:700">
              <td style="${STK_TOT}">Total · ${visible.length} team${visible.length === 1 ? '' : 's'}</td>
              <td class="num tnum">${fmt(visible.reduce((s, r) => s + r._tot, 0))}</td>
              ${HUBSPOT_COLS.map(c => {
                if (c.isPct) return `<td class="num"><span class="muted">—</span></td>`;
                if (c.isStage) {
                  const oSum = visible.reduce((s, r) => s + _num(r.outdated && r.outdated[c.k]), 0);
                  const tSum = visible.reduce((s, r) => s + _num(r.total && r.total[c.k]), 0);
                  return `<td class="num tnum">${_fmtK(oSum)}<span class="cell-slash">/</span>${_fmtK(tSum)}</td>`;
                }
                return `<td class="num tnum">${fmt(sumCol(c.k))}</td>`;
              }).join('')}
              ${portalId ? '<td></td>' : ''}
            </tr>` : ''}
          </tbody>
        </table></div>
        ${hiddenByFil > 0 && _hubspotFilter !== 'all' ? `<div class="muted" style="font-size:12.5px;padding:10px 16px 14px">${hiddenByFil} additional team${hiddenByFil === 1 ? '' : 's'} hidden by the current filter.</div>` : ''}
      </div>
    </div>`;
  }

  function wireHubspot() {
    document.querySelectorAll('#hsGroupSeg button[data-hs-group]').forEach(b => {
      b.addEventListener('click', () => {
        _hubspotGroup = b.dataset.hsGroup;
        render();
      });
    });
    document.querySelectorAll('button[data-hs-filter]').forEach(b => {
      b.addEventListener('click', () => {
        _hubspotFilter = b.dataset.hsFilter;
        render();
      });
    });
    const showEmpty = document.getElementById('hsShowEmpty');
    if (showEmpty) showEmpty.addEventListener('change', (e) => {
      _hubspotShowEmpty = !!e.target.checked;
      render();
    });
    document.querySelectorAll('th[data-hs-sort]').forEach(th => {
      th.style.cursor = 'pointer';
      th.addEventListener('click', () => {
        const k = th.dataset.hsSort;
        if (_hubspotSortBy === k) {
          _hubspotSortDir = _hubspotSortDir === 'asc' ? 'desc' : 'asc';
        } else {
          _hubspotSortBy = k;
          // First sort on a stage / pct column = "worst first"
          // (ascending pctUpdated, descending raw counts).
          _hubspotSortDir = (k === 'pctUpdated' || k === 'team') ? 'asc' : 'desc';
        }
        render();
      });
    });
  }

  // ─── Boot ────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', render);
})();
