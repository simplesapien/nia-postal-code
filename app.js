// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────

const MOBILE_URL         = "mobile-locations.json";
const CLINIC_URL         = "clinic-locations.json";
const RANGE_IN           = 100;
const RANGE_EXTENDED     = 200;
const NOMINATIM_DELAY_MS = 1100;
const MAX_GEOCODE_TRIES  = 4;

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────

let mobileLocations  = [];
let clinicLocations  = [];
let leafletMap       = null;
let currentMode      = "mobile";
let lastSearchCoords = null;

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────

async function loadJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} loading ${url}`);
  return res.json();
}

async function init() {
  try {
    const [mobile, clinics] = await Promise.all([
      loadJSON(MOBILE_URL),
      loadJSON(CLINIC_URL),
    ]);
    mobileLocations = mobile;
    clinicLocations = clinics;
    console.log(`Loaded ${mobileLocations.length} mobile + ${clinicLocations.length} clinic locations`);
  } catch (err) {
    console.error("Could not load location data:", err);
  }
}

// ─────────────────────────────────────────────
// PROVINCE NORMALIZATION
// ─────────────────────────────────────────────

const PROV_MAP = {
  ON: "Ontario", BC: "British Columbia", AB: "Alberta",
  SK: "Saskatchewan", MB: "Manitoba", QC: "Quebec",
  NS: "Nova Scotia", NB: "New Brunswick",
  NL: "Newfoundland and Labrador", PE: "Prince Edward Island",
  NT: "Northwest Territories", NU: "Nunavut", YT: "Yukon",
  aB: "Alberta",
};

const PROV_NAME_MAP = {
  ontario: "ON", "british columbia": "BC", alberta: "AB",
  saskatchewan: "SK", manitoba: "MB", quebec: "QC",
  "nova scotia": "NS", "new brunswick": "NB",
  "newfoundland": "NL", "newfoundland and labrador": "NL",
  "prince edward island": "PE", pei: "PE",
  "northwest territories": "NT", nunavut: "NU", yukon: "YT",
  // common abbreviations people type
  bc: "BC", ab: "AB", on: "ON", sk: "SK", mb: "MB",
  qc: "QC", ns: "NS", nb: "NB", nl: "NL", nt: "NT",
  nu: "NU", yt: "YT",
};

function normalizeProvince(raw) {
  if (!raw) return "";
  const t = raw.trim();
  if (PROV_MAP[t]) return PROV_MAP[t];
  if (PROV_MAP[t.toUpperCase()]) return PROV_MAP[t.toUpperCase()];
  if (t.length > 3) return t;
  return t;
}

// Resolve a user-typed province hint to a full name for Nominatim
function expandProvince(raw) {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  const abbr = PROV_NAME_MAP[key];
  if (abbr) return PROV_MAP[abbr] || raw;
  if (raw.length > 3) return raw; // already a full name
  return null;
}

// FSA first letter → province (Nominatim returns wrong coords without province context)
const FSA_PROVINCE = {
  A: "Newfoundland and Labrador", B: "Nova Scotia", C: "Prince Edward Island",
  E: "New Brunswick", G: "Quebec", H: "Quebec", J: "Quebec",
  K: "Ontario", L: "Ontario", M: "Ontario", N: "Ontario", P: "Ontario",
  R: "Manitoba", S: "Saskatchewan", T: "Alberta", V: "British Columbia",
  X: "Northwest Territories", Y: "Yukon",
};

// Rough lng bounds by region (Nominatim sometimes returns wrong province for postal codes)
const FSA_LNG = {
  A: [-60, -52], B: [-66, -59], C: [-64, -62], E: [-69, -63],
  G: [-80, -57], H: [-80, -57], J: [-80, -57],
  K: [-95, -74], L: [-95, -74], M: [-95, -74], N: [-95, -74], P: [-95, -74],
  R: [-102, -88], S: [-110, -101], T: [-120, -110], V: [-139, -114],
  X: [-136, -101], Y: [-141, -123],
};

function coordsInFsaRegion(lat, lng, fsa) {
  const bounds = FSA_LNG[fsa[0]];
  if (!bounds) return true;
  return lng >= bounds[0] && lng <= bounds[1];
}

// Fallback city when Nominatim doesn't recognize postal (e.g. B2N 5P0)
const FSA_FALLBACK_CITY = {
  B2N: "Truro, Nova Scotia, Canada", B2W: "Halifax, Nova Scotia, Canada",
  B3H: "Halifax, Nova Scotia, Canada", B4V: "Yarmouth, Nova Scotia, Canada",
};

// ─────────────────────────────────────────────
// INPUT CLEANING & PARSING
// ─────────────────────────────────────────────

const POSTAL_RE    = /\b([A-Za-z]\d[A-Za-z])\s*(\d[A-Za-z]\d)\b/;
const POSTAL_FSA   = /\b([A-Za-z]\d[A-Za-z])\b/;

function extractPostal(input) {
  const m = input.match(POSTAL_RE);
  if (m) return { full: (m[1] + m[2]).toUpperCase(), fsa: m[1].toUpperCase() };
  const f = input.match(POSTAL_FSA);
  if (f) return { full: null, fsa: f[1].toUpperCase() };
  return null;
}

function formatPostal(compact) {
  return compact.slice(0, 3).toUpperCase() + " " + compact.slice(3).toUpperCase();
}

// Strip postal code from a string
function stripPostal(s) {
  return s.replace(POSTAL_RE, "").replace(POSTAL_FSA, "").replace(/[,\s]+$/, "").replace(/^[,\s]+/, "").trim();
}

// ─────────────────────────────────────────────
// BUILD SEARCH VARIANTS
// Handles every realistic input format:
//   "Kelowna"
//   "Kelowna BC" / "Kelowna, BC"
//   "V1X 7H8" / "v1x7h8"
//   "123 Main St, Kelowna, BC"
//   "123 Main St Kelowna BC V1X 7H8"
//   "kelowna british columbia"
//   "Van BC"
// ─────────────────────────────────────────────

function buildVariants(raw) {
  const input  = raw.trim().replace(/\s{2,}/g, " ");
  const postal = extractPostal(input);
  const variants = [];
  const seen = new Set();
  const add  = (v) => {
    if (!v) return;
    const clean = v.trim().replace(/^[,\s]+|[,\s]+$/g, "");
    if (clean && !seen.has(clean.toLowerCase())) {
      seen.add(clean.toLowerCase());
      variants.push(clean);
    }
  };

  // ── CASE 1: Pure postal code ──────────────
  if (postal && input.replace(/[\s,]/g, "").length <= 7) {
    const prov = FSA_PROVINCE[postal.fsa[0]];
    if (postal.full) {
      if (prov) add(formatPostal(postal.full) + ", " + prov + ", Canada");
      add(formatPostal(postal.full) + ", Canada");
    }
    if (prov) add(postal.fsa + ", " + prov + ", Canada");
    add(postal.fsa + ", Canada");
    return variants;
  }

  // ── CASE 2: Parse parts ───────────────────
  // Split on commas first, then try to detect "City Province" patterns
  const commaParts = input.split(",").map(s => s.trim()).filter(Boolean);
  const stripped   = postal ? stripPostal(input) : input;

  // Last comma-part might be a province or country
  let city = null, province = null;

  if (commaParts.length >= 2) {
    const lastPart   = commaParts[commaParts.length - 1];
    const provHint   = expandProvince(lastPart.replace(POSTAL_RE, "").trim());
    if (provHint) {
      province = provHint;
      city     = commaParts.slice(0, -1).join(", ").replace(POSTAL_RE, "").trim();
    } else {
      city = stripped;
    }
  } else {
    // No commas — try to detect trailing province abbreviation
    // e.g. "Kelowna BC", "Van BC", "Surrey British Columbia"
    const words = stripped.split(/\s+/);
    if (words.length >= 2) {
      // Check if last 1 or 2 words are a province
      const last1 = words.slice(-1).join(" ");
      const last2 = words.slice(-2).join(" ");
      const prov2 = expandProvince(last2);
      const prov1 = expandProvince(last1);

      if (prov2) {
        province = prov2;
        city     = words.slice(0, -2).join(" ");
      } else if (prov1) {
        province = prov1;
        city     = words.slice(0, -1).join(" ");
      } else {
        city = stripped;
      }
    } else {
      city = stripped;
    }
  }

  // ── Build variants from parsed city + province ──
  if (city && province) {
    add(`${city}, ${province}, Canada`);
    add(`${city}, Canada`);
  } else if (city) {
    add(`${city}, Canada`);
    // Try with major provinces as fallback guesses
    ["BC", "Ontario", "Alberta", "Saskatchewan"].forEach(p => add(`${city}, ${p}, Canada`));
  }

  // Always add the cleaned full input
  add(stripped + ", Canada");

  // Add postal variants if present
  if (postal) {
    if (postal.full) add(formatPostal(postal.full) + ", Canada");
    add(postal.fsa + ", Canada");
  }

  // Raw input as absolute last resort
  add(input + ", Canada");
  add(input);

  return variants;
}

// ─────────────────────────────────────────────
// GEOCODING — geocoder.ca (primary for Canada) + Nominatim (fallback)
// ─────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// geocoder.ca: reliable for Canadian postal codes & addresses (JSONP for browser CORS)
async function geocoderCaSearch(locate) {
  return new Promise((resolve) => {
    const cb = "gc_" + Date.now();
    window[cb] = (data) => {
      delete window[cb];
      script.remove();
      if (data?.error || !data?.latt || !data?.longt) resolve(null);
      else resolve({ lat: parseFloat(data.latt), lng: parseFloat(data.longt) });
    };
    const script = document.createElement("script");
    script.src = "https://geocoder.ca/?locate=" + encodeURIComponent(locate) + "&geoit=xml&jsonp=1&callback=" + cb;
    document.body.appendChild(script);
    script.onerror = () => { delete window[cb]; script.remove(); resolve(null); };
  });
}

async function nominatimSearch(query) {
  const url = "https://nominatim.openstreetmap.org/search?" + new URLSearchParams({
    q: query, format: "json", limit: "1", countrycodes: "ca",
  });
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "NiaHealthServiceChecker/2.0 (https://github.com/simplesapien/nia-postal-code)" }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.length) return null;
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  } catch { return null; }
}

function buildGeocoderCaQuery(raw) {
  const t = raw.trim().replace(/\s{2,}/g, " ");
  const postal = extractPostal(t);
  if (postal?.full) return formatPostal(postal.full);
  return t.replace(/,/g, " ").trim();
}

function isInCanada(lat, lng) {
  return lat >= 41.7 && lat <= 83.2 && lng >= -141.1 && lng <= -52.5;
}

async function geocode(rawAddress) {
  const postal = extractPostal(rawAddress);
  const gcQuery = buildGeocoderCaQuery(rawAddress);

  // 1. Try geocoder.ca first (reliable for Canadian postal codes & addresses)
  const gc = await geocoderCaSearch(gcQuery);
  if (gc && isInCanada(gc.lat, gc.lng)) return gc;

  // 2. Fallback to Nominatim with validation
  let variants = buildVariants(rawAddress).slice(0, MAX_GEOCODE_TRIES);
  const fallback = postal && FSA_FALLBACK_CITY[postal.fsa];
  if (fallback && !variants.includes(fallback)) variants = [...variants, fallback];
  for (let i = 0; i < variants.length; i++) {
    if (i > 0) await sleep(NOMINATIM_DELAY_MS);
    const coords = await nominatimSearch(variants[i]);
    if (coords) {
      if (!isInCanada(coords.lat, coords.lng)) continue;
      if (postal && !coordsInFsaRegion(coords.lat, coords.lng, postal.fsa)) continue;
      return coords;
    }
  }
  return null;
}

// ─────────────────────────────────────────────
// DISTANCE
// ─────────────────────────────────────────────

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function findNearestIn(lat, lng, locations) {
  let best = null, bestDist = Infinity;
  for (const loc of locations) {
    if (loc.lat == null || loc.lng == null) continue;
    const d = haversineKm(lat, lng, loc.lat, loc.lng);
    if (d < bestDist) { bestDist = d; best = loc; }
  }
  return best ? { location: best, distance: bestDist } : null;
}

function findNearest(lat, lng) {
  const mobile = findNearestIn(lat, lng, mobileLocations);
  const clinic = findNearestIn(lat, lng, clinicLocations);
  const results = [];
  if (mobile) results.push(mobile);
  if (clinic) results.push(clinic);
  if (!results.length) return null;
  results.sort((a, b) => a.distance - b.distance);
  return results[0];
}

function findNearestByType(lat, lng) {
  return {
    mobile: findNearestIn(lat, lng, mobileLocations),
    clinic: findNearestIn(lat, lng, clinicLocations),
  };
}

function findNearestN(lat, lng, locations, n) {
  const scored = [];
  for (const loc of locations) {
    if (loc.lat == null || loc.lng == null) continue;
    scored.push({ location: loc, distance: haversineKm(lat, lng, loc.lat, loc.lng) });
  }
  scored.sort((a, b) => a.distance - b.distance);
  return scored.slice(0, n);
}

// ─────────────────────────────────────────────
// MAP
// ─────────────────────────────────────────────

const PIN_SVG = {
  user: `<svg width="32" height="42" viewBox="0 0 32 42" fill="none"><path d="M16 0C7.16 0 0 7.16 0 16c0 12 16 26 16 26s16-14 16-26C32 7.16 24.84 0 16 0z" fill="#0d9488"/><circle cx="16" cy="15" r="7" fill="white"/><circle cx="16" cy="15" r="4" fill="#0d9488"/></svg>`,
  mobile: `<svg width="32" height="42" viewBox="0 0 32 42" fill="none"><path d="M16 0C7.16 0 0 7.16 0 16c0 12 16 26 16 26s16-14 16-26C32 7.16 24.84 0 16 0z" fill="#2563eb"/><circle cx="16" cy="15" r="7" fill="white"/><path d="M12 15h8M16 11v8" stroke="#2563eb" stroke-width="2" stroke-linecap="round"/></svg>`,
  clinic: `<svg width="32" height="42" viewBox="0 0 32 42" fill="none"><path d="M16 0C7.16 0 0 7.16 0 16c0 12 16 26 16 26s16-14 16-26C32 7.16 24.84 0 16 0z" fill="#7c3aed"/><circle cx="16" cy="15" r="7" fill="white"/><rect x="12" y="11" width="8" height="8" rx="1.5" stroke="#7c3aed" stroke-width="1.8" fill="none"/><path d="M14 15h4" stroke="#7c3aed" stroke-width="1.8" stroke-linecap="round"/></svg>`,
};

function makePin(type) {
  return L.divIcon({ className: "", html: PIN_SVG[type], iconSize: [32, 42], iconAnchor: [16, 42], popupAnchor: [0, -36] });
}

function showMap(userLat, userLng, results, opts = {}) {
  const mapEl    = document.getElementById("map");
  const emptyEl  = document.getElementById("map-empty");
  const legendEl = document.getElementById("map-legend");

  emptyEl.style.display = "none";
  mapEl.classList.add("visible");
  legendEl.classList.add("visible");

  if (leafletMap) { leafletMap.remove(); leafletMap = null; }

  leafletMap = L.map("map", { zoomControl: true, scrollWheelZoom: true });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 16,
  }).addTo(leafletMap);

  L.marker([userLat, userLng], { icon: makePin("user") })
    .addTo(leafletMap).bindPopup("<b>Your location</b>").openPopup();

  const bounds = [[userLat, userLng]];

  for (const r of results) {
    if (!r) continue;
    const loc = r.location;
    const isClinic = loc.type === "clinic";
    const pin = makePin(isClinic ? "clinic" : "mobile");
    const province = loc.provinceExpanded || normalizeProvince(loc.province) || loc.province;
    const label = isClinic
      ? `<b>${loc.name}</b><br><span style="font-size:0.75rem;color:#666">${loc.address}, ${loc.city}</span>`
      : `<b>${loc.name}</b>, ${province}`;
    L.marker([loc.lat, loc.lng], { icon: pin })
      .addTo(leafletMap).bindPopup(label);
    bounds.push([loc.lat, loc.lng]);
  }

  if (opts.showRangeRings) {
    L.circle([userLat, userLng], {
      radius: 100000, color:"#0d9488", fillColor:"#0d9488",
      fillOpacity: 0.06, weight: 1.5, dashArray:"6 4",
    }).addTo(leafletMap);

    L.circle([userLat, userLng], {
      radius: 200000, color:"#d97706", fillColor:"#d97706",
      fillOpacity: 0.04, weight: 1.5, dashArray:"6 4",
    }).addTo(leafletMap);
  }

  leafletMap.fitBounds(L.latLngBounds(bounds).pad(0.25));
  leafletMap.invalidateSize();
}

// ─────────────────────────────────────────────
// RENDER RESULT
// ─────────────────────────────────────────────

function renderMobileResult(mobileResult, userCoords) {
  if (!mobileResult) return;
  const distKm = Math.round(mobileResult.distance);
  const loc    = mobileResult.location;
  const province = loc.provinceExpanded || normalizeProvince(loc.province) || loc.province;
  const card   = document.getElementById("result-card");

  let icon, title, sub, note, cls;

  if (distKm <= RANGE_IN) {
    icon  = `<svg viewBox="0 0 24 24"><polyline points="20,6 9,17 4,12"/></svg>`;
    title = "We're in your area!";
    sub   = "Standard service rates apply";
    note  = "A mobile phlebotomist can come to your home or work. Book your appointment and we'll handle the rest.";
    cls   = "in-range";
  } else if (distKm <= RANGE_EXTENDED) {
    icon  = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
    title = "Extended service area";
    sub   = "Additional travel fees may apply";
    note  = "We can likely reach you, but travel fees may be added. Contact us to confirm availability.";
    cls   = "extended";
  } else {
    icon  = `<svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
    title = "Outside our coverage";
    sub   = "No mobile service in your area";
    note  = "This address is outside our current mobile range. We're expanding — contact us and we'll let you know when we reach you.";
    cls   = "out-of-range";
  }

  card.className = "result-card visible " + cls;
  card.innerHTML = `
    <div class="rc-header">
      <div class="rc-badge">${icon}</div>
      <div>
        <div class="rc-title">${title}</div>
        <div class="rc-sub">${sub}</div>
      </div>
    </div>
    <div class="rc-stats">
      <div class="rc-stat">
        <div class="rc-stat-label">Distance</div>
        <div class="rc-stat-val">${distKm}<span style="font-size:0.9rem;font-family:'Instrument Sans',sans-serif;font-weight:400;color:var(--muted)"> km</span></div>
      </div>
      <div class="rc-stat">
        <div class="rc-stat-label">Nearest phlebotomist</div>
        <div class="rc-stat-val small">${loc.name}, ${province}</div>
      </div>
    </div>
    <p class="rc-note">${note}</p>
  `;

  if (userCoords && loc.lat && loc.lng) {
    showMap(userCoords.lat, userCoords.lng, [mobileResult], { showRangeRings: true });
  }
}

function renderClinicResult(clinicResults, userCoords) {
  if (!clinicResults.length) return;
  const card = document.getElementById("result-card");

  const itemsHtml = clinicResults.map((r, i) => {
    const loc = r.location;
    const km  = Math.round(r.distance);
    const addr = [loc.address, loc.city].filter(Boolean).join(", ");
    const mapsUrl = loc.lat && loc.lng
      ? `https://www.google.com/maps/dir/?api=1&destination=${loc.lat},${loc.lng}`
      : "#";
    return `<div class="clinic-item">
      <div class="clinic-rank">${i + 1}</div>
      <div class="clinic-info">
        <div class="clinic-name">${loc.name}</div>
        <div class="clinic-addr">${addr}${mapsUrl !== "#" ? ` · <a href="${mapsUrl}" target="_blank" rel="noopener">Directions</a>` : ""}</div>
      </div>
      <div class="clinic-dist">${km} <span>km</span></div>
    </div>`;
  }).join("");

  card.className = "result-card visible clinic-results";
  card.innerHTML = `
    <div class="rc-header" style="margin-bottom:8px">
      <div class="rc-badge" style="background:#7c3aed">
        <svg viewBox="0 0 24 24"><path d="M3 21h18M9 8h1M9 12h1M9 16h1M14 8h1M14 12h1M14 16h1"/><rect x="5" y="2" width="14" height="19" rx="2"/></svg>
      </div>
      <div>
        <div class="rc-title" style="color:var(--ink)">Nearest clinics</div>
        <div class="rc-sub">${clinicResults.length} closest lab${clinicResults.length > 1 ? "s" : ""} to you</div>
      </div>
    </div>
    <div class="clinic-list">${itemsHtml}</div>
  `;

  if (userCoords) {
    const mapResults = clinicResults.filter(r => r.location.lat && r.location.lng);
    if (mapResults.length) showMap(userCoords.lat, userCoords.lng, mapResults, { showRangeRings: false });
  }
}

// ─────────────────────────────────────────────
// SUBMIT
// ─────────────────────────────────────────────

async function handleSubmit(opts = {}) {
  const fromMap = opts.source === "map";
  const addressEl = fromMap ? document.getElementById("map-address") : document.getElementById("address");
  const address   = addressEl.value.trim();
  if (!address) { addressEl.focus(); return; }

  const btn       = fromMap ? document.getElementById("map-submit-btn") : document.getElementById("submit-btn");
  const errorEl   = fromMap ? document.getElementById("map-error") : document.getElementById("error");
  const loadBar   = document.getElementById("loading-bar");
  const card      = document.getElementById("result-card");
  const mapEl     = document.getElementById("map");
  const emptyEl   = document.getElementById("map-empty");
  const legendEl  = document.getElementById("map-legend");
  const mapResult = document.getElementById("map-result");

  function showErr(msg) {
    errorEl.textContent = msg;
    errorEl.classList.add("visible");
    if (mapResult) { mapResult.classList.remove("visible"); }
  }

  // Reset
  card.classList.remove("visible");
  errorEl.classList.remove("visible");
  if (mapResult) mapResult.classList.remove("visible");
  mapEl.classList.remove("visible");
  legendEl.classList.remove("visible");
  emptyEl.style.display = "";
  loadBar.classList.add("visible");
  btn.disabled = true;
  btn.innerHTML = `<svg class="spin" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-6.219-8.56" stroke="white" fill="none" stroke-width="2.5" stroke-linecap="round"/></svg>`;

  try {
    if (!mobileLocations.length && !clinicLocations.length) throw new Error("Location data not loaded. Please refresh.");

    const coords = opts.coords || await geocode(address);

    if (!coords) {
      showErr("Couldn't find that Canadian location. Try a city name, postal code (e.g. V3T 1Z2), or full address. We only cover Canada.");
      return;
    }

    lastSearchCoords = coords;

    if (currentMode === "mobile") {
      const nearest = findNearestIn(coords.lat, coords.lng, mobileLocations);
      if (!nearest) { showErr("No mobile phlebotomists found. Please try again later."); return; }
      renderMobileResult(nearest, coords);
      updateLegend();

      if (fromMap && mapResult) {
        const distKm = Math.round(nearest.distance);
        const loc = nearest.location;
        const province = loc.provinceExpanded || normalizeProvince(loc.province) || loc.province;
        if (distKm <= RANGE_IN) mapResult.textContent = `✓ In range · ${distKm} km to ${loc.name}, ${province}`;
        else if (distKm <= RANGE_EXTENDED) mapResult.textContent = `⚠ Extended · ${distKm} km to ${loc.name}, ${province}`;
        else mapResult.textContent = `✗ Out of range · ${distKm} km to ${loc.name}, ${province}`;
        mapResult.classList.add("visible");
      }
    } else {
      const nearest3 = findNearestN(coords.lat, coords.lng, clinicLocations, 3);
      if (!nearest3.length) { showErr("No clinics found. Please try again later."); return; }
      renderClinicResult(nearest3, coords);
      updateLegend();

      if (fromMap && mapResult) {
        const loc = nearest3[0].location;
        const distKm = Math.round(nearest3[0].distance);
        mapResult.textContent = `Nearest: ${loc.name}, ${loc.city} · ${distKm} km`;
        mapResult.classList.add("visible");
      }
    }

    if (fromMap) {
      document.getElementById("address").value = address;
    }

  } catch (err) {
    console.error(err);
    showErr(err.message || "Something went wrong. Please try again.");
  } finally {
    const checkBtn = `<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg> Check`;
    btn.disabled = false;
    btn.innerHTML = checkBtn;
    loadBar.classList.remove("visible");
  }
}

function showError(msg) {
  const el = document.getElementById("error");
  el.textContent = msg;
  el.classList.add("visible");
}

// ─────────────────────────────────────────────
// VIEW TOGGLE (Map / Text only)
// ─────────────────────────────────────────────

const STORAGE_VIEW = "nia-view-mode";

function initViewToggle() {
  const app  = document.querySelector(".app");
  const btns = document.querySelectorAll(".view-btn");
  let saved = localStorage.getItem(STORAGE_VIEW) || "form";
  if (saved === "text") saved = "form"; // migrate old preference

  function setView(mode) {
    btns.forEach(b => b.classList.toggle("active", b.dataset.view === mode));
    app.classList.remove("view-form", "view-map");
    app.classList.add("view-" + mode);
    localStorage.setItem(STORAGE_VIEW, mode);
    const addr = document.getElementById("address");
    const mapAddr = document.getElementById("map-address");
    if (addr && mapAddr) {
      if (mode === "map") {
        mapAddr.value = addr.value;
        if (addr.value.trim()) handleSubmit({ source: "map" });
      } else {
        addr.value = mapAddr.value;
      }
    }
  }

  setView(saved);
  btns.forEach(btn => {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  });
}

// ─────────────────────────────────────────────
// MODE TOGGLE (Mobile / Clinic)
// ─────────────────────────────────────────────

const MODE_COPY = {
  mobile: {
    heading: 'Are we near<br><em>you?</em>',
    sub: 'Enter any address, city, or postal code — we\'ll check if a mobile phlebotomist can reach you.',
    emptyHint: 'The map will show you and the nearest mobile phlebotomist',
  },
  clinic: {
    heading: 'Find a lab<br>near <em>you</em>',
    sub: 'Enter any address, city, or postal code — we\'ll find the 3 closest in-clinic labs.',
    emptyHint: 'The map will show you and the nearest clinics',
  },
};

function updateModeUI() {
  const copy = MODE_COPY[currentMode];
  document.querySelector(".panel-heading").innerHTML = copy.heading;
  document.querySelector(".panel-sub").innerHTML = copy.sub;
  const hint = document.querySelector(".map-empty-hint");
  if (hint) hint.textContent = copy.emptyHint;

  document.querySelectorAll(".mode-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.mode === currentMode);
  });
}

function updateLegend() {
  document.querySelectorAll(".leg-mobile").forEach(el => el.style.display = currentMode === "mobile" ? "" : "none");
  document.querySelectorAll(".leg-clinic").forEach(el => el.style.display = currentMode === "clinic" ? "" : "none");
}

function initModeToggle() {
  const btns = document.querySelectorAll(".mode-btn");
  btns.forEach(btn => {
    btn.addEventListener("click", () => {
      const newMode = btn.dataset.mode;
      if (newMode === currentMode) return;
      currentMode = newMode;
      updateModeUI();
      updateLegend();

      // Clear current results
      const card = document.getElementById("result-card");
      card.classList.remove("visible");
      card.className = "result-card";

      // Re-run search if user already searched
      if (lastSearchCoords) {
        handleSubmit({ coords: lastSearchCoords });
      }
    });
  });

  updateModeUI();
  updateLegend();
}

// ─────────────────────────────────────────────
// CHIPS
// ─────────────────────────────────────────────

function initChips() {
  document.querySelectorAll(".chip").forEach(chip => {
    chip.addEventListener("click", () => {
      document.getElementById("address").value = chip.dataset.val;
      document.getElementById("address").focus();
    });
  });
}

// ─────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  init();
  initChips();
  initModeToggle();
  initViewToggle();
  document.getElementById("submit-btn").addEventListener("click", () => handleSubmit());
  document.getElementById("address").addEventListener("keydown", e => {
    if (e.key === "Enter") handleSubmit();
  });
  const mapSubmit = document.getElementById("map-submit-btn");
  const mapAddress = document.getElementById("map-address");
  if (mapSubmit) mapSubmit.addEventListener("click", () => handleSubmit({ source: "map" }));
  if (mapAddress) mapAddress.addEventListener("keydown", e => {
    if (e.key === "Enter") handleSubmit({ source: "map" });
  });
});