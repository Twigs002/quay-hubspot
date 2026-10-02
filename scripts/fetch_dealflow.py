#!/usr/bin/env python3
"""Fetch Quay 1 Dealflow figures from the live Google Sheet and write the
aggregate JSON the Ryan Dashboard renders (data/dealflow_figures.json).

Source sheet: "Deaflow Raw Data" (the full 171-column financial export).
We read it read-only via the `va-sheets-bot` service account and roll every
deal up into overall / annual / month-on-month / per-division figures.

Decisions (locked with the user 2026-10-02):
  - Period date basis .......... acceptanceDate
  - Deal scope ................. ALL deals (no status filter)
  - Gross .... commissionExclVat ...... full commission excl VAT
  - Nett ..... totalGrossComm ......... "what we make excluding outside
               referral"  (= gross minus outsideRefCommExclVat)
  - Also surfaced: salesVolume (purchasePrice) + quay1 share (quay1GrossComm)

Auth: set GOOGLE_SERVICE_ACCOUNT_JSON (the key file contents) OR
GOOGLE_SERVICE_ACCOUNT_FILE (a path). The GitHub Action writes the repo
secret to a file and points the latter at it.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

import gspread

# ── Config ────────────────────────────────────────────────────────────────
SHEET_ID = os.environ.get(
    "DEALFLOW_SHEET_ID", "14ukm1oSCPHtCQUQPGBjbz-3-X1FK4z2EiAlnVtk0qUg"
)
TAB = os.environ.get("DEALFLOW_TAB", "Sheet1")

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "dealflow_figures.json"

# Header names we pull, mapped to the metric they feed. Lookup is by header
# name (not column letter) so a column re-order in the sheet never breaks us.
COL_DIVISION = "divisionName"
COL_DATE = "acceptanceDate"
COL_STATUS = "dealStatus"
COL_SALETYPE = "saleType"
COL_REGION = "region"
COL_PRICE = "purchasePrice"          # -> salesVolume
COL_GROSS = "commissionExclVat"      # -> gross
COL_NETT = "totalGrossComm"          # -> nett (gross minus outside referral)
COL_OUTREF = "outsideRefCommExclVat"  # transparency: gross - nett
COL_QUAY1 = "quay1GrossComm"         # -> quay1 share

REQUIRED = [COL_DIVISION, COL_DATE, COL_PRICE, COL_GROSS, COL_NETT]


# ── Auth ──────────────────────────────────────────────────────────────────
def _client() -> gspread.Client:
    raw = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if raw:
        return gspread.service_account_from_dict(json.loads(raw))
    path = os.environ.get("GOOGLE_SERVICE_ACCOUNT_FILE")
    if path:
        return gspread.service_account(filename=path)
    # Local-dev fallback: the shared key that lives beside the VA automations.
    fallback = (
        ROOT.parent / "virtual-agent-lookup" / "va-automation-497708-key.json"
    )
    if fallback.exists():
        return gspread.service_account(filename=str(fallback))
    sys.exit(
        "No Google service account configured. Set GOOGLE_SERVICE_ACCOUNT_JSON "
        "or GOOGLE_SERVICE_ACCOUNT_FILE."
    )


# ── Parsing helpers ───────────────────────────────────────────────────────
def num(v) -> float:
    """Money/number cell -> float. Blanks and junk -> 0.0."""
    if v is None:
        return 0.0
    s = str(v).strip().replace(",", "").replace("R", "").replace(" ", "")
    if not s:
        return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def parse_date(v) -> dt.date | None:
    """Accept the sheet's ISO-ish timestamps + a couple of common fallbacks."""
    if not v:
        return None
    s = str(v).strip()
    if not s:
        return None
    head = s[:10]
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%d/%m/%Y", "%d-%m-%Y"):
        try:
            return dt.datetime.strptime(head, fmt).date()
        except ValueError:
            continue
    return None


def blank_metrics() -> dict:
    return {
        "count": 0,
        "salesVolume": 0.0,
        "gross": 0.0,
        "nett": 0.0,
        "quay1": 0.0,
        "outsideRef": 0.0,
    }


def add(bucket: dict, row: dict) -> None:
    bucket["count"] += 1
    bucket["salesVolume"] += row["price"]
    bucket["gross"] += row["gross"]
    bucket["nett"] += row["nett"]
    bucket["quay1"] += row["quay1"]
    bucket["outsideRef"] += row["outref"]


def round_metrics(m: dict) -> dict:
    out = {"count": m["count"]}
    for k in ("salesVolume", "gross", "nett", "quay1", "outsideRef"):
        out[k] = round(m[k], 2)
    return out


# ── Main ──────────────────────────────────────────────────────────────────
def main() -> None:
    ws = _client().open_by_key(SHEET_ID).worksheet(TAB)
    rows = ws.get_all_values()
    if not rows:
        sys.exit("Sheet returned no rows.")

    header = [h.strip() for h in rows[0]]
    idx = {name: i for i, name in enumerate(header)}
    missing = [c for c in REQUIRED if c not in idx]
    if missing:
        sys.exit(f"Sheet is missing required columns: {missing}")

    def cell(r: list, name: str) -> str:
        i = idx.get(name, -1)
        return r[i] if 0 <= i < len(r) else ""

    overall = blank_metrics()
    undated = blank_metrics()
    by_year: dict[int, dict] = defaultdict(blank_metrics)
    by_month: dict[str, dict] = defaultdict(blank_metrics)
    # by_division_year[year][division]
    by_div_year: dict[int, dict[str, dict]] = defaultdict(
        lambda: defaultdict(blank_metrics)
    )
    by_status: dict[str, int] = defaultdict(int)

    gross_tot = nett_tot = outref_tot = 0.0

    for raw in rows[1:]:
        if not any(c.strip() for c in raw):
            continue
        row = {
            "division": (cell(raw, COL_DIVISION) or "Unassigned").strip()
            or "Unassigned",
            "price": num(cell(raw, COL_PRICE)),
            "gross": num(cell(raw, COL_GROSS)),
            "nett": num(cell(raw, COL_NETT)),
            "quay1": num(cell(raw, COL_QUAY1)),
            "outref": num(cell(raw, COL_OUTREF)),
        }
        status = (cell(raw, COL_STATUS) or "UNKNOWN").strip() or "UNKNOWN"
        by_status[status] += 1
        gross_tot += row["gross"]
        nett_tot += row["nett"]
        outref_tot += row["outref"]

        add(overall, row)
        d = parse_date(cell(raw, COL_DATE))
        if d is None:
            add(undated, row)
            continue
        add(by_year[d.year], row)
        add(by_month[f"{d.year:04d}-{d.month:02d}"], row)
        add(by_div_year[d.year][row["division"]], row)

    # Sanity-check the gross/nett relationship on real data (nett should be
    # gross minus the outside-referral portion). Logged, not fatal.
    diff = round(gross_tot - nett_tot - outref_tot, 2)
    print(
        f"[check] gross={gross_tot:,.2f}  nett={nett_tot:,.2f}  "
        f"outsideRef={outref_tot:,.2f}  (gross-nett-outsideRef={diff})"
    )

    # Continuous month series (fill gaps with zeros) for a clean line chart.
    months_sorted = sorted(by_month)
    month_series = []
    if months_sorted:
        first = dt.date(int(months_sorted[0][:4]), int(months_sorted[0][5:7]), 1)
        last = dt.date(int(months_sorted[-1][:4]), int(months_sorted[-1][5:7]), 1)
        cur = first
        while cur <= last:
            key = f"{cur.year:04d}-{cur.month:02d}"
            m = round_metrics(by_month.get(key, blank_metrics()))
            m["ym"] = key
            month_series.append(m)
            cur = (cur.replace(day=1) + dt.timedelta(days=32)).replace(day=1)

    year_series = []
    for y in sorted(by_year):
        m = round_metrics(by_year[y])
        m["year"] = y
        year_series.append(m)

    div_year = {}
    for y in sorted(by_div_year):
        divs = []
        for name, m in by_div_year[y].items():
            d = round_metrics(m)
            d["division"] = name
            divs.append(d)
        divs.sort(key=lambda x: x["nett"], reverse=True)
        div_year[str(y)] = divs

    payload = {
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(
            timespec="seconds"
        ),
        "source": "Dealflow Raw Data (Google Sheet)",
        "dateBasis": "acceptanceDate",
        "scope": "all deals",
        "metricDefs": {
            "salesVolume": "Sum of purchase prices (purchasePrice)",
            "gross": "Total commission excl VAT (commissionExclVat)",
            "nett": "What Quay 1 makes excluding outside referral "
            "(totalGrossComm)",
            "quay1": "Quay 1 share of commission (quay1GrossComm)",
            "outsideRef": "Commission paid to outside referrals "
            "(outsideRefCommExclVat)",
        },
        "overall": round_metrics(overall),
        "undated": round_metrics(undated),
        "byYear": year_series,
        "byMonth": month_series,
        "byDivisionYear": div_year,
        "statusCounts": dict(sorted(by_status.items(), key=lambda kv: -kv[1])),
        "placeholder": False,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2))
    print(
        f"[done] {overall['count']} deals -> {len(year_series)} years, "
        f"{len(month_series)} months. Wrote {OUT.relative_to(ROOT)}"
    )


if __name__ == "__main__":
    main()
