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
def run_discover():
    print(f"=== DISCOVER · sampling up to {MAX_DEALS or 50} deals ===", flush=True)
    cap = MAX_DEALS if MAX_DEALS > 0 else 50

    print("[1/3] listing deal properties …", flush=True)
    props = list_deal_properties()
    print(f"      -> {len(props)} property names found", flush=True)

    print("[2/3] fetching owners …", flush=True)
    owners = fetch_owners()
    print(f"      -> {len(owners)} owners", flush=True)

    print(f"[3/3] sampling deals (cap {cap}) with first ~100 properties …", flush=True)
    sample = []
    after = None
    page = 0
    while len(sample) < cap:
        page += 1
        data = fetch_deals_page(after=after, properties=props)
        results = data.get("results", [])
        sample.extend(results)
        print(f"      page {page} -> {len(results)} deals "
              f"(total {len(sample)})", flush=True)
        after = (data.get("paging") or {}).get("next", {}).get("after")
        if not after or not results:
            break
    sample = sample[:cap]

    # Derive a handful of useful summaries directly so we don't have to
    # eyeball every property.
    dealstages = sorted({(d.get("properties") or {}).get("dealstage")
                         for d in sample
                         if (d.get("properties") or {}).get("dealstage")})
    owner_names_in_sample = sorted({owners.get(str((d.get("properties") or {}).get("hubspot_owner_id")), {}).get("name", "")
                                    for d in sample
                                    if (d.get("properties") or {}).get("hubspot_owner_id")})
    owner_names_in_sample = [n for n in owner_names_in_sample if n]

    out = {
        "mode":          "discover",
        "fetched_at":    time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "throttle_ms":   int(THROTTLE_S * 1000),
        "deals_sampled": len(sample),
        "deal_property_names": props,
        "unique_dealstages_in_sample":   dealstages,
        "owner_count":   len(owners),
        "owner_sample":  {k: v for k, v in list(owners.items())[:30]},
        "owner_names_in_deal_sample":    owner_names_in_sample,
        "deals_first_5_raw":             sample[:5],
    }
    (ROOT / "hubspot_discovery.json").write_text(json.dumps(out, indent=2, default=str))
    print(f"\nWrote hubspot_discovery.json — {len(sample)} deals sampled, "
          f"{len(props)} properties listed", flush=True)


def run_aggregate():
    # Implemented after the discovery pass tells us which fields map to the
    # spreadsheet's columns. For now this is a guard so the daily action
    # can't accidentally overwrite the JSON before we've mapped the schema.
    print("AGGREGATE mode not yet enabled — run MODE=discover first, share "
          "hubspot_discovery.json with Claude to map the fields, then I'll "
          "wire this branch.", flush=True)
    sys.exit(0)


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
