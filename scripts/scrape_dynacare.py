"""
scrape_dynacare.py — One-shot scraper for all Dynacare in-clinic locations (Manitoba & Ontario)

WHAT IT DOES:
  1. Scrapes Dynacare's "All Locations" page (server-rendered HTML, no auth needed)
  2. Parses name, address, city, postal, phone from each location block
  3. Geocodes each address via Nominatim (free, no API key)
  4. Saves to CSV
  5. Generates an HTML verification map

NO COOKIE / API KEY NEEDED — Dynacare renders location data in the HTML.

INSTALL:
  pip install requests beautifulsoup4 folium

RUN:
  python scrape_dynacare.py

OUTPUT (saved to the same folder you run the script from):
  ./dynacare_manitoba.csv
  ./dynacare_ontario.csv
  ./dynacare_manitoba_map.html
  ./dynacare_ontario_map.html
"""

import requests
from bs4 import BeautifulSoup
import csv
import time
import re
import os
import sys

PROVINCES = {
    "Manitoba": {
        "url": "https://www.dynacare.ca/specialpages/secondarynav/find-a-location/all-locations.aspx?location=Manitoba",
        "abbr": "MB",
    },
    "Ontario": {
        "url": "https://www.dynacare.ca/specialpages/secondarynav/find-a-location/all-locations.aspx?location=Ontario",
        "abbr": "ON",
    },
}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.5",
}

OUTPUT_DIR = os.path.dirname(os.path.abspath(__file__))


def scrape_province(url, province_abbr, province_name):
    print(f"\n🔍 Fetching {province_name} page...")
    resp = requests.get(url, headers=HEADERS, timeout=30)
    if resp.status_code != 200:
        print(f"   ❌ HTTP {resp.status_code}")
        return []

    soup = BeautifulSoup(resp.text, "html.parser")
    locations = []
    items = soup.select("ol > li")
    if not items:
        detail_links = soup.find_all("a", string=re.compile(r"View Details", re.I))
        if detail_links:
            items = [link.find_parent("li") for link in detail_links if link.find_parent("li")]

    print(f"   Found {len(items)} raw list items")

    for item in items:
        text = item.get_text(separator="\n", strip=True)
        if "View Details" not in text and "Book Appointment" not in text:
            continue

        lines = [l.strip() for l in text.split("\n") if l.strip()]
        loc_id = ""
        for line in lines:
            if re.match(r'^\d{4,6}$', line):
                loc_id = line
                break

        skip_words = ["View Details","Check In Online","Book Appointment","Learn more",
                      "Net Check In","Dynacare","unavailable","weekdays","weekends",
                      "first hour","appointment","click below"]

        clean = []
        for line in lines:
            if re.match(r'^\d+\.?\d*\s*km$', line, re.I): continue
            if re.match(r'^\d{1,3}$', line): continue
            if line == loc_id: continue
            if any(w.lower() in line.lower() for w in skip_words): continue
            clean.append(line)

        name = address = city = postal = phone = ""
        for line in clean:
            if re.match(r'^T?\s*\d{3}[\.\-]\d{3}[\.\-]\d{4}$', line):
                phone = line.lstrip("T ").strip(); continue
            if re.match(r'^[A-Z]\d[A-Z][\-\s]?\d[A-Z]\d$', line, re.I):
                postal = line.upper().strip(); continue
            if line.strip().lower() in ("on","mb","ontario","manitoba"): continue
            if re.match(r'^[A-Za-z\s\.\-]+,\s*(ON|MB)$', line):
                city = re.sub(r',\s*(ON|MB)$', '', line).strip(); continue
            if not name: name = line; continue
            if not address: address = line; continue
            if not city: city = line; continue

        if name and (address or city):
            locations.append({"id":loc_id,"name":name,"address":address,
                              "city":city,"province":province_abbr,
                              "postal":postal,"phone":phone})

    print(f"   ✅ Parsed {len(locations)} locations")
    if not locations:
        print(f"   ⚠️  0 found — page structure may have changed. Check: {url}")
    return locations


def geocode(address, city, province, postal):
    queries = []
    if address and city: queries.append(f"{address}, {city}, {province}, Canada")
    if postal: queries.append(f"{postal.replace('-',' ')}, Canada")
    if city: queries.append(f"{city}, {province}, Canada")

    for q in queries:
        try:
            r = requests.get("https://nominatim.openstreetmap.org/search",
                params={"q":q,"format":"json","limit":"1","countrycodes":"ca"},
                headers={"User-Agent":"DynacareLocationScraper/1.0"}, timeout=10)
            if r.status_code == 200:
                data = r.json()
                if data: return float(data[0]["lat"]), float(data[0]["lon"])
        except Exception: pass
        time.sleep(1.1)
    return None, None


def save_csv(locations, filename):
    if not locations: return None
    filepath = os.path.join(OUTPUT_DIR, filename)
    fields = ["id","name","address","city","province","postal","lat","lng","phone"]
    with open(filepath, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(locations)
    cities = sorted(set(l["city"] for l in locations if l["city"]))
    no_coords = sum(1 for l in locations if not l.get("lat"))
    print(f"\n💾 Saved {len(locations)} locations → {filepath}")
    if no_coords: print(f"   ⚠️  {no_coords} missing coordinates")
    print(f"   📍 {len(cities)} cities: {', '.join(cities)}")
    return filepath


def generate_map(locations, filename):
    try: import folium
    except ImportError:
        print("   ⚠️  folium not installed — skipping map. Run: pip install folium")
        return
    if not locations: return
    filepath = os.path.join(OUTPUT_DIR, filename)
    lats = [l["lat"] for l in locations if l.get("lat")]
    lngs = [l["lng"] for l in locations if l.get("lng")]
    if not lats: return
    center = [sum(lats)/len(lats), sum(lngs)/len(lngs)]
    m = folium.Map(location=center, zoom_start=7, tiles="CartoDB dark_matter")
    pinned = 0
    for loc in locations:
        if not loc.get("lat") or not loc.get("lng"): continue
        popup = f"<b>{loc['name']}</b><br>{loc['address']}<br>{loc['city']}, {loc['province']} {loc['postal']}<br>{loc['phone']}"
        folium.CircleMarker(location=[loc["lat"],loc["lng"]], radius=6,
            color="#60a5fa", fill=True, fill_color="#60a5fa", fill_opacity=0.8,
            popup=folium.Popup(popup, max_width=250),
            tooltip=f"{loc['name']} — {loc['city']}").add_to(m)
        pinned += 1
    m.save(filepath)
    print(f"🗺️  Map saved → {filepath} ({pinned} pins)")


def main():
    print("="*60)
    print("DYNACARE LOCATION SCRAPER — Manitoba & Ontario")
    print("="*60)
    print(f"Output directory: {OUTPUT_DIR}\n")

    for province_name, config in PROVINCES.items():
        print("\n" + "─"*60)
        print(f"  {province_name.upper()}")
        print("─"*60)

        locations = scrape_province(config["url"], config["abbr"], province_name)
        if not locations: continue

        total = len(locations)
        print(f"\n📍 Geocoding {total} locations (~1/sec)...")
        for i, loc in enumerate(locations):
            lat, lng = geocode(loc["address"], loc["city"], loc["province"], loc["postal"])
            loc["lat"] = lat or ""
            loc["lng"] = lng or ""
            icon = "✅" if lat else "⚠️ "
            print(f"   {icon} [{i+1}/{total}] {loc['name']}, {loc['city']} → {lat}, {lng}")

        save_csv(locations, f"dynacare_{province_name.lower()}.csv")
        generate_map(locations, f"dynacare_{province_name.lower()}_map.html")

    print("\n" + "="*60)
    print("DONE")
    print("="*60)
    print(f"\n📁 Files in: {OUTPUT_DIR}")
    print(f"🔍 Open the _map.html files in your browser to verify pins\n")


if __name__ == "__main__":
    main()