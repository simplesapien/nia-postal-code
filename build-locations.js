const fs = require("fs");
const { parse } = require("csv-parse/sync");

const CSV_PATH = "./Dynacare Workplace HP's-SK AB  ON BC_Feb2026.xlsx - Workplace-Wellness Training.csv";
const OUT_PATH = "./locations.json";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const DELAY_MS = 1100;
const BAD_LAT = 49.0004149;
const BAD_LNG = -112.7880266;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isBadCoord(lat, lng) {
  return Math.abs(lat - BAD_LAT) < 0.001 && Math.abs(lng - BAD_LNG) < 0.01;
}

async function nominatimSearch(query) {
  const url = `${NOMINATIM_URL}?${new URLSearchParams({
    q: query,
    format: "json",
    limit: "1",
    countrycodes: "ca",
  })}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "PhlebotomistRangeChecker/1.0" },
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.length) return null;
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
}

async function geocode(postalCode, city, province) {
  // Try postal code + city + province first
  let coords = await nominatimSearch(`${postalCode}, ${city}, ${province}, Canada`);
  if (coords && !isBadCoord(coords.lat, coords.lng)) return coords;

  // Fall back to city + province (more reliable for many Canadian locations)
  await sleep(DELAY_MS);
  coords = await nominatimSearch(`${city}, ${province}, Canada`);
  if (coords && !isBadCoord(coords.lat, coords.lng)) return coords;

  // Last resort: just postal code
  await sleep(DELAY_MS);
  coords = await nominatimSearch(`${postalCode}, Canada`);
  if (coords && !isBadCoord(coords.lat, coords.lng)) return coords;

  return null;
}

const PROV_MAP = {
  ON: "Ontario",
  BC: "British Columbia",
  AB: "Alberta",
  SK: "Saskatchewan",
  "AB & SK": "Saskatchewan",
  aB: "Alberta",
};

async function main() {
  const raw = fs.readFileSync(CSV_PATH, "utf-8");
  const records = parse(raw, { columns: true, skip_empty_lines: true, trim: true });

  const rows = records.filter((r) => r["City"] && r["HP Postal Code"]);
  console.log(`Found ${rows.length} valid rows in CSV\n`);

  // Deduplicate by city name (keep first postal code per city)
  const seenCities = new Set();
  const uniqueRows = [];
  for (const row of rows) {
    const cityKey = row["City"].trim().toUpperCase();
    if (!seenCities.has(cityKey)) {
      seenCities.add(cityKey);
      uniqueRows.push(row);
    }
  }
  console.log(`${uniqueRows.length} unique cities after deduplication\n`);

  const locations = [];

  for (let i = 0; i < uniqueRows.length; i++) {
    const city = uniqueRows[i]["City"].trim();
    const postal = uniqueRows[i]["HP Postal Code"].trim().replace(/\s+/g, " ");
    const provRaw = (uniqueRows[i]["Prov."] || "").trim();
    const province = PROV_MAP[provRaw] || provRaw;

    console.log(`[${i + 1}/${uniqueRows.length}] ${city}, ${postal}, ${province}...`);

    const coords = await geocode(postal, city, province);
    if (coords) {
      locations.push({ name: city, postalCode: postal, province: provRaw, ...coords });
      console.log(`  -> ${coords.lat}, ${coords.lng}`);
    } else {
      console.warn(`  -> FAILED, skipping`);
    }

    if (i < uniqueRows.length - 1) await sleep(DELAY_MS);
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(locations, null, 2));
  console.log(`\nDone! Wrote ${locations.length} locations to ${OUT_PATH}`);
}

main().catch(console.error);
