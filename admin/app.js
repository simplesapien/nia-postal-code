// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────

const OWNER = "simplesapien";
const REPO  = "nia-postal-code";
const CSV_PATH = "data/nia-coverage-master.csv";
const API = "https://api.github.com";
const COLUMNS = ["Section","Name","Address","City","Province","Postal Code",
                 "Latitude","Longitude","Type","Google Maps Link"];
const PROVINCES = ["AB","BC","MB","NB","NL","NS","NT","NU","ON","PE","QC","SK","YT"];
const NOMINATIM_DELAY = 1200;

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────

let token   = "";
let sha     = "";
let rows    = [];
let dirty   = new Set();
let filter  = "";

// ─────────────────────────────────────────────
// DOM
// ─────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const loginWrap  = $("login-wrap");
const appEl      = $("app");
const tokenInput = $("token-input");
const loginBtn   = $("login-btn");
const loginError = $("login-error");
const tableBody  = $("table-body");
const searchInput = $("search-input");
const rowCount   = $("row-count");
const statusEl   = $("status");
const toastEl    = $("toast");
const saveBtn    = $("save-btn");
const geocodeBtn = $("geocode-btn");
const logoutBtn  = $("logout-btn");

// ─────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────

function showApp() {
  loginWrap.style.display = "none";
  appEl.classList.add("visible");
}

async function tryLogin(t) {
  token = t;
  try {
    const res = await ghGet(`repos/${OWNER}/${REPO}`);
    if (!res.ok) throw new Error("bad token");
    localStorage.setItem("nia-admin-token", t);
    showApp();
    await loadCSV();
  } catch {
    token = "";
    loginError.classList.add("visible");
  }
}

loginBtn.addEventListener("click", () => {
  loginError.classList.remove("visible");
  const t = tokenInput.value.trim();
  if (t) tryLogin(t);
});

tokenInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") loginBtn.click();
});

logoutBtn.addEventListener("click", () => {
  localStorage.removeItem("nia-admin-token");
  location.reload();
});

// Auto-login from stored token
const saved = localStorage.getItem("nia-admin-token");
if (saved) tryLogin(saved);

// ─────────────────────────────────────────────
// GITHUB API
// ─────────────────────────────────────────────

function ghHeaders() {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function ghGet(path) {
  return fetch(`${API}/${path}`, { headers: ghHeaders() });
}

function ghPut(path, body) {
  return fetch(`${API}/${path}`, {
    method: "PUT",
    headers: { ...ghHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ─────────────────────────────────────────────
// CSV PARSE / SERIALIZE
// ─────────────────────────────────────────────

function parseCSV(text) {
  const lines = text.split("\n").filter(l => l.trim());
  if (!lines.length) return [];
  const result = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]);
    const row = {};
    COLUMNS.forEach((col, j) => row[col] = (vals[j] || "").trim());
    result.push(row);
  }
  return result;
}

function parseCSVLine(line) {
  const vals = [];
  let cur = "", inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuote = false;
      else cur += ch;
    } else {
      if (ch === '"') inQuote = true;
      else if (ch === ',') { vals.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  vals.push(cur);
  return vals;
}

function serializeCSV(rows) {
  const header = COLUMNS.join(",");
  const body = rows.map(r => COLUMNS.map(c => {
    const v = r[c] || "";
    return v.includes(",") || v.includes('"') || v.includes("\n")
      ? '"' + v.replace(/"/g, '""') + '"' : v;
  }).join(",")).join("\n");
  return header + "\n" + body + "\n";
}

// ─────────────────────────────────────────────
// LOAD
// ─────────────────────────────────────────────

async function loadCSV() {
  setStatus("Loading...", "saving");
  try {
    const res = await ghGet(`repos/${OWNER}/${REPO}/contents/${CSV_PATH}`);
    if (!res.ok) throw new Error("Failed to load CSV");
    const data = await res.json();
    sha = data.sha;
    const text = atob(data.content.replace(/\n/g, ""));
    rows = parseCSV(text);
    dirty.clear();
    render();
    setStatus(`${rows.length} rows loaded`, "success");
    setTimeout(() => setStatus(""), 2000);
  } catch (e) {
    setStatus("Load failed: " + e.message, "error");
  }
}

// ─────────────────────────────────────────────
// SAVE
// ─────────────────────────────────────────────

saveBtn.addEventListener("click", save);

async function save() {
  if (!confirm("Save changes and publish? The site will update within a minute.")) return;
  setStatus("Saving...", "saving");
  saveBtn.disabled = true;

  try {
    const csv = serializeCSV(rows);
    const encoded = btoa(unescape(encodeURIComponent(csv)));
    const res = await ghPut(`repos/${OWNER}/${REPO}/contents/${CSV_PATH}`, {
      message: "Update location data via admin UI",
      content: encoded,
      sha,
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || "Save failed");
    }
    const result = await res.json();
    sha = result.content.sha;
    dirty.clear();
    render();
    setStatus("Published!", "success");
    toast("Changes saved and published.");
    setTimeout(() => setStatus(""), 3000);
  } catch (e) {
    setStatus("Save failed: " + e.message, "error");
    toast("Save failed: " + e.message, true);
  } finally {
    saveBtn.disabled = false;
  }
}

// ─────────────────────────────────────────────
// GEOCODING
// ─────────────────────────────────────────────

function isInCanada(lat, lng) {
  return lat >= 41.7 && lat <= 83.2 && lng >= -141.1 && lng <= -52.5;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function geocoderCa(locate) {
  try {
    const res = await fetch(
      "https://geocoder.ca/?locate=" + encodeURIComponent(locate) + "&geoit=xml&json=1",
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error || !data.latt || !data.longt) return null;
    const lat = parseFloat(data.latt), lng = parseFloat(data.longt);
    if (!isInCanada(lat, lng)) return null;
    return { lat: lat.toFixed(6), lng: lng.toFixed(6) };
  } catch { return null; }
}

async function nominatim(query) {
  const url = "https://nominatim.openstreetmap.org/search?" + new URLSearchParams({
    q: query, format: "json", limit: "1", countrycodes: "ca",
  });
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "NiaHealthAdmin/1.0" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.length) return null;
    const lat = parseFloat(data[0].lat), lng = parseFloat(data[0].lon);
    if (!isInCanada(lat, lng)) return null;
    return { lat: lat.toFixed(6), lng: lng.toFixed(6) };
  } catch { return null; }
}

async function geocodeRow(row) {
  const pc   = (row["Postal Code"] || "").trim();
  const addr = (row["Address"] || "").trim();
  const city = (row["City"] || row["Name"] || "").trim();
  const prov = (row["Province"] || "").trim();

  if (pc) {
    const gc = await geocoderCa(pc);
    if (gc) return gc;
  }

  if (addr && city && prov) {
    await sleep(NOMINATIM_DELAY);
    const r = await nominatim(`${addr}, ${city}, ${prov}, Canada`);
    if (r) return r;
  }

  if (city && prov) {
    await sleep(NOMINATIM_DELAY);
    const r = await nominatim(`${city}, ${prov}, Canada`);
    if (r) return r;
  }

  return null;
}

function needsGeocode(row) {
  if (!(row["Type"] || "").trim()) return false;
  if (!(row["Name"] || "").trim()) return false;
  const lat = parseFloat(row["Latitude"]);
  const lng = parseFloat(row["Longitude"]);
  if (isNaN(lat) || isNaN(lng)) return true;
  if (!isInCanada(lat, lng)) return true;
  return false;
}

geocodeBtn.addEventListener("click", async () => {
  const targets = rows.filter(needsGeocode);
  if (!targets.length) { toast("All rows already have valid coordinates."); return; }
  if (!confirm(`Geocode ${targets.length} row(s) with missing or bad coordinates?`)) return;

  geocodeBtn.disabled = true;
  let fixed = 0, failed = 0;

  for (let i = 0; i < targets.length; i++) {
    const row = targets[i];
    const label = [row["Name"], row["City"], row["Province"]].filter(Boolean).join(", ");
    setStatus(`Geocoding ${i + 1}/${targets.length}: ${label}...`, "saving");

    const result = await geocodeRow(row);
    if (result) {
      row["Latitude"]  = result.lat;
      row["Longitude"] = result.lng;
      row["Google Maps Link"] = `https://maps.google.com/?q=${result.lat},${result.lng}`;
      dirty.add(rows.indexOf(row));
      fixed++;
    } else {
      failed++;
    }
  }

  render();
  geocodeBtn.disabled = false;
  const msg = `Geocoded ${fixed} row(s)` + (failed ? `, ${failed} failed` : "");
  setStatus(msg, failed ? "error" : "success");
  toast(msg);
  setTimeout(() => setStatus(""), 4000);
});

async function geocodeSingle(idx) {
  const row = rows[idx];
  const btn = document.querySelector(`[data-geo="${idx}"]`);
  if (btn) btn.textContent = "...";

  const result = await geocodeRow(row);
  if (result) {
    row["Latitude"]  = result.lat;
    row["Longitude"] = result.lng;
    row["Google Maps Link"] = `https://maps.google.com/?q=${result.lat},${result.lng}`;
    dirty.add(idx);
    render();
    toast("Geocoded: " + (row["Name"] || "row"));
  } else {
    toast("Geocoding failed for: " + (row["Name"] || "row"), true);
    if (btn) btn.textContent = "Geo";
  }
}

// ─────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────

function render() {
  const frag = document.createDocumentFragment();
  const q = filter.toLowerCase();
  let visible = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const type = (row["Type"] || "").trim();
    const name = (row["Name"] || "").trim();

    // Section header rows
    if (!type && !name && (row["Section"] || "").trim()) {
      const tr = document.createElement("tr");
      tr.className = "section-row";
      tr.innerHTML = `<td colspan="10">${esc(row["Section"])}</td>`;
      if (!q) frag.appendChild(tr);
      continue;
    }

    if (!type) continue;

    // Filter
    if (q) {
      const haystack = [name, row["City"], row["Province"], row["Address"], row["Postal Code"], type].join(" ").toLowerCase();
      if (!haystack.includes(q)) continue;
    }

    visible++;
    const lat = parseFloat(row["Latitude"]);
    const lng = parseFloat(row["Longitude"]);
    const badCoords = !isNaN(lat) && !isNaN(lng) && !isInCanada(lat, lng);
    const noCoords  = isNaN(lat) || isNaN(lng) || !row["Latitude"] || !row["Longitude"];

    const tr = document.createElement("tr");
    if (dirty.has(i)) tr.className = "row-dirty";
    if (badCoords) tr.className = "row-bad-coords";

    tr.innerHTML = `
      <td>${typeSelect(i, type)}</td>
      <td>${cellInput(i, "Section", row["Section"])}</td>
      <td>${cellInput(i, "Name", name)}</td>
      <td>${cellInput(i, "Address", row["Address"])}</td>
      <td>${cellInput(i, "City", row["City"])}</td>
      <td>${provSelect(i, row["Province"])}</td>
      <td>${cellInput(i, "Postal Code", row["Postal Code"])}</td>
      <td><input class="coord" value="${esc(row["Latitude"] || "")}" data-row="${i}" data-col="Latitude" /></td>
      <td><input class="coord" value="${esc(row["Longitude"] || "")}" data-row="${i}" data-col="Longitude" /></td>
      <td>
        <div class="row-actions">
          ${(noCoords || badCoords) ? `<button class="icon-btn" data-geo="${i}" title="Geocode this row">Geo</button>` : ""}
          <button class="icon-btn danger" data-del="${i}" title="Delete row">✕</button>
        </div>
      </td>
    `;
    frag.appendChild(tr);
  }

  tableBody.innerHTML = "";
  tableBody.appendChild(frag);

  const total = rows.filter(r => (r["Type"] || "").trim()).length;
  rowCount.textContent = q ? `${visible} / ${total} rows` : `${total} rows`;

  // Attach listeners
  tableBody.querySelectorAll("input, select").forEach(el => {
    el.addEventListener("change", () => {
      const idx = parseInt(el.dataset.row);
      const col = el.dataset.col;
      if (!isNaN(idx) && col) {
        rows[idx][col] = el.value;
        dirty.add(idx);
      }
    });
  });

  tableBody.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.del);
      if (confirm(`Delete "${rows[idx]["Name"] || "this row"}"?`)) {
        rows.splice(idx, 1);
        dirty.clear();
        render();
      }
    });
  });

  tableBody.querySelectorAll("[data-geo]").forEach(btn => {
    btn.addEventListener("click", () => geocodeSingle(parseInt(btn.dataset.geo)));
  });
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}

function cellInput(idx, col, val) {
  return `<input value="${esc(val || "")}" data-row="${idx}" data-col="${col}" />`;
}

function typeSelect(idx, val) {
  return `<select data-row="${idx}" data-col="Type">
    <option value="mobile" ${val === "mobile" ? "selected" : ""}>mobile</option>
    <option value="clinic" ${val === "clinic" ? "selected" : ""}>clinic</option>
  </select>`;
}

function provSelect(idx, val) {
  const opts = PROVINCES.map(p =>
    `<option value="${p}" ${(val || "").trim() === p ? "selected" : ""}>${p}</option>`
  ).join("");
  return `<select data-row="${idx}" data-col="Province">
    <option value="">—</option>${opts}
  </select>`;
}

// ─────────────────────────────────────────────
// ADD ROW
// ─────────────────────────────────────────────

function addRow(type) {
  const newRow = {};
  COLUMNS.forEach(c => newRow[c] = "");
  newRow["Type"] = type;
  if (type === "mobile") newRow["Section"] = "Mobile";
  rows.push(newRow);
  dirty.add(rows.length - 1);
  render();
  tableBody.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "center" });
}

$("add-mobile-btn").addEventListener("click", () => addRow("mobile"));
$("add-clinic-btn").addEventListener("click", () => addRow("clinic"));

// ─────────────────────────────────────────────
// SEARCH / FILTER
// ─────────────────────────────────────────────

let filterTimeout;
searchInput.addEventListener("input", () => {
  clearTimeout(filterTimeout);
  filterTimeout = setTimeout(() => {
    filter = searchInput.value.trim();
    render();
  }, 200);
});

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = "status" + (cls ? " " + cls : "");
}

let toastTimer;
function toast(msg, isError) {
  toastEl.textContent = msg;
  toastEl.className = "toast visible" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("visible"), 3500);
}
