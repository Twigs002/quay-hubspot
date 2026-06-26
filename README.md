# Quay 1 · HubSpot Insights

Standalone GitHub Pages dashboard for monitoring out-of-date deals across the team roster. Mirrors the per-team breakdown from the source `RAW DATA DEALS (In Use).xlsx` spreadsheet (Sheet1 / 2 / 3 → Canvassing / Auction & Cross-Functional / Whales & Specialty).

## Architecture

- Vanilla JS + a single `data/hubspot_outdated.json` file
- Daily GitHub Action (to be added) calls the HubSpot Private App API, aggregates per-team counts, commits the JSON
- No PII syncs through this surface — only aggregated counts per team

## Data shape

```json
{
  "generated": "2026-06-25T05:00:00Z",
  "groupNames": { "1": "Canvassing", "2": "...", "3": "..." },
  "groups": {
    "1": [
      {
        "team": "Amigos",
        "total":    { "deals": 425 },
        "outdated": {
          "calling": 0, "external": 1, "inbound": 1, "reconv": 0, "rental": 0,
          "nurture": 51, "warm": 4, "hot": 3,
          "outdated": 60, "upToHot": 425,
          "pctUpdated": 0.8588,
          "aveLogged": 16.29, "aveAns": 9.95, "aveNA": 6.33
        }
      }
    ]
  }
}
```

`total.deals` for each team is the sum of lead categories from the source "Total Deals" spreadsheet row.

## Next steps

1. Generate a HubSpot Private App token with `crm.objects.deals.read`, `crm.objects.contacts.read`, `crm.objects.calls.read` scopes
2. Add it as a repo secret named `HUBSPOT_TOKEN`
3. Build `.github/workflows/fetch-hubspot.yml` to call the API, aggregate, and commit

## Divisions directory

The Directory tab + team drill-down on the Deals tab are powered by `data/divisions.json`, generated from the Divisions Area Breakdown xlsx.

To refresh after a new export:

```bash
# Drop the new xlsx in ~/Downloads (or data/divisions_source.xlsx)
python3 scripts/parse_divisions.py
git add data/divisions.json && git commit -m "data: refresh divisions" && git push
```

The source xlsx is gitignored — only the parsed JSON is committed, so the repo doesn't bloat with binary spreadsheets on every re-export.
