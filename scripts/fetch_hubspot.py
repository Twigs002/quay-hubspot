"""
HubSpot Out-of-Date Deals — fetcher
====================================

Modes:
  - `discover`   (default for first run) — pulls a small sample of deals
    with ALL properties so we can identify which custom fields drive
    the spreadsheet's columns. Uploads a JSON artifact, does NOT
    commit to data/hubspot_outdated.json.
  - `aggregate`  — pulls all deals, aggregates per team into the JSON
    shape consumed by index.html. Commits the result. Implemented
    after the discover step tells us which fields to read.

Rate-limit safety:
  - Default 350 ms sleep between API calls -> ~3 req/sec. HubSpot's
    burst limit is 100 req per 10s (10 req/sec sustained), so we run
    at ~30% of capacity by default — invisible to any other
    integration on the same portal.
  - On 429 we honour the `Retry-After` header and back off
    exponentially.
  - MAX_DEALS env caps total deals pulled so a test run never burns
    quota.

Inputs (env vars):
  HUBSPOT_TOKEN   — Private App token (required)
  MAX_DEALS       — int, 0 = unlimited, default 50 for test runs
  THROTTLE_MS     — int, ms to sleep between requests, default 350
  MODE            — 'discover' | 'aggregate' (default 'discover')
"""
import os
import json
import time
import sys
import pathlib
import requests

API = "https://api.hubapi.com"
ROOT = pathlib.Path(__file__).resolve().parent.parent

TOKEN       = os.environ.get("HUBSPOT_TOKEN", "").strip()
MAX_DEALS   = int(os.environ.get("MAX_DEALS") or "50")  # 0 = unlimited
THROTTLE_S  = max(50, int(os.environ.get("THROTTLE_MS") or "350")) / 1000.0
MODE        = (os.environ.get("MODE") or "discover").lower()

if not TOKEN:
    sys.exit("ERROR: HUBSPOT_TOKEN env var not set.")

sess = requests.Session()
sess.headers.update({
    "Authorization": f"Bearer {TOKEN}",
    "Content-Type":  "application/json",
})


# ---------------------------------------------------------------------------
# HTTP helpers with throttle + 429 back-off
# ---------------------------------------------------------------------------
def safe_get(url, params=None, max_retries=6):
    backoff = 1
    for attempt in range(max_retries):
        time.sleep(THROTTLE_S)
        try:
            r = sess.get(url, params=params, timeout=30)
        except requests.RequestException as e:
            print(f"  [net] retry {attempt+1}/{max_retries}: {e}", flush=True)
            time.sleep(backoff); backoff = min(60, backoff * 2)
            continue
        if r.status_code == 429:
            wait = int(r.headers.get("Retry-After", backoff))
            print(f"  [429] rolling-limit hit — sleeping {wait}s", flush=True)
            time.sleep(wait); backoff = min(60, backoff * 2)
            continue
        if r.status_code >= 500:
            print(f"  [{r.status_code}] retry {attempt+1}/{max_retries}", flush=True)
            time.sleep(backoff); backoff = min(60, backoff * 2)
            continue
        r.raise_for_status()
        return r.json()
    raise RuntimeError(f"too many retries: {url}")


# ---------------------------------------------------------------------------
# HubSpot endpoints
# ---------------------------------------------------------------------------
def list_deal_properties():
    """Return every property name on the Deal object — both standard and
    custom. Used by discover-mode to dump all properties so we can map
    the spreadsheet's column meaning to HubSpot fields."""
    data = safe_get(f"{API}/crm/v3/properties/deals")
    return [p.get("name") for p in data.get("results", []) if p.get("name")]


def fetch_pipelines():
    """Return all deal pipelines with their stages. Each pipeline is a
    {label, id, stages: [{label, id, displayOrder}]} dict — this is
    schema, not customer data, so safe to dump in full."""
    data = safe_get(f"{API}/crm/v3/pipelines/deals")
    out = []
    for pl in data.get("results", []):
        out.append({
            "id":     pl.get("id"),
            "label":  pl.get("label"),
            "stages": sorted(
                [
                    {
                        "id":           st.get("id"),
                        "label":        st.get("label"),
                        "displayOrder": st.get("displayOrder"),
                    }
                    for st in (pl.get("stages") or [])
                ],
                key=lambda s: s.get("displayOrder") or 0,
            ),
        })
    return out


def fetch_owners():
    """Map hubspot_owner_id -> display name + email. Owners are likely
    how teams are surfaced ("wombats wombats", "Bulls Bulls", etc.)."""
    out = {}
    after = None
    while True:
        params = {"limit": 100}
        if after:
            params["after"] = after
        data = safe_get(f"{API}/crm/v3/owners", params=params)
        for o in data.get("results", []):
            name = " ".join(filter(None, [o.get("firstName"), o.get("lastName")])).strip()
            out[str(o["id"])] = {
                "name":  name or o.get("email", "") or o["id"],
                "email": o.get("email", ""),
            }
        after = (data.get("paging") or {}).get("next", {}).get("after")
        if not after:
            break
    return out


def fetch_deals_page(after=None, properties=None):
    params = {"limit": 100}
    if properties:
        # HubSpot caps `properties` query length, so we request up to
        # 100 names per request — usually enough to cover everything.
        params["properties"] = ",".join(properties[:100])
    if after:
        params["after"] = after
    return safe_get(f"{API}/crm/v3/objects/deals", params=params)


# ---------------------------------------------------------------------------
# Modes
# ---------------------------------------------------------------------------
def _anonymise_owner_name(name):
    """Replace each word with a token of the same length so the *shape* of
    the name is visible (length, word count, casing) without leaking the
    actual identifier. Used so the schema-mapping step can confirm e.g.
    'two-word repeated team token' patterns without exposing real names."""
    if not name:
        return ""
    out = []
    for w in name.split():
        if w.isupper():
            out.append("X" * len(w))
        elif w[:1].isupper():
            out.append("X" + ("x" * (len(w) - 1)))
        else:
            out.append("x" * len(w))
    return " ".join(out)


def run_discover():
    """Schema-only discovery. The artifact written here intentionally contains
    NO raw CRM data — no deal records, no contact info, no monetary fields,
    no owner emails or IDs, no real owner names. Only metadata strings and
    counts so the dashboard's column-to-field mapping can be wired safely
    via the conversation."""
    print(f"=== DISCOVER · sampling up to {MAX_DEALS or 50} deals (schema only) ===", flush=True)
    cap = MAX_DEALS if MAX_DEALS > 0 else 50

    print("[1/3] listing deal properties …", flush=True)
    props = list_deal_properties()
    print(f"      -> {len(props)} property names found", flush=True)

    print("[2/3] fetching owners …", flush=True)
    owners = fetch_owners()
    print(f"      -> {len(owners)} owners", flush=True)

    print(f"[3/3] sampling deals (cap {cap}) for schema only …", flush=True)
    sample_props = []  # list of property dicts only — no record IDs
    after = None
    page = 0
    while len(sample_props) < cap:
        page += 1
        data = fetch_deals_page(after=after, properties=props)
        results = data.get("results", [])
        for d in results:
            sample_props.append(d.get("properties") or {})
        print(f"      page {page} -> {len(results)} deals "
              f"(total {len(sample_props)})", flush=True)
        after = (data.get("paging") or {}).get("next", {}).get("after")
        if not after or not results:
            break
    sample_props = sample_props[:cap]

    print("[3.5/3] fetching pipelines + stages …", flush=True)
    pipelines = fetch_pipelines()
    print(f"      -> {len(pipelines)} pipelines", flush=True)

    # Stage labels are metadata (pipeline definitions), not customer data.
    dealstages = sorted({p.get("dealstage") for p in sample_props if p.get("dealstage")})
    # Distinct pipeline / dealtype values seen in sample — both schema, not PII.
    pipelines_in_sample = sorted({p.get("pipeline") for p in sample_props if p.get("pipeline")})
    dealtypes_in_sample = sorted({p.get("dealtype") for p in sample_props if p.get("dealtype")})

    # Find any candidate "lead category" property — fields whose values look
    # like the spreadsheet's Calling/External/Inbound/Reconverted/Rental
    # categories. We only dump the *distinct value strings* (schema), never
    # individual deal contents.
    LEAD_HINTS = ("lead", "category", "type", "source", "status")
    candidate_lead_props = {}
    for key in props:
        if any(h in key.lower() for h in LEAD_HINTS):
            vals = sorted({str(p.get(key)) for p in sample_props if p.get(key)})
            if 1 <= len(vals) <= 30:  # categorical fields only
                candidate_lead_props[key] = vals[:30]

    # Anonymised owner-name pattern: lets me confirm the "two-word repeated
    # token" shape that the existing data hints at, without revealing real
    # names. Only 5 distinct shapes returned, max.
    owner_name_shapes = sorted({_anonymise_owner_name(o.get("name", ""))
                                for o in owners.values()
                                if o.get("name")})[:5]

    # Property-name suggestions for the standard fields we'll need by name.
    expected = {
        "dealstage":              "dealstage" in props,
        "hubspot_owner_id":       "hubspot_owner_id" in props,
        "hs_lastmodifieddate":    "hs_lastmodifieddate" in props,
        "createdate":             "createdate" in props,
        "closedate":              "closedate" in props,
        "hs_lastactivitydate":    "hs_lastactivitydate" in props,
    }

    out = {
        "mode":          "discover",
        "fetched_at":    time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "throttle_ms":   int(THROTTLE_S * 1000),
        # Schema-only counts
        "deals_sampled": len(sample_props),
        "owner_count":   len(owners),
        # Pure metadata: property name strings — no values
        "deal_property_names":         props,
        # Pipeline stage labels — schema, not customer data
        "unique_dealstages_in_sample": dealstages,
        "pipelines_in_sample":         pipelines_in_sample,
        "dealtypes_in_sample":         dealtypes_in_sample,
        # Full pipeline schema with stage labels
        "pipelines":                   pipelines,
        # Categorical custom-field candidates (distinct value labels only)
        "candidate_lead_props":        candidate_lead_props,
        # Anonymised owner-name shape patterns (5 max, no real names)
        "owner_name_shapes":           owner_name_shapes,
        # Yes/no checks for the standard properties we'll read
        "standard_properties_present": expected,
    }
    (ROOT / "hubspot_discovery.json").write_text(json.dumps(out, indent=2, default=str))
    print(f"\nWrote hubspot_discovery.json — {len(sample_props)} deals sampled, "
          f"{len(props)} properties listed (schema only, no raw CRM data).", flush=True)


import datetime as _dt

# Stage IDs → spreadsheet column key. Confirmed from the discover-mode
# pipelines fetch on 2026-06-25 — Sales Pipeline (id=default).
STAGE_TO_COL = {
    "contractsent": "calling",   # Calling Lead
    "22157097":     "external",  # External Lead
    "10990605":     "inbound",   # Inbound Lead
    "14369456":     "rental",    # Rental Lead
    "44489375":     "reconv",    # Reconverted Lead
    "7545337":      "nurture",   # Contacted - Lead to Nurture
    "10827872":     "warm",      # Contacted - Warm Lead (Courtesy)
    "7545338":      "hot",       # Contacted - Hot Lead
}
COL_KEYS = ["calling", "external", "inbound", "reconv", "rental",
            "nurture", "warm", "hot"]

OUTDATED_DAYS = int(os.environ.get("OUTDATED_DAYS") or "30")  # legacy; no longer used


def _build_owner_to_team(owners, teams_by_group):
    """Map HubSpot owner_id -> canonical team name. Owner display names
    in this portal are formatted '<TeamName> <TeamName>' (e.g. 'Bulls
    Bulls' or 'City Sunsets City Sunsets'). We match by substring against
    the canonical team list in data/hubspot_outdated.json, picking the
    longest match when an owner name contains multiple team strings
    (e.g. 'Sperm Whales Sperm Whales' should match 'Sperm Whales', not
    'Whales')."""
    canonical = []  # list of (team_name, group_id, lowercased_team)
    for gid, teams in teams_by_group.items():
        for t in teams:
            canonical.append((t["team"], gid, t["team"].lower()))
    # Sort by team-name length desc so the longest match wins.
    canonical.sort(key=lambda x: -len(x[2]))
    owner_to_team = {}
    unmatched_sample = []
    for oid, info in owners.items():
        nm = (info.get("name") or "").lower()
        if not nm:
            continue
        hit = None
        for team_name, gid, lc in canonical:
            if lc in nm:
                hit = (team_name, gid)
                break
        if hit:
            owner_to_team[str(oid)] = hit[0]
        elif len(unmatched_sample) < 5:
            unmatched_sample.append(info.get("name"))
    return owner_to_team, unmatched_sample


def _parse_iso(ts):
    if not ts:
        return None
    try:
        return _dt.datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except Exception:
        return None


def run_aggregate():
    json_path = ROOT / "data" / "hubspot_outdated.json"
    existing = json.loads(json_path.read_text())
    teams_by_group = existing.get("groups") or {}

    # Outdated rule: a deal is out-of-date if it has NO next activity date
    # scheduled, OR if its next activity date is in the past (today or
    # earlier in SAST). 'Today' is captured at UTC start-of-day for a
    # stable cutoff during the run.
    today_utc = _dt.datetime.now(_dt.timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0)

    print("=== AGGREGATE · outdated = no next-activity date OR next-activity < today ===", flush=True)
    print("[1/3] fetching owners …", flush=True)
    owners = fetch_owners()
    owner_to_team, unmatched = _build_owner_to_team(owners, teams_by_group)
    print(f"      -> {len(owners)} owners total, {len(owner_to_team)} matched to a roster team", flush=True)
    if unmatched:
        print(f"      sample of unmatched owner-name shapes: "
              f"{[_anonymise_owner_name(n) for n in unmatched]}", flush=True)

    print("[2/3] paginating deals …", flush=True)

    # team -> col_key -> { total, outdated }
    tallies = {}
    cap = MAX_DEALS if MAX_DEALS > 0 else None
    seen = 0
    skipped_no_team = 0
    skipped_other_stage = 0
    after = None
    page = 0
    while True:
        page += 1
        data = fetch_deals_page(after=after, properties=[
            "dealstage", "hubspot_owner_id",
            "notes_next_activity_date", "hs_next_activity_date",
        ])
        results = data.get("results", [])
        if not results:
            break
        for d in results:
            seen += 1
            p = d.get("properties") or {}
            col = STAGE_TO_COL.get(str(p.get("dealstage") or ""))
            if not col:
                skipped_other_stage += 1
                continue
            team = owner_to_team.get(str(p.get("hubspot_owner_id") or ""))
            if not team:
                skipped_no_team += 1
                continue
            # Try the standard "notes_next_activity_date" first; some portals
            # surface it as "hs_next_activity_date" instead — accept either.
            next_act = _parse_iso(p.get("notes_next_activity_date")
                                   or p.get("hs_next_activity_date"))
            is_outdated = (next_act is None) or (next_act < today_utc)
            tally = tallies.setdefault(team, {})
            cell  = tally.setdefault(col, {"total": 0, "outdated": 0})
            cell["total"] += 1
            if is_outdated:
                cell["outdated"] += 1
            if cap is not None and seen >= cap:
                break
        print(f"      page {page}: cumulative {seen} deals processed "
              f"({skipped_other_stage} non-funnel · {skipped_no_team} no-team)", flush=True)
        if cap is not None and seen >= cap:
            break
        after = (data.get("paging") or {}).get("next", {}).get("after")
        if not after:
            break

    print(f"[3/3] writing data/hubspot_outdated.json …", flush=True)
    new_groups = {}
    for gid, teams in teams_by_group.items():
        new_teams = []
        for t in teams:
            name = t["team"]
            tally = tallies.get(name, {})
            outdated_row = {}
            total_per_stage = {}
            sum_outdated = 0
            sum_total    = 0
            for col_key in COL_KEYS:
                cell = tally.get(col_key, {"total": 0, "outdated": 0})
                outdated_row[col_key]   = cell["outdated"]
                total_per_stage[col_key] = cell["total"]
                sum_outdated += cell["outdated"]
                sum_total    += cell["total"]
            outdated_row["outdated"]   = sum_outdated
            outdated_row["upToHot"]    = sum_total
            outdated_row["pctUpdated"] = (
                ((sum_total - sum_outdated) / sum_total) if sum_total > 0 else None
            )
            # aveLogged / aveAns / aveNA stay absent — Dialfire overlay later.
            new_teams.append({
                "team":     name,
                # `total.deals` is the headline total (sum across stages),
                # plus the per-stage totals so the dashboard can render
                # "outdated/total" cells (e.g. "3/10 warm").
                "total":    {"deals": sum_total, **total_per_stage},
                "outdated": outdated_row,
            })
        new_groups[gid] = new_teams

    existing["groups"]    = new_groups
    existing["generated"] = _dt.datetime.now(_dt.timezone.utc).isoformat()
    existing["source"]    = ("fetch_hubspot.py aggregate · "
                             "outdated = next_activity_date is null OR in the past · "
                             f"{seen} deals processed")
    json_path.write_text(json.dumps(existing, indent=2))

    rostered = sum(len(v) for v in teams_by_group.values())
    teams_with_data = sum(1 for t in tallies if any(v["total"] for v in tallies[t].values()))
    print(f"\nDone — {seen} deals processed, "
          f"{teams_with_data}/{rostered} roster teams ended up with at least one deal.", flush=True)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    print(f"mode={MODE} max_deals={MAX_DEALS} throttle={int(THROTTLE_S * 1000)}ms", flush=True)
    if MODE == "discover":
        run_discover()
    elif MODE == "aggregate":
        run_aggregate()
    else:
        sys.exit(f"ERROR: unknown MODE '{MODE}' (use 'discover' or 'aggregate')")


if __name__ == "__main__":
    main()
