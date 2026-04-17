// geocode-missing.js
// Finds rows in nia-coverage-master.csv that have no lat/lng and geocodes them
// via Nominatim (free, no API key). Designed to run in GitHub Actions after
// pulling a fresh Sheet — only touches rows that need coords.

const fs   = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");

const CSV = path.join(__dirname, "..", "data", "nia-coverage-master.csv");
const COLUMNS = ["Section","Name","Address","City","Province","Postal Code",
                 "Latitude","Longitude","Type","Google Maps Link"];
const DELAY = 1100;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isInCanada(lat, lng) {
  return lat >= 41.7 && lat <= 83.2 && lng >= -141.1 && lng <= -52.5;
}

async function geocode(addr, city, prov, pc) {
  const queries = [];
  if (addr && city && prov) queries.push(`${addr}, ${city}, ${prov}, Canada`);
  if (pc) queries.push(`${pc}, Canada`);
  if (city && prov) queries.push(`${city}, ${prov}, Canada`);

  for (const q of queries) {
    await sleep(DELAY);
    try {
      const url = "https://nominatim.openstreetmap.org/search?" + new URLSearchParams({
        q, format: "json", limit: "1", countrycodes: "ca",
      });
      const res = await fetch(url, {
        headers: { "User-Agent": "nia-postal-geocoder/1.0 (GitHub Actions)" },
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.length) {
        const lat = parseFloat(data[0].lat);
        const lng = parseFloat(data[0].lon);
        if (!isInCanada(lat, lng)) {
          console.error(`  ⚠ Nominatim returned (${lat}, ${lng}) for "${q}" — outside Canada, skipping`);
          continue;
        }
        return { lat: lat.toFixed(6), lng: lng.toFixed(6) };
      }
    } catch (e) {
      console.error(`  ✗ Error geocoding "${q}": ${e.message}`);
    }
  }
  return null;
}

async function main() {
  const raw = fs.readFileSync(CSV, "utf-8");
  const rows = parse(raw, { columns: true, skip_empty_lines: false, relax_column_count: true, bom: true });

  const missing = rows.filter(r =>
    (r["Type"] || "").trim() &&
    (r["Name"] || "").trim() &&
    !((r["Latitude"] || "").trim() && (r["Longitude"] || "").trim())
  );

  if (!missing.length) {
    console.log("All rows have coordinates — nothing to geocode.");
    return;
  }

  console.log(`Geocoding ${missing.length} row(s) missing coordinates...\n`);
  let filled = 0, failed = 0;

  for (const row of missing) {
    const label = `${row["Name"]}, ${row["City"]} ${row["Province"]}`;
    process.stdout.write(`  ${label} ...`);

    const coords = await geocode(
      (row["Address"] || "").trim(),
      (row["City"] || "").trim(),
      (row["Province"] || "").trim(),
      (row["Postal Code"] || "").trim(),
    );

    if (coords) {
      row["Latitude"]  = coords.lat;
      row["Longitude"] = coords.lng;
      row["Google Maps Link"] = `https://maps.google.com/?q=${coords.lat},${coords.lng}`;
      filled++;
      console.log(` ✓ (${coords.lat}, ${coords.lng})`);
    } else {
      failed++;
      console.log(` ✗ FAILED`);
    }
  }

  const header = COLUMNS.join(",") + "\n";
  const body = rows.map(r => COLUMNS.map(c => {
    const v = (r[c] || "");
    return v.includes(",") || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(",")).join("\n") + "\n";

  fs.writeFileSync(CSV, header + body);
  console.log(`\nDone: ${filled} geocoded, ${failed} failed.`);
}

main().catch(e => { console.error(e); process.exit(1); });
