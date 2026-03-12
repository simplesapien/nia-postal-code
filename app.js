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

async function geocode(address) {
  const url =
    "https://nominatim.openstreetmap.org/search?" +
    new URLSearchParams({ q: address, format: "json", limit: "1" });
  const res = await fetch(url, {
    headers: { "User-Agent": "PhlebotomistRangeChecker/1.0" },
  });
  const data = await res.json();
  if (!data.length) return null;
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
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
