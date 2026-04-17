#!/usr/bin/env python3
"""
Backfill latitude/longitude in nia-coverage-master.csv using OpenStreetMap/Nominatim.
Every row's result is printed to the terminal. Errors are shown inline.
"""

import csv
import os
import ssl
import sys
import time

import certifi

os.environ["SSL_CERT_FILE"] = certifi.where()
ssl._create_default_https_context = lambda: ssl.create_default_context(cafile=certifi.where())

try:
    from geopy.geocoders import Nominatim
    from geopy.exc import GeocoderTimedOut, GeocoderServiceError
except ImportError:
    print("ERROR: geopy is not installed. Run:  pip3 install geopy")
    sys.exit(1)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT    = os.path.join(SCRIPT_DIR, "..")
MASTER     = os.path.join(PROJECT, "data", "nia-coverage-master.csv")
COLUMNS    = ["Section","Name","Address","City","Province","Postal Code",
              "Latitude","Longitude","Type","Google Maps Link"]

RED    = "\033[91m"
GREEN  = "\033[92m"
YELLOW = "\033[93m"
CYAN   = "\033[96m"
RESET  = "\033[0m"

geocoder = Nominatim(user_agent="nia-postal-backfill/1.0", timeout=10)

def geocode_row(row):
    """Try to geocode a row. Returns (lat, lng) or None."""
    addr = row.get("Address", "").strip()
    city = row.get("City", "").strip()
    prov = row.get("Province", "").strip()
    pc   = row.get("Postal Code", "").strip()

    queries = []
    if addr and city and prov:
        queries.append(f"{addr}, {city}, {prov}, Canada")
    if pc:
        queries.append(f"{pc}, Canada")
    if city and prov:
        queries.append(f"{city}, {prov}, Canada")

    for q in queries:
        try:
            time.sleep(1.1)
            loc = geocoder.geocode(q)
            if loc:
                return (str(round(loc.latitude, 6)), str(round(loc.longitude, 6)))
        except GeocoderTimedOut:
            print(f"\n    {YELLOW}TIMEOUT: {q}{RESET}", end="")
        except GeocoderServiceError as e:
            print(f"\n    {RED}SERVICE ERROR: {q} → {e}{RESET}", end="")
        except Exception as e:
            print(f"\n    {RED}ERROR: {q} → {e}{RESET}", end="")

    return None


def save_csv(all_rows):
    """Write the full CSV to disk (called after every geocoded row)."""
    with open(MASTER, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=COLUMNS, extrasaction="ignore")
        writer.writeheader()
        for row in all_rows:
            cleaned = {k: row.get(k, "") for k in COLUMNS}
            writer.writerow(cleaned)


def main():
    if not os.path.exists(MASTER):
        print(f"{RED}ERROR: Master CSV not found at {MASTER}{RESET}")
        sys.exit(1)

    with open(MASTER, newline="") as f:
        all_rows = list(csv.DictReader(f))

    total_data = sum(1 for r in all_rows if (r.get("Type") or "").strip())
    need_coords = sum(1 for r in all_rows
                      if (r.get("Type") or "").strip()
                      and not ((r.get("Latitude") or "").strip() and (r.get("Longitude") or "").strip()))

    print(f"\n{'='*60}")
    print(f" Backfilling coordinates — {need_coords} rows to geocode out of {total_data}")
    print(f" Using: OpenStreetMap / Nominatim (free, ~1 req/sec)")
    print(f" Estimated time: ~{need_coords * 1.2 / 60:.0f} minutes")
    print(f" CSV is saved after EVERY row — watch it update live")
    print(f"{'='*60}\n")

    stats = {"already": 0, "geocoded": 0, "failed": 0, "skipped": 0}
    failed_rows = []
    count = 0

    for i, row in enumerate(all_rows):
        typ = (row.get("Type") or "").strip()
        if not typ:
            stats["skipped"] += 1
            continue

        count += 1
        name = row.get("Name", "").strip()
        city = row.get("City", "").strip()
        prov = row.get("Province", "").strip()
        lat  = (row.get("Latitude") or "").strip()
        lng  = (row.get("Longitude") or "").strip()
        label = f"{name}, {city} {prov}" if name else f"{city} {prov}"

        if lat and lng:
            stats["already"] += 1
            print(f"  [{count:>4}/{total_data}] {GREEN}DONE  {RESET} {label}")
            continue

        print(f"  [{count:>4}/{total_data}] {YELLOW}GEO   {RESET} {label} ...", end="", flush=True)
        coords = geocode_row(row)
        if coords:
            row["Latitude"]  = coords[0]
            row["Longitude"] = coords[1]
            row["Google Maps Link"] = f"https://maps.google.com/?q={coords[0]},{coords[1]}"
            stats["geocoded"] += 1
            save_csv(all_rows)
            print(f"  {GREEN}✓{RESET} ({coords[0]}, {coords[1]})")
        else:
            stats["failed"] += 1
            failed_rows.append(row)
            print(f"  {RED}✗ FAILED{RESET}")

    # Final save to make sure everything is flushed
    save_csv(all_rows)

    filled = stats["already"] + stats["geocoded"]
    print(f"\n{'='*60}")
    print(f" RESULTS")
    print(f"{'='*60}")
    print(f"  {GREEN}Already had coords : {stats['already']:>4}{RESET}")
    print(f"  {GREEN}Geocoded (new)     : {stats['geocoded']:>4}{RESET}")
    print(f"  {RED}Failed             : {stats['failed']:>4}{RESET}")
    print(f"  Skipped (non-data): {stats['skipped']:>4}")
    print(f"\n  Total with coords : {filled} / {total_data}")

    if failed_rows:
        print(f"\n{RED}{'─'*60}")
        print(f" FAILED ROWS (no coordinates found):")
        print(f"{'─'*60}{RESET}")
        for r in failed_rows:
            print(f"  {r.get('Section','')} | {r.get('Name','')} | {r.get('Address','')} | {r.get('City','')} {r.get('Province','')} | {r.get('Postal Code','')}")

    print(f"\n{'='*60}")
    print(f" Master CSV updated: {MASTER}")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    main()
