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
  const HUBSPOT_COLS = [
    { k: 'calling',    label: 'Calling',      tip: 'Calling leads' },
    { k: 'external',   label: 'External',     tip: 'External leads' },
    { k: 'inbound',    label: 'Inbound',      tip: 'Inbound leads' },
    { k: 'reconv',     label: 'Reconv',       tip: 'Reconverted leads' },
    { k: 'rental',     label: 'Rental',       tip: 'Rental leads' },
    { k: 'nurture',    label: 'Nurture',      tip: 'Leads to nurture' },
    { k: 'warm',       label: 'Warm',         tip: 'Warm leads' },
    { k: 'hot',        label: 'Hot',          tip: 'Hot leads' },
    { k: 'outdated',   label: 'Outdated',     tip: 'Total outdated leads' },
    { k: 'upToHot',    label: 'Up to Hot',    tip: 'HubSpot leads up to hot' },
    { k: 'pctUpdated', label: '% Updated',    tip: '% of leads updated', isPct: true },
    { k: 'aveLogged',  label: 'Avg Logged',   tip: 'Avg logged calls per day' },
    { k: 'aveAns',     label: 'Avg Answered', tip: 'Avg answered calls per day' },
    { k: 'aveNA',      label: 'Avg NA',       tip: 'Avg no-answer calls per day' },
  ];

  let _hubspot = null;
  let _hubspotLoading = false;
  let _hubspotGroup = '1';

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
  }

  function renderHubspot() {
    if (_hubspot == null && !_hubspotLoading) loadHubspot();
    if (_hubspot == null) {
      return `<div class="tab-view"><div class="card card-pad" style="text-align:center;color:var(--muted);padding:60px 20px">Loading HubSpot figures…</div></div>`;
    }

    const groups     = (_hubspot.groups) || { '1': [], '2': [], '3': [] };
    const groupNames = (_hubspot.groupNames) || { '1': 'Group 1', '2': 'Group 2', '3': 'Group 3' };
    const rows       = groups[_hubspotGroup] || [];

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

    const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
    const totalDeals    = rows.reduce((s, r) => s + num(r.total && r.total.deals), 0);
    const totalOutdated = rows.reduce((s, r) => s + num(r.outdated && r.outdated.outdated), 0);
    const pctOutdated   = totalDeals > 0 ? (totalOutdated / totalDeals) * 100 : 0;
    const pctRows       = rows.filter(r => r.outdated && r.outdated.pctUpdated != null);
    const avgPctUpdated = pctRows.length
      ? (pctRows.reduce((s, r) => s + num(r.outdated.pctUpdated), 0) / pctRows.length) * 100
      : 0;

    const kpi = (icon, label, val, foot) => `<div class="card kpi">
      <div class="kpi-top"><div class="kpi-ic">${icon}</div></div>
      <div class="kpi-label">${escapeHtml(label)}</div>
      <div class="kpi-val tnum">${val}</div>
      <div class="kpi-foot">${escapeHtml(foot)}</div>
    </div>`;

    const segBtn = (k) => {
      const count = (groups[k] || []).length;
      const name  = groupNames[k] || ('Group ' + k);
      return `<button class="${k === _hubspotGroup ? 'active' : ''}" data-hs-group="${k}">
        ${escapeHtml(name)} <span class="muted" style="font-weight:500">· ${count} team${count === 1 ? '' : 's'}</span>
      </button>`;
    };

    const fmtCell = (v, isPct) => {
      if (v == null || v === '') return '<span class="muted">—</span>';
      if (isPct) return (Number(v) * 100).toFixed(1) + '%';
      const n = Number(v);
      return isFinite(n) ? n.toFixed(n % 1 === 0 ? 0 : 1) : escapeHtml(String(v));
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
      return `<td class="num"><span class="pill ${pctClass(frac)}">${(Number(frac) * 100).toFixed(1)}%</span></td>`;
    };
    const outdatedCell = (outdatedN, totalN) => {
      if (outdatedN == null) return '<td class="num"><span class="muted">—</span></td>';
      const cls = outdatedClass(Number(outdatedN), Number(totalN));
      if (!cls) return `<td class="num tnum">${fmt(Math.round(outdatedN))}</td>`;
      return `<td class="num"><span class="pill ${cls}" style="font-variant-numeric:tabular-nums">${fmt(Math.round(outdatedN))}</span></td>`;
    };
    const sumCol = (k) => rows.reduce((s, r) => s + num(r.outdated && r.outdated[k]), 0);

    const STK_TH  = 'position:sticky;left:0;z-index:2;background:var(--paper-2);box-shadow:1px 0 0 var(--line-2)';
    const STK_TD  = 'position:sticky;left:0;z-index:1;background:var(--card);box-shadow:1px 0 0 var(--line-2);white-space:nowrap';
    const STK_TOT = 'position:sticky;left:0;z-index:1;background:#F7F8FC;box-shadow:1px 0 0 var(--line-2)';

    const emptyRow = `<tr><td colspan="${HUBSPOT_COLS.length + 2}" class="muted" style="text-align:center;padding:36px 20px;line-height:1.55">
      No data yet — generate a HubSpot Private App token and run the<br>
      <code style="background:var(--paper);padding:2px 6px;border-radius:4px;font-size:12px">fetch-hubspot</code> workflow to populate this view.
    </td></tr>`;

    return `<div class="tab-view">
      <div class="card card-pad">
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
          <div class="seg" id="hsGroupSeg" style="flex-wrap:wrap">
            ${segBtn('1')}${segBtn('2')}${segBtn('3')}
          </div>
        </div>
        ${_hubspot.error ? `<div class="banner" style="margin-top:12px;background:var(--red-tint);color:var(--red);padding:8px 10px;border-radius:6px;font-size:12.5px">Data not loaded — ${escapeHtml(_hubspot.error)}. The GH Action will populate it on its next run.</div>` : ''}
      </div>

      <div class="row kpis mt">
        ${kpi(I.layers, 'Total Deals',     fmt(totalDeals),                  escapeHtml(groupNames[_hubspotGroup] || ('Group ' + _hubspotGroup)) + ' · ' + rows.length + ' team' + (rows.length === 1 ? '' : 's'))}
        ${kpi(I.alert,  'Outdated Leads',  fmt(totalOutdated),               'sum of stale leads across the group')}
        ${kpi(I.target, '% Outdated',      pctOutdated.toFixed(1) + '%',     'outdated ÷ total deals')}
        ${kpi(I.check,  'Avg % Updated',   avgPctUpdated.toFixed(1) + '%',   'mean across ' + pctRows.length + ' reporting team' + (pctRows.length === 1 ? '' : 's'))}
      </div>

      <div class="card mt">
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr>
            <th style="${STK_TH};min-width:180px;text-align:left">Team</th>
            <th class="num" style="min-width:74px" title="Total deals for this team">Total</th>
            ${HUBSPOT_COLS.map(c => `<th class="num" style="min-width:${c.k === 'pctUpdated' ? 96 : 78}px" title="${escapeHtml(c.tip)}">${escapeHtml(c.label)}</th>`).join('')}
          </tr></thead>
          <tbody>
            ${rows.length === 0 ? emptyRow : rows.map(r => {
              const tot      = num(r.total && r.total.deals);
              const outdated = r.outdated ? r.outdated.outdated : null;
              return `<tr>
                <td style="${STK_TD}"><div class="agent-cell"><div class="agent-name">${escapeHtml(r.team || '—')}</div></div></td>
                <td class="num tnum">${fmt(tot)}</td>
                ${HUBSPOT_COLS.map(c => {
                  if (c.k === 'pctUpdated') return pctCell(r.outdated ? r.outdated[c.k] : null);
                  if (c.k === 'outdated')   return outdatedCell(outdated, tot);
                  return `<td class="num tnum">${fmtCell(r.outdated ? r.outdated[c.k] : null, c.isPct)}</td>`;
                }).join('')}
              </tr>`;
            }).join('')}
            ${rows.length > 0 ? `<tr style="background:#F7F8FC;font-weight:700">
              <td style="${STK_TOT}">Total</td>
              <td class="num tnum">${fmt(totalDeals)}</td>
              ${HUBSPOT_COLS.map(c => {
                if (c.isPct) return `<td class="num"><span class="muted">—</span></td>`;
                return `<td class="num tnum">${fmt(sumCol(c.k))}</td>`;
              }).join('')}
            </tr>` : ''}
          </tbody>
        </table></div>
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
  }

  // ─── Boot ────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', render);
})();
