// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────

const MOBILE_URL         = "mobile-locations.json";
const CLINIC_URL         = "clinic-locations.json";
const RANGE_IN           = 100;
const RANGE_EXTENDED     = 200;
const NOMINATIM_DELAY_MS = 1100;
const MAX_GEOCODE_TRIES  = 4;
const SERVICE_AREA_RADIUS = 100000; // meters – visual radius matches RANGE_IN (100 km)

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────

let mobileLocations  = [];
let clinicLocations  = [];
let leafletMap       = null;
let mapOverlays      = [];
let lastSearchCoords = null;
let currentTab       = "all";
let mobileCircleLayer = null;
let clinicMarkerLayers = [];
let fsaIndex      = {};
let cityIndex     = {};
let postalIndex   = {};
let dataReady     = null;

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
    buildLocalIndexes();
  } catch (err) {
    console.error("Could not load location data:", err);
  } finally {
    const lb = document.getElementById("loading-bar");
    if (lb) lb.classList.remove("visible");
    const addrEl = document.getElementById("address");
    if (addrEl) addrEl.removeAttribute("disabled");
    const btnEl = document.getElementById("submit-btn");
    if (btnEl) btnEl.removeAttribute("disabled");
  }
}

function buildLocalIndexes() {
  const PRIORITY_PROVS = new Set(["ON", "BC", "AB", "MB"]);
  const allLocations = [...mobileLocations, ...clinicLocations];

  for (const loc of allLocations) {
    const cityName = (loc.city || loc.name || "").trim().toLowerCase();
    const province = (loc.province || "").trim().toUpperCase();
    if (cityName && loc.lat != null && loc.lng != null) {
      const existing = cityIndex[cityName];
      if (!existing || (!PRIORITY_PROVS.has(existing.province) && PRIORITY_PROVS.has(province))) {
        cityIndex[cityName] = { lat: loc.lat, lng: loc.lng, province };
      }
      if (province) {
        const keyProv = cityName + "|" + province;
        if (!cityIndex[keyProv]) {
          cityIndex[keyProv] = { lat: loc.lat, lng: loc.lng, province };
        }
      }
    }

    const pc = (loc.postalCode || "").replace(/\s/g, "").toUpperCase();
    if (pc && loc.lat != null && loc.lng != null) {
      if (pc.length === 6) {
        if (!postalIndex[pc]) postalIndex[pc] = { lat: loc.lat, lng: loc.lng };
        const fsa = pc.slice(0, 3);
        if (!fsaIndex[fsa]) fsaIndex[fsa] = { lat: loc.lat, lng: loc.lng };
      } else if (pc.length === 3) {
        if (!fsaIndex[pc]) fsaIndex[pc] = { lat: loc.lat, lng: loc.lng };
      }
    }
  }

  console.log(`Local indexes: ${Object.keys(fsaIndex).length} FSAs, ${Object.keys(cityIndex).length} city keys, ${Object.keys(postalIndex).length} postal codes`);
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

function expandProvince(raw) {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  const abbr = PROV_NAME_MAP[key];
  if (abbr) return PROV_MAP[abbr] || raw;
  return null;
}

const FSA_PROVINCE = {
  A: "Newfoundland and Labrador", B: "Nova Scotia", C: "Prince Edward Island",
  E: "New Brunswick", G: "Quebec", H: "Quebec", J: "Quebec",
  K: "Ontario", L: "Ontario", M: "Ontario", N: "Ontario", P: "Ontario",
  R: "Manitoba", S: "Saskatchewan", T: "Alberta", V: "British Columbia",
  X: "Northwest Territories", Y: "Yukon",
};

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

const FSA_FALLBACK_CITY = {
  B2N: "Truro, Nova Scotia, Canada", B2W: "Halifax, Nova Scotia, Canada",
  B3H: "Halifax, Nova Scotia, Canada", B4V: "Yarmouth, Nova Scotia, Canada",
};

// ─────────────────────────────────────────────
// INPUT CLEANING & PARSING
// ─────────────────────────────────────────────

const POSTAL_RE  = /\b([A-Za-z]\d[A-Za-z])\s*(\d[A-Za-z]\d)\b/;
const POSTAL_FSA = /\b([A-Za-z]\d[A-Za-z])\b/;

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

function stripPostal(s) {
  return s.replace(POSTAL_RE, "").replace(POSTAL_FSA, "").replace(/[,\s]+$/, "").replace(/^[,\s]+/, "").trim();
}

// ─────────────────────────────────────────────
// BUILD SEARCH VARIANTS
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

  const commaParts = input.split(",").map(s => s.trim()).filter(Boolean);
  const stripped   = postal ? stripPostal(input) : input;
  let city = null, province = null;

  if (commaParts.length >= 2) {
    const lastPart = commaParts[commaParts.length - 1];
    const provHint = expandProvince(lastPart.replace(POSTAL_RE, "").trim());
    if (provHint) {
      province = provHint;
      city     = commaParts.slice(0, -1).join(", ").replace(POSTAL_RE, "").trim();
    } else {
      city = stripped;
    }
  } else {
    const words = stripped.split(/\s+/);
    if (words.length >= 2) {
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

  if (city && province) {
    add(`${city}, ${province}, Canada`);
    add(`${city}, Canada`);
  } else if (city) {
    add(`${city}, Canada`);
    ["Ontario", "BC", "Alberta", "Manitoba", "Saskatchewan", "Quebec"].forEach(p => add(`${city}, ${p}, Canada`));
  }

  add(stripped + ", Canada");

  if (postal) {
    if (postal.full) add(formatPostal(postal.full) + ", Canada");
    add(postal.fsa + ", Canada");
  }

  add(input + ", Canada");
  add(input);

  return variants;
}

// ─────────────────────────────────────────────
// GEOCODING
// ─────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function geocoderCaSearch(locate) {
  const t0 = performance.now();
  console.log("📡 geocoder.ca → query:", JSON.stringify(locate));
  return new Promise((resolve) => {
    const cb = "gc_" + Date.now();
    window[cb] = (data) => {
      delete window[cb];
      script.remove();
      const ms = (performance.now() - t0).toFixed(0);
      if (data?.error || !data?.latt || !data?.longt) {
        console.log("📡 geocoder.ca ← null (" + ms + "ms)", data?.error || "no coords");
        resolve(null);
      } else {
        const result = { lat: parseFloat(data.latt), lng: parseFloat(data.longt) };
        console.log("📡 geocoder.ca ←", result.lat.toFixed(6), result.lng.toFixed(6), "(" + ms + "ms)");
        resolve(result);
      }
    };
    const script = document.createElement("script");
    script.src = "https://geocoder.ca/?locate=" + encodeURIComponent(locate) + "&geoit=xml&jsonp=1&callback=" + cb;
    document.body.appendChild(script);
    script.onerror = () => { delete window[cb]; script.remove(); console.log("📡 geocoder.ca ← error (" + (performance.now() - t0).toFixed(0) + "ms)"); resolve(null); };
  });
}

async function nominatimSearch(query) {
  const t0 = performance.now();
  console.log("🌐 nominatim → query:", JSON.stringify(query));
  const url = "https://nominatim.openstreetmap.org/search?" + new URLSearchParams({
    q: query, format: "json", limit: "1", countrycodes: "ca",
  });
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "NiaHealthServiceChecker/2.0 (https://github.com/simplesapien/nia-postal-code)" }
    });
    const ms = (performance.now() - t0).toFixed(0);
    if (!res.ok) { console.log("🌐 nominatim ← HTTP", res.status, "(" + ms + "ms)"); return null; }
    const data = await res.json();
    if (!data.length) { console.log("🌐 nominatim ← no results (" + ms + "ms)"); return null; }
    const result = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    console.log("🌐 nominatim ←", result.lat.toFixed(6), result.lng.toFixed(6), "|", data[0].display_name, "(" + ms + "ms)");
    return result;
  } catch (e) { console.log("🌐 nominatim ← error:", e.message, "(" + (performance.now() - t0).toFixed(0) + "ms)"); return null; }
}

function buildGeocoderCaQuery(raw) {
  const t = raw.trim().replace(/\s{2,}/g, " ");
  const postal = extractPostal(t);
  if (postal?.full) return formatPostal(postal.full);
  const cleaned = t.replace(/,/g, " ").trim();
  if (!cleaned.toLowerCase().includes("canada")) return cleaned + ", Canada";
  return cleaned;
}

function isInCanada(lat, lng) {
  return lat >= 41.7 && lat <= 83.2 && lng >= -141.1 && lng <= -52.5;
}

function localLookup(rawAddress) {
  const input = rawAddress.trim();
  console.group("🔍 localLookup");
  console.log("Input:", JSON.stringify(input));

  const postal = extractPostal(input);
  if (postal) {
    console.log("Postal detected:", postal);
    if (postal.full) {
      const fullKey = postal.full.replace(/\s/g, "").toUpperCase();
      if (postalIndex[fullKey]) { console.log("✅ postalIndex hit:", fullKey, postalIndex[fullKey]); console.groupEnd(); return postalIndex[fullKey]; }
      const fsa = fullKey.slice(0, 3);
      if (fsaIndex[fsa]) { console.log("✅ fsaIndex hit:", fsa, fsaIndex[fsa]); console.groupEnd(); return fsaIndex[fsa]; }
      console.log("No postal/FSA index match for", fullKey, "/", fsa);
    } else if (postal.fsa) {
      if (fsaIndex[postal.fsa]) { console.log("✅ fsaIndex hit:", postal.fsa, fsaIndex[postal.fsa]); console.groupEnd(); return fsaIndex[postal.fsa]; }
      console.log("No FSA index match for", postal.fsa);
    }
  } else {
    console.log("No postal code detected");
  }

  let cleaned = input
    .replace(/\b[A-Za-z]\d[A-Za-z]\s*\d?[A-Za-z]?\d?\b/g, "")
    .replace(/,?\s*canada\s*$/i, "")
    .trim();
  console.log("Cleaned for city lookup:", JSON.stringify(cleaned));

  const parts = cleaned.split(",").map(s => s.trim()).filter(Boolean);
  console.log("Comma parts:", parts);

  if (parts.length >= 2) {
    const maybeProv = parts[parts.length - 1];
    const provAbbr = PROV_NAME_MAP[maybeProv.toLowerCase()];
    if (provAbbr) {
      const cityPart = parts.slice(0, -1).join(", ").toLowerCase();
      const keyProv = cityPart + "|" + provAbbr;
      console.log("Trying city+prov:", keyProv, "→", cityIndex[keyProv] || "miss");
      if (cityIndex[keyProv]) { console.log("✅ city+prov hit"); console.groupEnd(); return cityIndex[keyProv]; }
      console.log("Trying city only:", cityPart, "→", cityIndex[cityPart] || "miss");
      if (cityIndex[cityPart]) { console.log("✅ city hit"); console.groupEnd(); return cityIndex[cityPart]; }
    }
  }

  const lowerCleaned = cleaned.toLowerCase();
  console.log("Trying full cleaned:", JSON.stringify(lowerCleaned), "→", cityIndex[lowerCleaned] || "miss");
  if (cityIndex[lowerCleaned]) { console.log("✅ city hit"); console.groupEnd(); return cityIndex[lowerCleaned]; }

  if (parts.length >= 1) {
    const firstPart = parts[0].toLowerCase();
    console.log("Trying first part:", JSON.stringify(firstPart), "→", cityIndex[firstPart] || "miss");
    if (cityIndex[firstPart]) { console.log("✅ first-part hit"); console.groupEnd(); return cityIndex[firstPart]; }
  }

  const words = lowerCleaned.split(/\s+/);
  if (words.length >= 2) {
    const lastWord = words[words.length - 1];
    if (PROV_NAME_MAP[lastWord]) {
      const cityPart = words.slice(0, -1).join(" ");
      const provAbbr = PROV_NAME_MAP[lastWord];
      const keyProv = cityPart + "|" + provAbbr;
      console.log("Trying word-split city+prov:", keyProv, "→", cityIndex[keyProv] || "miss");
      if (cityIndex[keyProv]) { console.log("✅ word-split hit"); console.groupEnd(); return cityIndex[keyProv]; }
      console.log("Trying word-split city:", cityPart, "→", cityIndex[cityPart] || "miss");
      if (cityIndex[cityPart]) { console.log("✅ word-split city hit"); console.groupEnd(); return cityIndex[cityPart]; }
    }
  }

  console.log("❌ No local match");
  console.groupEnd();
  return null;
}

async function geocode(rawAddress) {
  const t0 = performance.now();
  console.group("🗺️ geocode(" + JSON.stringify(rawAddress) + ")");
  console.log("Index sizes — cities:", Object.keys(cityIndex).length, "| FSAs:", Object.keys(fsaIndex).length, "| postals:", Object.keys(postalIndex).length);

  const local = localLookup(rawAddress);
  if (local) {
    const inCa = isInCanada(local.lat, local.lng);
    console.log("Local result:", local.lat.toFixed(6), local.lng.toFixed(6), "| isInCanada:", inCa);
    if (inCa) {
      console.log("✅ Resolved locally in", (performance.now() - t0).toFixed(0) + "ms");
      console.groupEnd();
      return local;
    }
    console.log("⚠️ Local match rejected by isInCanada");
  } else {
    console.log("Local lookup returned null — falling through to external APIs");
  }

  const postal = extractPostal(rawAddress);
  const gcQuery = buildGeocoderCaQuery(rawAddress);
  console.log("geocoder.ca query:", JSON.stringify(gcQuery));

  const gc = await geocoderCaSearch(gcQuery);
  if (gc) {
    const inCa = isInCanada(gc.lat, gc.lng);
    console.log("geocoder.ca isInCanada:", inCa);
    if (inCa) {
      console.log("✅ Resolved via geocoder.ca in", (performance.now() - t0).toFixed(0) + "ms");
      console.groupEnd();
      return gc;
    }
    console.log("⚠️ geocoder.ca result rejected by isInCanada");
  }

  let variants = buildVariants(rawAddress).slice(0, MAX_GEOCODE_TRIES);
  const fallback = postal && FSA_FALLBACK_CITY[postal.fsa];
  if (fallback && !variants.includes(fallback)) variants = [...variants, fallback];
  console.log("Nominatim variants:", variants);

  for (let i = 0; i < variants.length; i++) {
    if (i > 0) { console.log("Waiting", NOMINATIM_DELAY_MS + "ms before next variant..."); await sleep(NOMINATIM_DELAY_MS); }
    const coords = await nominatimSearch(variants[i]);
    if (coords) {
      const inCa = isInCanada(coords.lat, coords.lng);
      const inFsa = postal ? coordsInFsaRegion(coords.lat, coords.lng, postal.fsa) : true;
      console.log("Nominatim check — isInCanada:", inCa, "| inFsaRegion:", inFsa);
      if (!inCa) { console.log("⚠️ Rejected: outside Canada"); continue; }
      if (postal && !inFsa) { console.log("⚠️ Rejected: outside FSA region for", postal.fsa); continue; }
      console.log("✅ Resolved via nominatim in", (performance.now() - t0).toFixed(0) + "ms");
      console.groupEnd();
      return coords;
    }
  }
  console.log("❌ All geocoding attempts failed in", (performance.now() - t0).toFixed(0) + "ms");
  console.groupEnd();
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

function ensureMap() {
  if (leafletMap) return;

  leafletMap = L.map("map", {
    zoomControl: false,
    scrollWheelZoom: true,
  }).setView([43.65, -79.38], 7);

  L.control.zoom({ position: "bottomright" }).addTo(leafletMap);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: 'Leaflet | &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 18,
  }).addTo(leafletMap);
}

function clearMapOverlays() {
  for (const layer of mapOverlays) leafletMap.removeLayer(layer);
  mapOverlays = [];
}

function makeUserIcon() {
  return L.divIcon({
    className: "",
    html: `<div style="position:relative">
      <div class="marker-label">You</div>
      <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:48px;height:48px;border-radius:50%;background:rgba(92,36,52,0.12);pointer-events:none;"></div>
      <svg width="28" height="38" viewBox="0 0 28 38">
        <path d="M14 0C6.27 0 0 6.27 0 14c0 10.5 14 24 14 24s14-13.5 14-24C28 6.27 21.73 0 14 0z" fill="#5C2434"/>
        <circle cx="14" cy="13" r="5" fill="white"/>
      </svg>
    </div>`,
    iconSize: [28, 38],
    iconAnchor: [14, 38],
    popupAnchor: [0, -38],
  });
}

function makeNumberedIcon(num) {
  return L.divIcon({
    className: "",
    html: `<div class="numbered-pin">${num}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function showMap(userLat, userLng, clinicResults, mobileResult) {
  console.group("🗺️ showMap");
  console.log("User pin:", userLat.toFixed(6), userLng.toFixed(6));
  console.log("Mobile result:", mobileResult ? (mobileResult.location.name || mobileResult.location.city) + " (" + mobileResult.location.lat + ", " + mobileResult.location.lng + ") " + mobileResult.distance.toFixed(1) + "km" : "null");
  console.log("Clinic results:", clinicResults ? clinicResults.length + " clinics" : "null");

  ensureMap();
  clearMapOverlays();
  mobileCircleLayer = null;
  clinicMarkerLayers = [];

  const userMarker = L.marker([userLat, userLng], { icon: makeUserIcon(), zIndexOffset: 1000 })
    .addTo(leafletMap);
  mapOverlays.push(userMarker);

  const bounds = [[userLat, userLng]];

  const inArea = mobileResult && mobileResult.distance <= RANGE_IN;

  if (inArea && mobileResult.location.lat && mobileResult.location.lng) {
    const loc = mobileResult.location;
    const circle = L.circle([loc.lat, loc.lng], {
      radius: SERVICE_AREA_RADIUS,
      color: "#5C2434",
      fillColor: "#5C2434",
      fillOpacity: 0.08,
      weight: 2,
      dashArray: "6 4",
    }).addTo(leafletMap);
    mapOverlays.push(circle);
    mobileCircleLayer = circle;

    const cBounds = circle.getBounds();
    bounds.push([cBounds.getNorth(), cBounds.getEast()]);
    bounds.push([cBounds.getSouth(), cBounds.getWest()]);
  }

  if (clinicResults && clinicResults.length) {
    clinicResults.forEach((r, i) => {
      const loc = r.location;
      if (!loc.lat || !loc.lng) return;
      console.log("Clinic pin", i + 1 + ":", (loc.name || loc.city), "(" + loc.lat + ", " + loc.lng + ")", r.distance.toFixed(1) + "km");
      const marker = L.marker([loc.lat, loc.lng], {
        icon: makeNumberedIcon(i + 1),
        zIndexOffset: 500,
      }).addTo(leafletMap);
      mapOverlays.push(marker);
      clinicMarkerLayers.push(marker);
      bounds.push([loc.lat, loc.lng]);
    });
  }

  console.log("Map bounds:", JSON.stringify(bounds));
  console.groupEnd();

  leafletMap.invalidateSize();
  setTimeout(() => {
    leafletMap.fitBounds(L.latLngBounds(bounds).pad(0.2));
  }, 50);
}

// ─────────────────────────────────────────────
// TEXT HELPERS
// ─────────────────────────────────────────────

function titleCase(str) {
  if (!str) return "";
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

// ─────────────────────────────────────────────
// CITY EXTRACTION (for display)
// ─────────────────────────────────────────────

function extractCity(input) {
  const cleaned = input.replace(/\b[A-Za-z]\d[A-Za-z]\s*\d[A-Za-z]\d\b/g, "").trim();
  const parts = cleaned.split(",").map(s => s.trim()).filter(Boolean);

  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    if (expandProvince(last)) {
      const candidate = parts.length > 2 ? parts[parts.length - 2] : parts[0];
      return candidate.replace(/^\d+\s+/, "").trim() || input;
    }
    return parts[0].replace(/^\d+\s+/, "").trim() || input;
  }

  const words = cleaned.split(/\s+/);
  if (words.length >= 2 && expandProvince(words[words.length - 1])) {
    return words.slice(0, -1).join(" ");
  }
  return cleaned || input;
}

// ─────────────────────────────────────────────
// RENDER RESULTS
// ─────────────────────────────────────────────

function getPartnerLabel(loc) {
  const prov = (loc.province || "").toUpperCase();
  if (prov === "BC" || prov === "BRITISH COLUMBIA") return "LifeLabs";
  if (prov === "ON" || prov === "ONTARIO" || prov === "MB" || prov === "MANITOBA") return "Dynacare";
  return null;
}

function renderResults(mobileResult, clinicResults, userCoords, addressText) {
  const card  = document.getElementById("results-card");

  const distKm   = mobileResult ? Math.round(mobileResult.distance) : Infinity;
  const inArea    = distKm <= RANGE_IN;
  const extended  = distKm <= RANGE_EXTENDED;
  const city      = extractCity(addressText);

  if (!inArea && !extended) {
    renderOutOfArea(mobileResult, clinicResults, city, addressText, userCoords);
    return;
  }

  const mobileLoc   = mobileResult.location;
  const mobileCity  = mobileLoc.city || mobileLoc.name;
  const bannerClass = inArea ? "in-area" : "extended";
  const bannerIcon  = inArea
    ? `<svg viewBox="0 0 24 24"><polyline points="20,6 9,17 4,12"/></svg>`
    : `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;

  const bannerTitle = inArea
    ? `Yes, we reach ${city}`
    : `Extended area — ${city}`;

  const mobileStatus = inArea ? "AVAILABLE" : "EXTENDED AREA";
  const mobileDesc = inArea
    ? `Your address is inside our mobile coverage zone (≈ ${distKm} km radius). A phlebotomist will travel to your home or office.`
    : `Your address is in our extended service zone (${distKm} km away). Additional travel fees may apply and availability is limited — contact us to confirm.`;
  const extendedClinicNudge = (!inArea && clinicResults && clinicResults.length)
    ? `<p style="margin-top:10px;font-size:0.8rem;color:var(--ink-mid);">For guaranteed same-week service, consider one of our <a href="#" data-switch-tab="clinic" style="color:var(--maroon);font-weight:600;text-decoration:none;">partner clinics →</a></p>`
    : "";

  const clinicItemsHtml = (clinicResults || []).map((r, i) => {
    const loc = r.location;
    const km  = r.distance < 10 ? r.distance.toFixed(1) : Math.round(r.distance);
    const addr = [titleCase(loc.address), titleCase(loc.city)].filter(Boolean).join(", ");
    const distClass = r.distance <= 10 ? "dist-close" : r.distance <= 50 ? "dist-mid" : "dist-far";
    return `<div class="rc-clinic-item">
      <div class="rc-clinic-rank">${i + 1}</div>
      <div>
        <div class="rc-clinic-name">${loc.name}${(() => { const p = getPartnerLabel(loc); return p ? ` <span style="font-weight:400;color:var(--muted);font-size:0.75rem">· ${p}</span>` : ""; })()}</div>
        <div class="rc-clinic-addr">${addr}</div>
      </div>
      <div class="rc-clinic-dist ${distClass}">${km} <span>km</span></div>
    </div>`;
  }).join("");

  const clinicCount = clinicResults ? clinicResults.length : 0;

  card.innerHTML = `
    <div class="rc-banner ${bannerClass}">
      <div class="rc-banner-badge">${bannerIcon}</div>
      <div class="rc-banner-text">
        <h2>${bannerTitle}</h2>
        <p>${addressText}</p>
      </div>
    </div>
    <div class="rc-tabs" id="rc-tabs">
      <button class="rc-tab active" data-tab="all">All options</button>
      <button class="rc-tab" data-tab="mobile">Mobile</button>
      <button class="rc-tab" data-tab="clinic">In-clinic</button>
    </div>
    <div class="rc-content">
      <div class="rc-mobile-section" data-section="mobile">
        <div class="rc-section-header">
          <svg class="rc-section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18.01"/></svg>
          MOBILE VISIT &middot; ${mobileStatus}
        </div>
        <div class="rc-mobile-card">
          <h3>${mobileCity} service area</h3>
          <p>${mobileDesc}</p>
          ${extendedClinicNudge}
        </div>
      </div>
      ${clinicCount ? `<div class="rc-clinic-section" data-section="clinic">
        <div class="rc-section-header">
          <div class="rc-section-dot" style="background:var(--maroon)"></div>
          ${clinicCount} PARTNER CLINIC${clinicCount > 1 ? "S" : ""} IN YOUR REGION
        </div>
        <div class="rc-clinic-list">${clinicItemsHtml}</div>
      </div>` : ""}
      <div style="padding:14px 16px;background:var(--cream);border-radius:var(--r);margin-top:16px;margin-bottom:16px;text-align:center;">
        <p style="font-size:0.82rem;color:var(--ink-mid);margin-bottom:10px;">${inArea ? "Ready to get started?" : "Coverage may vary in your area"}</p>
        <a href="https://niahealth.ca/plans" style="display:inline-block;padding:10px 24px;background:var(--maroon);color:white;border-radius:var(--r-pill);font-size:0.85rem;font-weight:600;text-decoration:none;font-family:'Instrument Sans',sans-serif;">See plans →</a>
      </div>
      <div class="rc-disclaimer">
        <span>ⓘ</span>
        <span>Coverage radius is based on straight-line distance and may not reflect actual driving routes. Areas separated by water or with limited road access may be outside practical range — text us at <a href="sms:16479310600">+1 (647) 931-0600</a> to confirm before booking.</span>
      </div>
    </div>
  `;

  card.classList.add("visible");
  injectMobileHandle(card);

  initTabs();
  showMap(userCoords.lat, userCoords.lng, clinicResults, mobileResult);
}

function renderOutOfArea(mobileResult, clinicResults, city, addressText, userCoords) {
  const card = document.getElementById("results-card");

  const nearbyClinics = (clinicResults || []).filter(r => r.distance <= 200);

  if (nearbyClinics.length > 0) {
    const clinicItemsHtml = nearbyClinics.map((r, i) => {
      const loc = r.location;
      const km  = r.distance < 10 ? r.distance.toFixed(1) : Math.round(r.distance);
      const addr = [titleCase(loc.address), titleCase(loc.city)].filter(Boolean).join(", ");
      const distClass = r.distance <= 10 ? "dist-close" : r.distance <= 50 ? "dist-mid" : "dist-far";
      return `<div class="rc-clinic-item">
        <div class="rc-clinic-rank">${i + 1}</div>
        <div>
          <div class="rc-clinic-name">${loc.name}${(() => { const p = getPartnerLabel(loc); return p ? ` <span style="font-weight:400;color:var(--muted);font-size:0.75rem">· ${p}</span>` : ""; })()}</div>
          <div class="rc-clinic-addr">${addr}</div>
        </div>
        <div class="rc-clinic-dist ${distClass}">${km} <span>km</span></div>
      </div>`;
    }).join("");

    const clinicCount = nearbyClinics.length;

    card.innerHTML = `
      <div class="rc-banner clinic-only">
        <div class="rc-banner-badge">
          <svg viewBox="0 0 24 24"><polyline points="20,6 9,17 4,12"/></svg>
        </div>
        <div class="rc-banner-text">
          <h2>In-clinic available — ${city}</h2>
          <p>${addressText}</p>
        </div>
      </div>
      <div class="rc-content">
        <div style="padding:10px 16px 6px;background:var(--cream);border-radius:var(--r);margin-bottom:14px;font-size:0.8rem;color:var(--ink-mid);display:flex;align-items:center;gap:8px;">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;opacity:0.6"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          At-home mobile visits aren't available in your area yet — but you can get your labs done at a nearby partner clinic.
        </div>
        <div class="rc-clinic-section" data-section="clinic">
          <div class="rc-section-header">
            <div class="rc-section-dot" style="background:var(--maroon)"></div>
            ${clinicCount} PARTNER CLINIC${clinicCount > 1 ? "S" : ""} IN YOUR REGION
          </div>
          <div class="rc-clinic-list">${clinicItemsHtml}</div>
        </div>
        <div style="padding:14px 16px;background:var(--cream);border-radius:var(--r);margin-top:16px;margin-bottom:16px;text-align:center;">
          <p style="font-size:0.82rem;color:var(--ink-mid);margin-bottom:10px;">Ready to get started?</p>
          <a href="https://niahealth.ca/plans" style="display:inline-block;padding:10px 24px;background:var(--maroon);color:white;border-radius:var(--r-pill);font-size:0.85rem;font-weight:600;text-decoration:none;font-family:'Instrument Sans',sans-serif;">See plans →</a>
        </div>
        <div class="rc-disclaimer">
          <span>ⓘ</span>
          <span>Clinic availability may change — for confirmation before booking, text us at <a href="sms:16479310600">+1 (647) 931-0600</a>.</span>
        </div>
      </div>
    `;

    card.classList.add("visible");
    injectMobileHandle(card);
    showMap(userCoords.lat, userCoords.lng, nearbyClinics, null);
    return;
  }

  let nearestText = "";
  if (mobileResult && mobileResult.distance <= 500) {
    const loc      = mobileResult.location;
    const cityName = loc.city || loc.name;
    const provAbbr = loc.province || "";
    const km       = Math.round(mobileResult.distance).toLocaleString();
    nearestText = `Nearest mobile coverage: ${cityName}, ${provAbbr}, ${km} km away.`;
  }

  card.innerHTML = `
    <div class="rc-out-of-area">
      <div class="rc-oor-badge"><div class="dot"></div> OUTSIDE SERVICE AREA</div>
      <h2 class="rc-oor-heading">Not yet in <em>${city}</em></h2>
      <p class="rc-oor-sub">${nearestText} We'll let you know when we expand.</p>
      <div style="margin-bottom:16px;">
        <a href="sms:16479310600?body=Hi, I'm interested in NiaHealth coverage in ${city}" style="display:inline-block;padding:10px 20px;background:var(--ink);color:white;border-radius:var(--r-pill);font-size:0.85rem;font-weight:600;text-decoration:none;font-family:'Instrument Sans',sans-serif;">Text us about ${city} →</a>
        <p style="font-size:0.78rem;color:var(--muted);margin-top:10px;">We're expanding — we'll let you know when we reach your area.</p>
      </div>
      <div class="rc-disclaimer">
        <span>ⓘ</span>
        <span>Mobile coverage is approximate and may change — for confirmation before booking, text us at <a href="sms:16479310600">+1 (647) 931-0600</a>.</span>
      </div>
    </div>
  `;

  card.classList.add("visible");
  injectMobileHandle(card);
  showMap(userCoords.lat, userCoords.lng, null, null);
}

// ─────────────────────────────────────────────
// TABS
// ─────────────────────────────────────────────

function initTabs() {
  const tabs = document.querySelectorAll(".rc-tab");

  function activateTab(tabName) {
    currentTab = tabName;
    tabs.forEach(t => t.classList.toggle("active", t.dataset.tab === tabName));

    const mobileSec = document.querySelector('[data-section="mobile"]');
    const clinicSec = document.querySelector('[data-section="clinic"]');

    if (mobileSec) mobileSec.style.display = (currentTab === "all" || currentTab === "mobile") ? "" : "none";
    if (clinicSec) clinicSec.style.display = (currentTab === "all" || currentTab === "clinic") ? "" : "none";

    if (mobileCircleLayer) {
      if (currentTab === "all" || currentTab === "mobile") {
        leafletMap.addLayer(mobileCircleLayer);
      } else {
        leafletMap.removeLayer(mobileCircleLayer);
      }
    }
    clinicMarkerLayers.forEach(marker => {
      if (currentTab === "all" || currentTab === "clinic") {
        leafletMap.addLayer(marker);
      } else {
        leafletMap.removeLayer(marker);
      }
    });
  }

  tabs.forEach(tab => {
    tab.addEventListener("click", () => activateTab(tab.dataset.tab));
  });

  // Allow any element with data-switch-tab inside the results card to switch tabs
  const card = document.getElementById("results-card");
  if (card) {
    card.addEventListener("click", (e) => {
      const link = e.target.closest("[data-switch-tab]");
      if (!link) return;
      e.preventDefault();
      activateTab(link.dataset.switchTab);
      const targetTab = document.querySelector(`[data-tab="${link.dataset.switchTab}"]`);
      if (targetTab) targetTab.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }
}

// ─────────────────────────────────────────────
// GEOLOCATION
// ─────────────────────────────────────────────

function handleGeolocate() {
  if (!navigator.geolocation) return;
  const gpsBtn = document.getElementById("gps-btn");
  const addressEl = document.getElementById("address");
  const btn = document.getElementById("submit-btn");
  const errorEl = document.getElementById("error");
  const loadBar = document.getElementById("loading-bar");
  const card = document.getElementById("results-card");

  gpsBtn.classList.add("loading");
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      gpsBtn.classList.remove("loading");
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      addressEl.value = "My location";
      document.getElementById("clear-btn")?.classList.add("visible");

      card.classList.remove("visible");
      card.innerHTML = "";
      errorEl.classList.remove("visible");
      loadBar.classList.add("visible");
      btn.disabled = true;
      btn.innerHTML = `<svg class="spin" viewBox="0 0 24 24" style="width:16px;height:16px"><path d="M21 12a9 9 0 1 1-6.219-8.56" stroke="white" fill="none" stroke-width="2.5" stroke-linecap="round"/></svg> Searching...`;
      document.body.classList.add("searched");
      document.getElementById("autocomplete-list")?.classList.remove("visible");

      if (dataReady) await dataReady;

      try {
        const resp = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`, { headers: { "Accept-Language": "en" } });
        const data = await resp.json();
        if (data.display_name) addressEl.value = data.display_name.split(",").slice(0, 3).join(",").trim();
      } catch (e) {}

      const userCoords = { lat, lng };
      const mobile = findNearest(lat, lng, mobileLocations);
      const clinics = findNearestClinics(lat, lng, clinicLocations, 5);
      renderResults(mobile, clinics, userCoords, addressEl.value);

      loadBar.classList.remove("visible");
      btn.disabled = false;
      btn.innerHTML = `Check <span class="arrow">&rarr;</span>`;
    },
    (err) => {
      gpsBtn.classList.remove("loading");
      errorEl.textContent = "Location access denied. Please type your address instead.";
      errorEl.classList.add("visible");
    },
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

// ─────────────────────────────────────────────
// SUBMIT
// ─────────────────────────────────────────────

async function handleSubmit() {
  const addressEl = document.getElementById("address");
  const address   = addressEl.value.trim();
  if (!address) { addressEl.focus(); return; }

  if (dataReady) await dataReady;

  const btn     = document.getElementById("submit-btn");
  const errorEl = document.getElementById("error");
  const loadBar = document.getElementById("loading-bar");
  const card    = document.getElementById("results-card");

  card.classList.remove("visible");
  card.innerHTML = "";
  errorEl.classList.remove("visible");
  loadBar.classList.add("visible");
  btn.disabled = true;
  btn.innerHTML = `<svg class="spin" viewBox="0 0 24 24" style="width:16px;height:16px"><path d="M21 12a9 9 0 1 1-6.219-8.56" stroke="white" fill="none" stroke-width="2.5" stroke-linecap="round"/></svg> Searching...`;

  document.body.classList.add("searched");
  document.getElementById("autocomplete-list")?.classList.remove("visible");
  const clearBtnEl = document.getElementById("clear-btn");
  if (clearBtnEl) clearBtnEl.classList.add("visible");

  try {
    const submitT0 = performance.now();
    console.group("🚀 handleSubmit(" + JSON.stringify(address) + ")");
    console.log("Data loaded:", mobileLocations.length, "mobile,", clinicLocations.length, "clinic");

    if (!mobileLocations.length && !clinicLocations.length) {
      throw new Error("Location data not loaded. Please refresh.");
    }

    const coords = await geocode(address);
    console.log("Geocode result:", coords);

    if (!coords) {
      console.log("❌ No coords — showing error");
      console.groupEnd();
      errorEl.textContent = "Couldn't find that Canadian location. Try a city name, postal code (e.g. V3T 1Z2), or full address.";
      errorEl.classList.add("visible");
      return;
    }

    lastSearchCoords = coords;

    const mobileResult  = findNearestIn(coords.lat, coords.lng, mobileLocations);
    const clinicResults = findNearestN(coords.lat, coords.lng, clinicLocations, 3);

    console.log("Nearest mobile:", mobileResult ? (mobileResult.location.name || mobileResult.location.city) + " @ " + mobileResult.distance.toFixed(1) + "km (" + mobileResult.location.lat + ", " + mobileResult.location.lng + ")" : "none");
    console.log("Nearest clinics:", (clinicResults || []).map(r => (r.location.name || r.location.city) + " @ " + r.distance.toFixed(1) + "km").join(" | "));
    console.log("Total handleSubmit:", (performance.now() - submitT0).toFixed(0) + "ms");
    console.groupEnd();

    renderResults(mobileResult, clinicResults, coords, address);

  } catch (err) {
    console.error(err);
    errorEl.textContent = err.message || "Something went wrong. Please try again.";
    errorEl.classList.add("visible");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `Check <span class="arrow">&rarr;</span>`;
    loadBar.classList.remove("visible");
  }
}

// ─────────────────────────────────────────────
// AUTOCOMPLETE
// ─────────────────────────────────────────────

function getAutocompleteSuggestions(query, limit = 6) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  if (/^[a-z]\d[a-z]\s*\d?[a-z]?\d?$/i.test(q)) return [];

  const alphaOnly = q.replace(/[0-9]+/g, "").replace(/\s+/g, " ").trim();
  const searchTerms = alphaOnly.length >= 2 ? alphaOnly.split(/\s+/) : [q];
  const lastWord = searchTerms[searchTerms.length - 1];
  if (lastWord.length < 2) return [];

  const results = [];
  const seen = new Set();
  for (const key of Object.keys(cityIndex)) {
    if (key.includes("|")) continue;
    if (key.startsWith(lastWord) || key.includes(" " + lastWord)) {
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = cityIndex[key];
      results.push({ city: titleCase(key), province: entry.province, lat: entry.lat, lng: entry.lng });
      if (results.length >= limit) break;
    }
  }
  if (results.length < limit) {
    for (const key of Object.keys(cityIndex)) {
      if (key.includes("|") || seen.has(key)) continue;
      if (key.includes(lastWord)) {
        seen.add(key);
        const entry = cityIndex[key];
        results.push({ city: titleCase(key), province: entry.province, lat: entry.lat, lng: entry.lng });
        if (results.length >= limit) break;
      }
    }
  }
  return results;
}

function fetchNominatimSuggestions(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query + ", Canada")}&format=json&countrycodes=ca&limit=4&addressdetails=1`;
  return fetch(url, { headers: { "Accept-Language": "en" } })
    .then(r => r.json())
    .then(results => results.map(r => {
      const addr = r.address || {};
      const city = addr.city || addr.town || addr.village || addr.hamlet || "";
      const prov = addr.state || "";
      const road = addr.road || "";
      const num  = addr.house_number || "";
      const label = road ? `${num ? num + " " : ""}${road}, ${city}` : r.display_name.split(",").slice(0, 2).join(",");
      return { label: label.trim(), province: prov, displayName: r.display_name };
    }))
    .catch(() => []);
}

function setupAutocomplete() {
  const input = document.getElementById("address");
  const list = document.getElementById("autocomplete-list");
  if (!input || !list) return;
  let activeIdx = -1;
  let allSuggestions = [];
  let lastQuery = "";

  function render() {
    const cityItems = allSuggestions.filter(s => s.type === "city");
    const addressItems = allSuggestions.filter(s => s.type === "address");
    const showBothGroups = cityItems.length > 0 && addressItems.length > 0;

    const cityHtml = cityItems.map(s => {
      const i = allSuggestions.indexOf(s);
      return `<li data-idx="${i}">${s.city}<span class="ac-prov">${s.province}</span></li>`;
    }).join("");

    const addressHtml = addressItems.map(s => {
      const i = allSuggestions.indexOf(s);
      return `<li data-idx="${i}" class="ac-address">${s.label}<span class="ac-prov">${s.province}</span></li>`;
    }).join("");

    let html = "";
    if (showBothGroups) {
      html += `<li class="ac-group-header">Cities</li>${cityHtml}`;
      html += `<li class="ac-group-header">Addresses</li>${addressHtml}`;
    } else {
      html = cityHtml + addressHtml;
    }

    list.innerHTML = html;
    list.classList.toggle("visible", allSuggestions.length > 0);
    activeIdx = -1;
  }

  function hide() { list.classList.remove("visible"); list.innerHTML = ""; activeIdx = -1; allSuggestions = []; }

  function select(s) {
    input.value = s.type === "city" ? s.city + ", " + s.province : s.displayName || s.label;
    hide();
    handleSubmit();
  }

  input.addEventListener("input", () => {
    const q = input.value.trim();
    lastQuery = q;

    const citySuggestions = getAutocompleteSuggestions(q).map(s => ({ ...s, type: "city" }));
    allSuggestions = citySuggestions;
    render();

    if (q.length >= 4) {
      (async () => {
        const nomResults = await fetchNominatimSuggestions(q);
        if (input.value.trim() !== q) return;
        const addressItems = nomResults.map(r => ({ ...r, type: "address" }));
        const cityPart = getAutocompleteSuggestions(q).map(s => ({ ...s, type: "city" }));
        allSuggestions = [...cityPart, ...addressItems];
        render();
      })();
    }
  });

  input.addEventListener("keydown", (e) => {
    const items = list.querySelectorAll("li[data-idx]");
    if (!items.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIdx = Math.min(activeIdx + 1, items.length - 1);
      items.forEach((li, i) => li.classList.toggle("active", i === activeIdx));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIdx = Math.max(activeIdx - 1, 0);
      items.forEach((li, i) => li.classList.toggle("active", i === activeIdx));
    } else if (e.key === "Enter" && activeIdx >= 0) {
      e.preventDefault();
      const idx = parseInt(items[activeIdx]?.dataset.idx);
      if (!isNaN(idx) && allSuggestions[idx]) select(allSuggestions[idx]);
    } else if (e.key === "Escape") { hide(); }
  });

  list.addEventListener("click", (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    const idx = parseInt(li.dataset.idx);
    if (allSuggestions[idx]) select(allSuggestions[idx]);
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-bar") && !e.target.closest(".autocomplete-list")) hide();
  });
}

// ─────────────────────────────────────────────
// MOBILE CARD COLLAPSE
// ─────────────────────────────────────────────

function injectMobileHandle(card) {
  if (window.innerWidth > 768) return;
  if (card.querySelector(".rc-drag-handle")) return;
  const handle = document.createElement("div");
  handle.className = "rc-drag-handle";
  handle.innerHTML = '<span class="rc-handle-label">Tap to expand</span>';
  card.insertBefore(handle, card.firstChild);
  card.classList.add("collapsed");
  handle.addEventListener("click", () => {
    const willExpand = card.classList.contains("collapsed");
    card.classList.toggle("collapsed");
    handle.querySelector(".rc-handle-label").textContent = willExpand ? "Tap to minimize" : "Tap to expand";
  });
}

// ─────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  dataReady = init();
  ensureMap();

  document.getElementById("submit-btn").addEventListener("click", () => handleSubmit());
  document.getElementById("gps-btn")?.addEventListener("click", () => handleGeolocate());
  document.getElementById("address").addEventListener("keydown", e => {
    if (e.key === "Enter") {
      const acList = document.getElementById("autocomplete-list");
      if (acList?.classList.contains("visible") && acList.querySelector("li.active")) return;
      handleSubmit();
    }
  });
  document.getElementById("hero")?.addEventListener("click", () => {
    document.body.classList.remove("searched");
    document.getElementById("results-card").classList.remove("visible");
    document.getElementById("results-card").innerHTML = "";
    document.getElementById("error").classList.remove("visible");
    document.getElementById("address").value = "";
    document.getElementById("clear-btn")?.classList.remove("visible");
    clearMapOverlays();
    leafletMap.setView([43.65, -79.38], 7);
  });
  const clearBtn = document.getElementById("clear-btn");
  const addressInput = document.getElementById("address");
  addressInput.addEventListener("input", () => {
    clearBtn.classList.toggle("visible", addressInput.value.length > 0);
  });
  clearBtn.addEventListener("click", () => {
    addressInput.value = "";
    addressInput.focus();
    clearBtn.classList.remove("visible");
    document.getElementById("autocomplete-list")?.classList.remove("visible");
  });
  setupAutocomplete();
});
