# Quay 1 — Dealflow Figures ("Ryan Dashboard")

Standalone GitHub Pages dashboard of Quay 1 group sales & commission, live at
**https://twigs002.github.io/quay-hubspot/**. It replaced the old HubSpot
"Team Insights" view on this same URL.

## What it shows

- **Headline KPIs** — Nett commission, Gross commission, Sales volume, Deals
  (for the selected year, or all-time).
- **Annual figures** — gross vs nett commission per year (grouped bars + table).
- **Month on month** — gross + nett commission as lines, filterable by year.
- **By division** — per-division breakdown (deals, sales volume, gross, nett).

### Figure definitions (locked with the user)

| Figure | Source column | Meaning |
|--------|---------------|---------|
| Gross  | `commissionExclVat` | Total commission earned, excl VAT |
| Nett   | `totalGrossComm`    | What Quay 1 makes **excluding outside referral** |
| Sales volume | `purchasePrice` | Sum of purchase prices |
| Quay 1 share | `quay1GrossComm` | Quay 1's portion of the commission |

Periods are keyed on **`acceptanceDate`** and include **all deals** regardless
of status.

## Architecture

Vanilla JS (`index.html` + `styles.css` + `app.js`) reading `data/dealflow_figures.json`.
Access is gated by the shared Supabase PIN login (super/admin only — revenue
data is sensitive), same as quay-clock / quay-leads.

`scripts/fetch_dealflow.py` reads the Dealflow sheet via the `va-sheets-bot`
service account, rolls every deal up into overall / annual / monthly /
per-division figures, and writes `data/dealflow_figures.json`. The GitHub
Action `fetch-dealflow.yml` runs it **daily at 05:00 SAST (03:00 UTC)** and
commits the JSON so GH Pages serves fresh numbers each morning.

## Setup / operations

- **Secret:** `GOOGLE_SERVICE_ACCOUNT` — the `va-sheets-bot` key JSON (already set).
- **One-time access grant (required):** the source sheet is owned by
  `marthinus@quay1.co.za`. It must be shared **(reader)** with
  `va-sheets-bot@va-automation-497708.iam.gserviceaccount.com` for the
  scheduled job to read it. Until then the dashboard shows "Awaiting first
  data sync".
- **Manual refresh:** `gh workflow run fetch-dealflow.yml` (or the Actions tab).
- **Local run:** `GOOGLE_SERVICE_ACCOUNT_FILE=/path/to/key.json python scripts/fetch_dealflow.py`.
