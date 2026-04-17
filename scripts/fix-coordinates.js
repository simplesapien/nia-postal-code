// fix-coordinates.js
// Copies nia-coverage-master.csv → nia-coverage-master.fixed.csv,
// re-geocodes rows with coordinates outside Canada, and validates results.
//
// Usage:
//   node scripts/fix-coordinates.js            # dry-run, prints what would change
//   node scripts/fix-coordinates.js --write     # writes the fixed copy
//
// After verifying the .fixed.csv looks good, swap it in:
//   mv data/nia-coverage-master.csv data/nia-coverage-master.bak.csv
//   mv data/nia-coverage-master.fixed.csv data/nia-coverage-master.csv
//   npm run rebuild

const fs   = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");

const DATA    = path.join(__dirname, "..", "data");
const SRC     = path.join(DATA, "nia-coverage-master.csv");
const DEST    = path.join(DATA, "nia-coverage-master.fixed.csv");
const COLUMNS = ["Section","Name","Address","City","Province","Postal Code",
                 "Latitude","Longitude","Type","Google Maps Link"];
const DELAY   = 1100;
const WRITE   = process.argv.includes("--write");

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isInCanada(lat, lng) {
  return lat >= 41.7 && lat <= 83.2 && lng >= -141.1 && lng <= -52.5;
}

async function nominatim(query) {
  const url = "https://nominatim.openstreetmap.org/search?" + new URLSearchParams({
    q: query, format: "json", limit: "1", countrycodes: "ca",
  });
  const res = await fetch(url, {
    headers: { "User-Agent": "nia-postal-geocoder/1.0 (fix-coordinates)" },
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.length) return null;
  const lat = parseFloat(data[0].lat);
  const lng = parseFloat(data[0].lon);
  if (!isInCanada(lat, lng)) return null;
  return { lat: lat.toFixed(6), lng: lng.toFixed(6) };
}

async function geocoderCa(locate) {
  const url = "https://geocoder.ca/?locate=" + encodeURIComponent(locate) + "&geoit=xml&json=1";
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error || !data.latt || !data.longt) return null;
    const lat = parseFloat(data.latt);
    const lng = parseFloat(data.longt);
    if (!isInCanada(lat, lng)) return null;
    return { lat: lat.toFixed(6), lng: lng.toFixed(6) };
  } catch { return null; }
}

function formatPostal(pc) {
  const c = pc.replace(/\s/g, "").toUpperCase();
  return c.length === 6 ? c.slice(0, 3) + " " + c.slice(3) : c;
}

async function geocodeRow(row) {
  const addr = (row["Address"] || "").trim();
  const city = (row["City"] || "").trim();
  const prov = (row["Province"] || "").trim();
  const pc   = (row["Postal Code"] || "").trim();
  const name = (row["Name"] || "").trim();

  // Try geocoder.ca first — better for Canadian postal codes
  if (pc) {
    const gc = await geocoderCa(formatPostal(pc));
    if (gc) return { ...gc, via: "geocoder.ca/postal" };
  }

  if (addr && city && prov) {
    await sleep(DELAY);
    const r = await nominatim(`${addr}, ${city}, ${prov}, Canada`);
    if (r) return { ...r, via: "nominatim/address" };
  }

  if (pc) {
    await sleep(DELAY);
    const r = await nominatim(`${formatPostal(pc)}, ${prov}, Canada`);
    if (r) return { ...r, via: "nominatim/postal" };
  }

  const place = city || name;
  if (place && prov) {
    await sleep(DELAY);
    const r = await nominatim(`${place}, ${prov}, Canada`);
    if (r) return { ...r, via: "nominatim/city" };
  }

  return null;
}

function writeCsv(rows) {
  const header = COLUMNS.join(",") + "\n";
  const body = rows.map(r => COLUMNS.map(c => {
    const v = (r[c] || "");
    return v.includes(",") || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(",")).join("\n") + "\n";
  fs.writeFileSync(DEST, header + body);
}

async function main() {
  const raw  = fs.readFileSync(SRC, "utf-8");
  const rows = parse(raw, { columns: true, skip_empty_lines: false, relax_column_count: true, bom: true });

  const bad = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const lat = parseFloat(r["Latitude"]);
    const lng = parseFloat(r["Longitude"]);
    if (!isNaN(lat) && !isNaN(lng) && !isInCanada(lat, lng)) {
      bad.push({ index: i, row: r, oldLat: lat, oldLng: lng });
    }
  }

  if (!bad.length) {
    console.log("All coordinates are within Canada — nothing to fix.");
    return;
  }

  console.log(`Found ${bad.length} row(s) with coordinates outside Canada.\n`);
  if (!WRITE) console.log("DRY RUN — pass --write to create the fixed CSV.\n");

  let fixed = 0, blanked = 0, failed = 0;

  for (const { index, row, oldLat, oldLng } of bad) {
    const label = [row["Name"], row["City"], row["Province"]].filter(Boolean).join(", ");
    process.stdout.write(`  ${label} (${oldLat}, ${oldLng}) → `);

    const result = await geocodeRow(row);

    if (result) {
      row["Latitude"]  = result.lat;
      row["Longitude"] = result.lng;
      row["Google Maps Link"] = `https://maps.google.com/?q=${result.lat},${result.lng}`;
      fixed++;
      console.log(`✓ (${result.lat}, ${result.lng}) via ${result.via}`);
    } else {
      row["Latitude"]  = "";
      row["Longitude"] = "";
      row["Google Maps Link"] = "";
      blanked++;
      console.log(`✗ blanked (geocoding failed, better than wrong)`);
    }

    await sleep(300);
  }

  console.log(`\n=== Summary ===`);
  console.log(`  Fixed:   ${fixed}`);
  console.log(`  Blanked: ${blanked} (could not geocode — will be skipped by frontend)`);
  console.log(`  Total:   ${bad.length}`);

  if (WRITE) {
    writeCsv(rows);
    console.log(`\nWritten → ${DEST}`);
    console.log(`\nNext steps:`);
    console.log(`  1. Eyeball data/nia-coverage-master.fixed.csv`);
    console.log(`  2. mv data/nia-coverage-master.csv data/nia-coverage-master.bak.csv`);
    console.log(`  3. mv data/nia-coverage-master.fixed.csv data/nia-coverage-master.csv`);
    console.log(`  4. npm run rebuild`);
  } else {
    console.log(`\nRe-run with --write to create ${path.basename(DEST)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
