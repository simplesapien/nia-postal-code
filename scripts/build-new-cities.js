const fs = require("fs");
const https = require("https");

const PROV_MAP = {
  BC: "British Columbia", AB: "Alberta", SK: "Saskatchewan",
  MB: "Manitoba", ON: "Ontario", QC: "Quebec",
  NB: "New Brunswick", NL: "Newfoundland and Labrador",
  NS: "Nova Scotia", PE: "Prince Edward Island",
  NT: "Northwest Territories", NU: "Nunavut", YT: "Yukon",
};

const NEW_CITIES = [
  // MB
  { name: "Cartier", province: "MB" },
  { name: "East St. Paul", province: "MB" },
  { name: "Lorette", province: "MB" },
  { name: "Rosenort", province: "MB" },
  { name: "Steinbach", province: "MB" },
  { name: "Tuelon", province: "MB" },
  { name: "Winnipeg", province: "MB" },
  // ON (missing from original)
  { name: "Thunder Bay", province: "ON" },
  // NB
  { name: "Bathurst", province: "NB" },
  { name: "Campbellton", province: "NB" },
  { name: "Fredericton", province: "NB" },
  { name: "Grand Bay-Westfield", province: "NB" },
  { name: "Moncton", province: "NB" },
  { name: "Picadilly", province: "NB" },
  { name: "Upper Knoxford", province: "NB" },
  // NL
  { name: "St. John's", province: "NL" },
  { name: "Corner Brook", province: "NL" },
  { name: "Grand Falls-Windsor", province: "NL" },
  { name: "Lethbridge", province: "NL" },
  // NS
  { name: "Antigonish", province: "NS" },
  { name: "Darling Lake", province: "NS" },
  { name: "Dartmouth", province: "NS" },
  { name: "Elmsdale", province: "NS" },
  { name: "Herring Cove", province: "NS" },
  { name: "Kingston", province: "NS" },
  { name: "Shag Harbour", province: "NS" },
  // PE
  { name: "Souris", province: "PE" },
  { name: "Summerside", province: "PE" },
  { name: "Stratford", province: "PE" },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function geocoderCa(query) {
  return new Promise((resolve, reject) => {
    const url = `https://geocoder.ca/?locate=${encodeURIComponent(query)}&geoit=xml&json=1`;
    https.get(url, (res) => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (data.latt && data.longt) {
            resolve({ lat: parseFloat(data.latt), lng: parseFloat(data.longt) });
          } else {
            resolve(null);
          }
        } catch { resolve(null); }
      });
    }).on("error", () => resolve(null));
  });
}

async function main() {
  const existing = JSON.parse(fs.readFileSync("locations.json", "utf-8"));
  const existingKeys = new Set(
    existing.map(e => `${e.name.toLowerCase()}|${(e.province || "").toUpperCase().replace(/ & .*/,"")}`)
  );

  console.log(`Existing: ${existing.length} locations`);
  console.log(`New cities to geocode: ${NEW_CITIES.length}`);

  const results = [];

  for (const city of NEW_CITIES) {
    const key = `${city.name.toLowerCase()}|${city.province}`;
    if (existingKeys.has(key)) {
      console.log(`  SKIP (exists): ${city.name}, ${city.province}`);
      continue;
    }

    const query = `${city.name}, ${PROV_MAP[city.province]}, Canada`;
    console.log(`  Geocoding: ${query}`);
    const coords = await geocoderCa(query);

    if (coords) {
      results.push({
        name: city.name,
        postalCode: null,
        province: city.province,
        provinceExpanded: PROV_MAP[city.province],
        lat: coords.lat,
        lng: coords.lng,
        source: "dynacare-march-2026",
      });
      console.log(`    -> ${coords.lat}, ${coords.lng}`);
    } else {
      console.log(`    -> FAILED, will try Nominatim`);
      await sleep(1100);
      const nomCoords = await nominatim(query);
      if (nomCoords) {
        results.push({
          name: city.name,
          postalCode: null,
          province: city.province,
          provinceExpanded: PROV_MAP[city.province],
          lat: nomCoords.lat,
          lng: nomCoords.lng,
          source: "dynacare-march-2026",
        });
        console.log(`    -> (Nominatim) ${nomCoords.lat}, ${nomCoords.lng}`);
      } else {
        console.error(`    -> FAILED BOTH for ${city.name}, ${city.province}`);
      }
    }

    await sleep(500);
  }

  const combined = [...existing, ...results];
  fs.writeFileSync("locations.json", JSON.stringify(combined, null, 2) + "\n");
  console.log(`\nDone. Total locations: ${combined.length} (${existing.length} existing + ${results.length} new)`);
}

function nominatim(query) {
  return new Promise((resolve) => {
    const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q: query, format: "json", limit: "1", countrycodes: "ca" })}`;
    https.get(url, { headers: { "User-Agent": "NiaHealthBuilder/1.0" } }, (res) => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (data.length) resolve({ lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) });
          else resolve(null);
        } catch { resolve(null); }
      });
    }).on("error", () => resolve(null));
  });
}

main().catch(console.error);
