// build-locations.js
// Usage: node build-locations.js
// Reads your local CSV, geocodes each location, writes locations.json
//
// Requirements: Node 18+ (uses built-in fetch)
// If on Node < 18: npm install node-fetch and uncomment the import below
//
// import fetch from "node-fetch";

const fs   = require("fs");
const path = require("path");

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────

// Put your CSV filename here (must be in the same folder as this script)
const CSV_FILENAME = "Dynacare Workplace HP's-SK AB  ON BC_Feb2026.xlsx - Workplace-Wellness Training.csv";

// Output file
const OUT_PATH = "./locations.json";

// Nominatim rate limit — must stay at 1 req/sec per their usage policy
const DELAY_MS = 1100;

// Coordinates Nominatim returns when it can't find something
// (known bad fallback for Canada — reject these)
const BAD_COORDS = [
  { lat: 49.0004149, lng: -112.7880266 },
  { lat: 56.1303673, lng: -106.3467712 }, // center of Canada fallback
];

// ─────────────────────────────────────────────
// PROVINCE NORMALIZATION
// ─────────────────────────────────────────────

const PROV_MAP = {
  "ON": "Ontario",
  "BC": "British Columbia",
  "AB": "Alberta",
  "SK": "Saskatchewan",
  "MB": "Manitoba",
  "QC": "Quebec",
  "NS": "Nova Scotia",
  "NB": "New Brunswick",
  "NL": "Newfoundland and Labrador",
  "PE": "Prince Edward Island",
  "NT": "Northwest Territories",
  "NU": "Nunavut",
  "YT": "Yukon",
  // Handle messy real-world values
  "aB":    "Alberta",
  "ab":    "Alberta",
  "AB & SK": "Alberta",
  "BC ":   "British Columbia",
};

function normalizeProvince(raw) {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (PROV_MAP[trimmed]) return PROV_MAP[trimmed];
  if (PROV_MAP[trimmed.toUpperCase()]) return PROV_MAP[trimmed.toUpperCase()];
  return trimmed;
}

function normalizePostal(raw) {
  const compact = raw.replace(/\s+/g, "").toUpperCase();
  if (/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(compact)) {
    return compact.slice(0, 3) + " " + compact.slice(3);
  }
  return raw.trim();
}

// ─────────────────────────────────────────────
// CSV PARSER
// Handles quoted fields, BOM, blank rows, messy whitespace
// ─────────────────────────────────────────────

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function parseCSV(raw) {
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines.length < 2) return [];

  const header = parseCSVLine(lines[0]).map(h => h.toLowerCase());

  const cityIdx   = header.findIndex(h => h.includes("city"));
  const postalIdx = header.findIndex(h => h.includes("postal"));
  const provIdx   = header.findIndex(h => h.includes("prov"));

  if (cityIdx === -1 || postalIdx === -1) {
    console.error("ERROR: Could not find 'City' or 'HP Postal Code' columns.");
    console.error("Found headers:", header);
    process.exit(1);
  }

  const seen = new Set();
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const city   = (cols[cityIdx]   || "").trim();
    const postal = normalizePostal((cols[postalIdx] || "").trim());
    const prov   = (cols[provIdx]   || "").trim();

    // Skip blank rows
    if (!city || !postal) continue;

    // Deduplicate by city name
    const key = city.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);

    rows.push({ city, postal, prov });
  }

  return rows;
}

// ─────────────────────────────────────────────
// GEOCODING
// ─────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isBadCoord(lat, lng) {
  return BAD_COORDS.some(c =>
    Math.abs(lat - c.lat) < 0.01 && Math.abs(lng - c.lng) < 0.01
  );
}

async function nominatimSearch(query) {
  const url = "https://nominatim.openstreetmap.org/search?" + new URLSearchParams({
    q: query,
    format: "json",
    limit: "1",
    countrycodes: "ca",
  });

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "NiaHealthLocationBuilder/1.0 (internal tool)" }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.length) return null;

    const lat = parseFloat(data[0].lat);
    const lng = parseFloat(data[0].lon);
    if (isBadCoord(lat, lng)) return null;

    return { lat, lng };
  } catch {
    return null;
  }
}

async function geocode(city, postal, province) {
  const provExpanded = normalizeProvince(province);

  // Try strategies in order, most reliable first
  // Each attempt respects the rate limit delay
  const strategies = [
    `${city}, ${provExpanded}, Canada`,
    `${city}, ${province}, Canada`,
    `${postal}, ${city}, Canada`,
    `${postal}, Canada`,
    `${postal.slice(0, 3)}, Canada`,     // FSA (first 3 chars) only
    `${city}, Canada`,
  ];

  // Remove duplicate strategies
  const unique = [...new Set(strategies.filter(Boolean))];

  for (let i = 0; i < unique.length; i++) {
    if (i > 0) await sleep(DELAY_MS);
    const coords = await nominatimSearch(unique[i]);
    if (coords) return { coords, strategy: unique[i] };
  }

  return null;
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────

async function main() {
  const csvPath = path.join(__dirname, CSV_FILENAME);

  if (!fs.existsSync(csvPath)) {
    console.error(`ERROR: Could not find ${CSV_FILENAME} in this folder.`);
    console.error(`Make sure your CSV file is named "${CSV_FILENAME}" and is in the same directory as this script.`);
    process.exit(1);
  }

  const raw  = fs.readFileSync(csvPath, "utf-8");
  const rows = parseCSV(raw);

  console.log(`\nFound ${rows.length} unique locations to geocode.\n`);
  console.log("This will take approximately", Math.ceil(rows.length * DELAY_MS / 1000 / 60), "minutes.\n");

  const locations = [];
  const failed    = [];

  for (let i = 0; i < rows.length; i++) {
    const { city, postal, prov } = rows[i];
    const label = `[${i + 1}/${rows.length}] ${city}, ${postal}, ${prov}`;

    process.stdout.write(`${label}...`);

    const result = await geocode(city, postal, prov);

    if (result) {
      const { coords, strategy } = result;
      process.stdout.write(` ✓ ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)} (via "${strategy}")\n`);
      locations.push({
        name:       city,
        postalCode: postal,
        province:   prov,
        provinceExpanded: normalizeProvince(prov),
        lat:        coords.lat,
        lng:        coords.lng,
      });
    } else {
      process.stdout.write(` ✗ FAILED — skipping\n`);
      failed.push({ city, postal, prov });
    }

    // Always delay between rows to respect Nominatim rate limit
    if (i < rows.length - 1) await sleep(DELAY_MS);
  }

  // Write output
  fs.writeFileSync(OUT_PATH, JSON.stringify(locations, null, 2));

  // Summary
  console.log("\n─────────────────────────────────────");
  console.log(`✓ Success: ${locations.length} locations written to ${OUT_PATH}`);

  if (failed.length > 0) {
    console.log(`✗ Failed:  ${failed.length} locations could not be geocoded:`);
    failed.forEach(f => console.log(`   - ${f.city}, ${f.postal}, ${f.prov}`));
    console.log("\nFor failed locations, try:");
    console.log("  1. Check spelling of the city name");
    console.log("  2. Verify the postal code is correct");
    console.log("  3. Add them manually to locations.json with approximate lat/lng from Google Maps");
  } else {
    console.log("All locations geocoded successfully.");
  }

  console.log("─────────────────────────────────────\n");
}

main().catch(err => {
  console.error("Unexpected error:", err);
  process.exit(1);
});