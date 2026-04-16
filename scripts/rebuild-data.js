// rebuild-data.js
// Reads nia-coverage-master.csv (single source of truth) and produces
// mobile-locations.json + clinic-locations.json for the frontend app.

const fs   = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const CSV  = path.join(DATA, "nia-coverage-master.csv");

const PROV_MAP = {
  ON: "Ontario", BC: "British Columbia", AB: "Alberta",
  SK: "Saskatchewan", MB: "Manitoba", QC: "Quebec",
  NS: "Nova Scotia", NB: "New Brunswick",
  NL: "Newfoundland and Labrador", PE: "Prince Edward Island",
  NT: "Northwest Territories", NU: "Nunavut", YT: "Yukon",
};

// ── Read and parse the master CSV ──

const csvRaw  = fs.readFileSync(CSV, "utf-8");
const csvRows = parse(csvRaw, {
  columns: true,
  skip_empty_lines: true,
  trim: true,
  bom: true,
  relax_column_count: true,
});

const mobileLocations = [];
const clinicLocations = [];
let skipped = 0;

for (const row of csvRows) {
  const section = (row["Section"] || "").trim();

  // Skip section header rows (=== ... ===)
  if (!section || section.startsWith("===")) {
    skipped++;
    continue;
  }

  const name       = (row["Name"] || "").trim();
  const address    = (row["Address"] || "").trim();
  const city       = (row["City"] || "").trim();
  const province   = (row["Province"] || "").trim();
  const postalRaw  = (row["Postal Code"] || "").trim();
  const lat        = parseFloat(row["Latitude"]);
  const lng        = parseFloat(row["Longitude"]);
  const type       = (row["Type"] || "").trim();

  if (!name || isNaN(lat) || isNaN(lng)) {
    skipped++;
    continue;
  }

  const postalCode = (postalRaw && postalRaw !== "MISSING") ? postalRaw : null;
  const provinceExpanded = PROV_MAP[province] || province;

  // Derive source from Section for JSON metadata
  const sectionLower = section.toLowerCase();
  let source = "unknown";
  if (sectionLower.includes("lifelabs"))             source = "lifelabs-bc";
  else if (sectionLower.includes("dynacare ontario")) source = "dynacare-on";
  else if (sectionLower.includes("dynacare manitoba")) source = "dynacare-mb";
  else if (sectionLower.startsWith("mobile"))          source = "dynacare-mobile";

  if (type === "mobile") {
    mobileLocations.push({
      name,
      postalCode,
      province,
      provinceExpanded,
      lat,
      lng,
      type: "mobile",
      source,
    });
  } else if (type === "clinic") {
    clinicLocations.push({
      name,
      address: address || undefined,
      city,
      province,
      provinceExpanded,
      postalCode,
      lat,
      lng,
      type: "clinic",
      source,
    });
  } else {
    skipped++;
  }
}

// ── Write output ──

fs.writeFileSync(
  path.join(ROOT, "mobile-locations.json"),
  JSON.stringify(mobileLocations, null, 2) + "\n"
);

fs.writeFileSync(
  path.join(ROOT, "clinic-locations.json"),
  JSON.stringify(clinicLocations, null, 2) + "\n"
);

// ── Report ──

const noPostal = mobileLocations.filter(l => l.postalCode == null);
const mobileByProv = {};
for (const l of mobileLocations) {
  mobileByProv[l.province] = (mobileByProv[l.province] || 0) + 1;
}
const clinicBySrc = {};
for (const l of clinicLocations) {
  clinicBySrc[l.source] = (clinicBySrc[l.source] || 0) + 1;
}

console.log("\n=== Rebuild Complete ===\n");
console.log(`Source: nia-coverage-master.csv`);
console.log(`Rows skipped (headers/empty): ${skipped}\n`);

console.log(`Mobile locations: ${mobileLocations.length}`);
for (const [prov, count] of Object.entries(mobileByProv).sort()) {
  console.log(`  ${prov}: ${count}`);
}
console.log(`  Missing postal codes: ${noPostal.length}`);
if (noPostal.length) {
  console.log("    " + noPostal.map(l => `${l.name}, ${l.province}`).join("\n    "));
}

console.log(`\nClinic locations: ${clinicLocations.length}`);
for (const [src, count] of Object.entries(clinicBySrc).sort()) {
  console.log(`  ${src}: ${count}`);
}

console.log(`\nFiles written:`);
console.log(`  mobile-locations.json`);
console.log(`  clinic-locations.json`);
console.log("");
