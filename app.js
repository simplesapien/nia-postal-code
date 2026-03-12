let serviceLocations = [];

async function init() {
  const res = await fetch("locations.json");
  serviceLocations = await res.json();
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function findNearest(lat, lng) {
  let best = null;
  let bestDist = Infinity;
  for (const loc of serviceLocations) {
    const d = haversineKm(lat, lng, loc.lat, loc.lng);
    if (d < bestDist) {
      bestDist = d;
      best = loc;
    }
  }
  return { location: best, distance: bestDist };
}

const POSTAL_RE = /[A-Za-z]\d[A-Za-z]\s*\d[A-Za-z]\d/;

async function nominatimSearch(query) {
  const url =
    "https://nominatim.openstreetmap.org/search?" +
    new URLSearchParams({
      q: query,
      format: "json",
      limit: "1",
      countrycodes: "ca",
    });
  const res = await fetch(url, {
    headers: { "User-Agent": "PhlebotomistRangeChecker/1.0" },
  });
  const data = await res.json();
  if (!data.length) return null;
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
}

function buildSearchVariants(raw) {
  const input = raw.trim();
  const variants = [];

  // 1) Full input as-is
  variants.push(input + ", Canada");

  // 2) Strip postal code from end/anywhere and try remaining text
  const withoutPostal = input.replace(POSTAL_RE, "").replace(/[,\s]+$/, "").trim();
  if (withoutPostal && withoutPostal !== input) {
    variants.push(withoutPostal + ", Canada");
  }

  // 3) If it's just a bare postal code (with or without space), format and try
  const compact = input.replace(/\s/g, "");
  if (/^[A-Za-z]\d[A-Za-z]\d[A-Za-z]\d$/.test(compact)) {
    const formatted = (compact.slice(0, 3) + " " + compact.slice(3)).toUpperCase();
    variants.push(formatted + ", Canada");
  }

  // 4) Try extracting just city-like parts (after first comma or the whole thing)
  const parts = input.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    // "123 Main St, Whitehorse, YT ..." → try "Whitehorse, YT, Canada"
    const cityOnward = parts.slice(1).join(", ").replace(POSTAL_RE, "").replace(/[,\s]+$/, "").trim();
    if (cityOnward) variants.push(cityOnward + ", Canada");
  }

  // 5) Raw input without Canada (last resort)
  variants.push(input);

  // Deduplicate while preserving order
  return [...new Set(variants)];
}

async function geocode(rawAddress) {
  const variants = buildSearchVariants(rawAddress);
  for (const query of variants) {
    const coords = await nominatimSearch(query);
    if (coords) return coords;
  }
  return null;
}

function renderResult(nearest) {
  const distKm = Math.round(nearest.distance);
  const resultEl = document.getElementById("result");
  const cardEl = document.getElementById("result-card");

  const loc = nearest.location;
  let icon, title, detail, cls;

  if (distKm <= 100) {
    icon = "check_circle";
    title = "You're within service range!";
    detail = `Your address is approximately <strong>${distKm} km</strong> from our nearest phlebotomist in <strong>${loc.name}, ${loc.province}</strong>. Standard service rates apply.`;
    cls = "in-range";
  } else if (distKm <= 200) {
    icon = "info";
    title = "You may be in an extended service area";
    detail = `Your address is approximately <strong>${distKm} km</strong> from our nearest phlebotomist in <strong>${loc.name}, ${loc.province}</strong>. Additional travel fees may apply.`;
    cls = "extended";
  } else {
    icon = "warning";
    title = "Service availability is uncertain";
    detail = `Your address is approximately <strong>${distKm} km</strong> from our nearest phlebotomist in <strong>${loc.name}, ${loc.province}</strong>. We may not be able to service this area. Please contact us directly.`;
    cls = "out-of-range";
  }

  cardEl.className = "result-card " + cls;
  cardEl.innerHTML = `
    <span class="material-symbols-rounded result-icon">${icon}</span>
    <h2>${title}</h2>
    <p>${detail}</p>
  `;
  resultEl.classList.add("visible");
}

async function handleSubmit(e) {
  e.preventDefault();

  const address = document.getElementById("address").value.trim();
  if (!address) return;

  const btn = document.getElementById("submit-btn");
  const resultEl = document.getElementById("result");
  const errorEl = document.getElementById("error");

  btn.disabled = true;
  btn.innerHTML =
    '<span class="material-symbols-rounded spin">progress_activity</span> Checking…';
  resultEl.classList.remove("visible");
  errorEl.classList.remove("visible");

  try {
    const coords = await geocode(address);
    if (!coords) {
      errorEl.textContent =
        "Could not find that address. Please try a more specific address or include the city and province/state.";
      errorEl.classList.add("visible");
      return;
    }
    const nearest = findNearest(coords.lat, coords.lng);
    renderResult(nearest);
  } catch {
    errorEl.textContent =
      "Something went wrong while looking up the address. Please try again.";
    errorEl.classList.add("visible");
  } finally {
    btn.disabled = false;
    btn.innerHTML =
      '<span class="material-symbols-rounded">search</span> Check Service Area';
  }
}

document.addEventListener("DOMContentLoaded", () => {
  init();
  document.getElementById("check-form").addEventListener("submit", handleSubmit);
});
