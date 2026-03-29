"""
scrape_lifelabs_bc.py — One-shot scraper for ALL LifeLabs in-clinic BC locations

WHAT IT DOES:
  1. Hits the LifeLabs appointment API with 48 hub coordinates across BC
  2. Deduplicates locations by site ID
  3. Saves to CSV (./lifelabs_bc.csv)
  4. Generates an HTML verification map (./lifelabs_bc_map.html) you can open in any browser

BEFORE RUNNING — you need a fresh session cookie:
  1. Open https://appointments.lifelabs.com/locationfinder?province=bc in your browser
  2. Open DevTools (F12) → Network tab
  3. Let the page load (or click a location)
  4. Find ANY request to pwt-api.lifelabs.com
  5. Right-click → Copy as cURL, or just grab the "cookie" header value
  6. Paste it below where it says PASTE_YOUR_FRESH_COOKIE_HERE

INSTALL:
  pip install requests folium

RUN:
  python scrape_lifelabs_bc.py

OUTPUT (saved to the same folder you run the script from):
  ./lifelabs_bc.csv          ← all locations with lat/lng
  ./lifelabs_bc_map.html     ← open in browser to verify pins
"""

import requests
import csv
import time
import urllib.parse
import os
import sys

# ═══════════════════════════════════════════════════════════════════
# CONFIG — UPDATE THE COOKIE BEFORE RUNNING
# ═══════════════════════════════════════════════════════════════════

COOKIE = "PASTE_YOUR_FRESH_COOKIE_HERE"

API_URL = "https://pwt-api.lifelabs.com/api/locations"

HEADERS = {
    "accept": "*/*",
    "accept-language": "en-US,en;q=0.5",
    "content-type": "application/json",
    "origin": "https://appointments.lifelabs.com",
    "referer": "https://appointments.lifelabs.com/",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
    "cookie": COOKIE,
}

# Output files (saved in the current working directory)
OUTPUT_DIR = os.path.dirname(os.path.abspath(__file__))
CSV_FILE   = os.path.join(OUTPUT_DIR, "lifelabs_bc.csv")
MAP_FILE   = os.path.join(OUTPUT_DIR, "lifelabs_bc_map.html")


# ═══════════════════════════════════════════════════════════════════
# 48 HUB COORDINATES — covers every region of BC
# ═══════════════════════════════════════════════════════════════════

BC_HUBS = {
    # ── Lower Mainland & Fraser Valley ──
    "Vancouver":       [49.2827, -123.1207],
    "Surrey":          [49.1913, -122.8490],
    "Burnaby":         [49.2488, -122.9805],
    "Coquitlam":       [49.2838, -122.7932],
    "Langley":         [49.1042, -122.6604],
    "Abbotsford":      [49.0504, -122.3045],
    "Maple Ridge":     [49.2193, -122.5984],
    "Chilliwack":      [49.1579, -121.9514],
    "White Rock":      [49.0253, -122.8026],
    "Mission":         [49.1337, -122.3115],
    "Hope":            [49.3810, -121.4419],
    "Squamish":        [49.7016, -123.1558],

    # ── Vancouver Island ──
    "Victoria":        [48.4284, -123.3656],
    "Nanaimo":         [49.1659, -123.9401],
    "Duncan":          [48.7787, -123.7079],
    "Parksville":      [49.3192, -124.3159],
    "Campbell River":  [50.0244, -125.2442],
    "Courtenay":       [49.6912, -124.9936],
    "Sidney":          [48.6506, -123.3986],
    "Powell River":    [49.8353, -124.5247],
    "Port Alberni":    [49.2339, -124.8055],

    # ── Okanagan ──
    "Kelowna":         [49.8880, -119.4960],
    "Penticton":       [49.4991, -119.5937],
    "Vernon":          [50.2671, -119.2720],
    "Salmon Arm":      [50.7024, -119.2722],
    "Oliver":          [49.1828, -119.5506],

    # ── Interior / Thompson ──
    "Kamloops":        [50.6745, -120.3273],
    "Merritt":         [50.1113, -120.7862],
    "Clearwater":      [51.6501, -120.0377],
    "Revelstoke":      [50.9981, -118.1957],

    # ── Kootenays ──
    "Cranbrook":       [49.5097, -115.7688],
    "Nelson":          [49.4928, -117.2948],
    "Trail":           [49.0966, -117.7108],
    "Invermere":       [50.5065, -116.0297],
    "Golden":          [51.2973, -116.9675],
    "Fernie":          [49.5040, -115.0628],
    "Castlegar":       [49.3256, -117.6662],

    # ── Cariboo ──
    "Williams Lake":   [52.1417, -122.1417],
    "Quesnel":         [52.9784, -122.4927],
    "100 Mile House":  [51.6419, -121.2930],

    # ── Northern BC ──
    "Prince George":   [53.9171, -122.7497],
    "Vanderhoof":      [54.0166, -124.0000],
    "Burns Lake":      [54.2301, -125.7600],

    # ── Northwest ──
    "Terrace":         [54.5182, -128.5965],
    "Kitimat":         [54.0523, -128.6534],
    "Prince Rupert":   [54.3150, -130.3208],
    "Smithers":        [54.7804, -127.1743],

    # ── Peace / Northeast ──
    "Fort St. John":   [56.2465, -120.8476],
    "Dawson Creek":    [55.7596, -120.2353],
    "Fort Nelson":     [58.8050, -122.6970],
}


# ═══════════════════════════════════════════════════════════════════
# STEP 1: SCRAPE
# ═══════════════════════════════════════════════════════════════════

def scrape_all():
    """Sweep all BC hubs and collect unique locations."""
    all_locations = {}

    print("=" * 60)
    print("STEP 1: SCRAPING LIFELABS API")
    print("=" * 60)

    for city, coords in BC_HUBS.items():
        print(f"\n🚀 {city}...", end="", flush=True)
        offset = 1

        while True:
            payload = {"address": coords, "limit": 100, "offset": offset}

            try:
                resp = requests.post(API_URL, headers=HEADERS, json=payload, timeout=15)
            except requests.RequestException as e:
                print(f" ❌ request error: {e}")
                break

            if resp.status_code == 403:
                print(f"\n\n❌ 403 FORBIDDEN — your cookie has expired!")
                print(f"   1. Go to: https://appointments.lifelabs.com/locationfinder?province=bc")
                print(f"   2. Open DevTools → Network → find request to pwt-api.lifelabs.com")
                print(f"   3. Copy the 'cookie' header value")
                print(f"   4. Paste it into COOKIE at the top of this script")
                print(f"   5. Run again\n")
                if all_locations:
                    print(f"   (Saving {len(all_locations)} locations collected so far...)")
                    return list(all_locations.values())
                sys.exit(1)

            if resp.status_code != 200:
                print(f" ❌ HTTP {resp.status_code}")
                break

            data = resp.json().get("locations", [])
            if not data:
                break

            new = 0
            for loc in data:
                loc_id = loc.get("siteIdGuid") or loc.get("siteId")
                if loc_id and loc_id not in all_locations:
                    all_locations[loc_id] = loc
                    new += 1

            print(f" +{new} (total: {len(all_locations)})", end="", flush=True)

            if len(data) < 100:
                break
            offset += 100
            time.sleep(0.5)

        time.sleep(0.3)

    print(f"\n\n✅ Scraped {len(all_locations)} unique locations across {len(BC_HUBS)} hubs")
    return list(all_locations.values())


# ═══════════════════════════════════════════════════════════════════
# STEP 2: PARSE & SAVE CSV
# ═══════════════════════════════════════════════════════════════════

def parse_and_save(raw_locations):
    """Extract clean fields from raw API data and save to CSV."""

    print("\n" + "=" * 60)
    print("STEP 2: PARSING & SAVING CSV")
    print("=" * 60)

    rows = []
    skipped = 0

    for loc in raw_locations:
        addr = loc.get("address", {})

        # 1. Try standard address field
        street = addr.get("address1", "")

        # 2. Fallback: extract from Apple Maps URL
        if not street and addr.get("mapAddress"):
            try:
                map_url = addr["mapAddress"]
                if "q=" in map_url:
                    raw_q = map_url.split("q=")[1].split("&")[0].split(",")[0]
                    street = urllib.parse.unquote_plus(raw_q)
            except Exception:
                pass

        if street:
            street = street.strip()

        # Skip locations without a real street address
        if not street:
            skipped += 1
            continue

        lat = loc.get("latitude") or loc.get("lat") or addr.get("latitude", "")
        lng = loc.get("longitude") or loc.get("lng") or addr.get("longitude", "")

        rows.append({
            "id":       loc.get("siteId", ""),
            "name":     loc.get("siteName", "").replace("PSC", "Patient Service Centre").strip(),
            "address":  street,
            "city":     addr.get("city", ""),
            "province": addr.get("province", "BC"),
            "postal":   addr.get("postalCode", ""),
            "lat":      lat,
            "lng":      lng,
            "phone":    loc.get("phone", ""),
        })

    if not rows:
        print("❌ No valid locations with addresses found!")
        return []

    # Sort by city then name
    rows.sort(key=lambda r: (r["city"], r["name"]))

    with open(CSV_FILE, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)

    cities = sorted(set(r["city"] for r in rows if r["city"]))
    no_coords = sum(1 for r in rows if not r["lat"] or not r["lng"])

    print(f"\n💾 Saved {len(rows)} locations → {CSV_FILE}")
    if skipped:
        print(f"   ⚠️  Skipped {skipped} entries with no street address")
    if no_coords:
        print(f"   ⚠️  {no_coords} locations missing lat/lng coordinates")
    print(f"   📍 {len(cities)} cities: {', '.join(cities)}")

    return rows


# ═══════════════════════════════════════════════════════════════════
# STEP 3: GENERATE VERIFICATION MAP
# ═══════════════════════════════════════════════════════════════════

def generate_map(rows):
    """Create an HTML map with all locations pinned for visual verification."""

    print("\n" + "=" * 60)
    print("STEP 3: GENERATING VERIFICATION MAP")
    print("=" * 60)

    try:
        import folium
    except ImportError:
        print("   ⚠️  folium not installed — skipping map generation")
        print("   Run: pip install folium")
        print("   Then re-run this script, or just use the CSV\n")
        return

    # Center on BC
    m = folium.Map(location=[53.7, -127.6], zoom_start=6, tiles="CartoDB dark_matter")

    pinned = 0
    missing = []

    for row in rows:
        try:
            lat, lng = float(row["lat"]), float(row["lng"])
        except (ValueError, TypeError):
            missing.append(row["name"])
            continue

        popup_html = (
            f"<b>{row['name']}</b><br>"
            f"{row['address']}<br>"
            f"{row['city']}, {row['province']} {row['postal']}<br>"
            f"{row['phone']}"
        )

        folium.CircleMarker(
            location=[lat, lng],
            radius=6,
            color="#34d399",
            fill=True,
            fill_color="#34d399",
            fill_opacity=0.8,
            popup=folium.Popup(popup_html, max_width=250),
            tooltip=f"{row['name']} — {row['city']}",
        ).add_to(m)
        pinned += 1

    m.save(MAP_FILE)

    print(f"\n🗺️  Map saved → {MAP_FILE}")
    print(f"   ✅ {pinned} locations pinned on map")
    if missing:
        print(f"   ⚠️  {len(missing)} locations missing coordinates (not on map):")
        for name in missing:
            print(f"      - {name}")
    print(f"\n👉 Open {MAP_FILE} in your browser to verify all pins look correct")


# ═══════════════════════════════════════════════════════════════════
# STEP 4: SUMMARY
# ═══════════════════════════════════════════════════════════════════

def print_summary(rows):
    print("\n" + "=" * 60)
    print("DONE — SUMMARY")
    print("=" * 60)

    print(f"\n📁 Files saved to: {OUTPUT_DIR}")
    print(f"   📄 {os.path.basename(CSV_FILE)}     — {len(rows)} locations (open in Excel/Sheets)")
    if os.path.exists(MAP_FILE):
        print(f"   🗺️  {os.path.basename(MAP_FILE)} — verification map (open in browser)")

    print(f"\n📊 Coverage breakdown:")
    by_city = {}
    for r in rows:
        c = r["city"] or "Unknown"
        by_city[c] = by_city.get(c, 0) + 1

    for city, count in sorted(by_city.items(), key=lambda x: -x[1]):
        print(f"   {city}: {count}")

    print(f"\n🔍 To verify: open {os.path.basename(MAP_FILE)} in your browser and spot-check")
    print(f"   that pins match real LifeLabs locations on Google Maps.\n")


# ═══════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    if COOKIE == "PASTE_YOUR_FRESH_COOKIE_HERE":
        print("❌ You need to paste a fresh cookie first!")
        print()
        print("   1. Open: https://appointments.lifelabs.com/locationfinder?province=bc")
        print("   2. Open DevTools (F12) → Network tab")
        print("   3. Find any request to pwt-api.lifelabs.com")
        print("   4. Copy the 'cookie' header value")
        print("   5. Open this script and replace PASTE_YOUR_FRESH_COOKIE_HERE")
        print("   6. Run again")
        sys.exit(1)

    raw = scrape_all()
    rows = parse_and_save(raw)
    if rows:
        generate_map(rows)
        print_summary(rows)