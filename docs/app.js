const state = {
  cityIndex: null,       // index.json の内容 (citycode, city, oaza[])
  oazaCache: new Map(),  // oaza名 -> GeoJSON FeatureCollection
  oazaLayers: new Map(), // oaza名 -> L.geoJSON layer (地図上のクリック可能レイヤー)
  selections: new Map(), // key(citycode|oaza|chiban) -> {label, layer, feature}
};

const map = L.map("map").setView(CONFIG.MAP_CENTER, CONFIG.MAP_ZOOM);

L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png", {
  attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>',
  maxZoom: 18,
}).addTo(map);

const highlightLayerGroup = L.layerGroup().addTo(map);

function setLoading(on) {
  document.getElementById("loading").classList.toggle("hidden", !on);
}

async function loadCityIndex() {
  const res = await fetch(`${CONFIG.DATA_BASE_URL}/${CONFIG.DEFAULT_CITY}/index.json`);
  if (!res.ok) throw new Error("市区町村インデックスの取得に失敗しました");
  state.cityIndex = await res.json();
}

async function loadOaza(oazaName) {
  if (state.oazaCache.has(oazaName)) return state.oazaCache.get(oazaName);
  const entry = state.cityIndex.oaza.find((o) => o.name === oazaName);
  if (!entry) return null;
  setLoading(true);
  try {
    const res = await fetch(`${CONFIG.DATA_BASE_URL}/${CONFIG.DEFAULT_CITY}/${encodeURIComponent(entry.file)}`);
    if (!res.ok) throw new Error(`${oazaName} の読み込みに失敗しました`);
    const geojson = await res.json();
    state.oazaCache.set(oazaName, geojson);
    return geojson;
  } finally {
    setLoading(false);
  }
}

function ensureOazaClickLayer(oazaName, geojson) {
  if (state.oazaLayers.has(oazaName)) return;
  const layer = L.geoJSON(geojson, {
    style: { color: "#4a90d9", weight: 1, fillOpacity: 0.02, opacity: 0.35 },
    onEachFeature: (feature, lyr) => {
      lyr.on("click", () => toggleSelection(oazaName, feature, lyr));
      lyr.on("mouseover", () => lyr.setStyle({ fillOpacity: 0.15, opacity: 0.8 }));
      lyr.on("mouseout", () => lyr.setStyle({ fillOpacity: 0.02, opacity: 0.35 }));
    },
  }).addTo(map);
  state.oazaLayers.set(oazaName, layer);
}

function selectionKey(oazaName, chiban) {
  return `${oazaName}|${chiban}`;
}

function addSelection(oazaName, feature) {
  const chiban = feature.properties["地番"];
  const key = selectionKey(oazaName, chiban);
  if (state.selections.has(key)) return;

  const layer = L.geoJSON(feature, {
    style: { color: "#e8b400", weight: 2, fillColor: "#ffe066", fillOpacity: 0.6 },
  }).bindTooltip(`${state.cityIndex.city}${oazaName}${chiban}`, { className: "parcel-tooltip" });
  layer.addTo(highlightLayerGroup);

  state.selections.set(key, {
    label: `${state.cityIndex.city}${oazaName}${chiban}`,
    layer,
    feature,
  });
  renderSelectionList();
}

function removeSelection(key) {
  const sel = state.selections.get(key);
  if (!sel) return;
  highlightLayerGroup.removeLayer(sel.layer);
  state.selections.delete(key);
  renderSelectionList();
}

function toggleSelection(oazaName, feature, lyr) {
  const chiban = feature.properties["地番"];
  const key = selectionKey(oazaName, chiban);
  if (state.selections.has(key)) {
    removeSelection(key);
  } else {
    addSelection(oazaName, feature);
  }
}

function renderSelectionList() {
  const list = document.getElementById("selection-list");
  list.innerHTML = "";
  document.getElementById("selection-count").textContent = state.selections.size;
  for (const [key, sel] of state.selections.entries()) {
    const li = document.createElement("li");
    const focusBtn = document.createElement("button");
    focusBtn.type = "button";
    focusBtn.className = "focus-btn";
    focusBtn.textContent = sel.label;
    focusBtn.addEventListener("click", () => {
      map.fitBounds(sel.layer.getBounds(), { maxZoom: 18 });
    });
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = "×";
    removeBtn.className = "remove-btn";
    removeBtn.setAttribute("aria-label", `${sel.label} を削除`);
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeSelection(key);
    });
    li.appendChild(focusBtn);
    li.appendChild(removeBtn);
    list.appendChild(li);
  }
}

function findOazaInLine(line) {
  // 都道府県・市区町村名を除去してから、既知の大字名の中で最長一致するものを探す
  let rest = line.replace(/^\s*[^\s]*?[都道府県]/, "").trim();
  if (state.cityIndex.city && rest.startsWith(state.cityIndex.city)) {
    rest = rest.slice(state.cityIndex.city.length);
  }
  rest = rest.trim();

  const candidates = state.cityIndex.oaza
    .map((o) => o.name)
    .filter((name) => rest.startsWith(name))
    .sort((a, b) => b.length - a.length);

  if (candidates.length === 0) return null;
  const oazaName = candidates[0];
  const chibanQuery = rest.slice(oazaName.length).trim();
  return { oazaName, chibanQuery };
}

function findFeatureByChiban(geojson, chibanQuery) {
  if (!chibanQuery) return null;
  const feats = geojson.features;
  let match = feats.find((f) => f.properties["地番"] === chibanQuery);
  if (match) return match;
  // 「甲」「乙」等の冠字が省略されている場合の救済
  match = feats.find((f) => f.properties["地番"].endsWith(chibanQuery));
  if (match) return match;
  return null;
}

async function applyAddressInput() {
  const raw = document.getElementById("address-input").value;
  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const errors = [];

  for (const line of lines) {
    const parsed = findOazaInLine(line);
    if (!parsed) {
      errors.push(`大字を特定できませんでした: ${line}`);
      continue;
    }
    const geojson = await loadOaza(parsed.oazaName);
    if (!geojson) {
      errors.push(`データ取得に失敗: ${line}`);
      continue;
    }
    ensureOazaClickLayer(parsed.oazaName, geojson);
    const feature = findFeatureByChiban(geojson, parsed.chibanQuery);
    if (!feature) {
      errors.push(`地番が見つかりませんでした: ${line}`);
      continue;
    }
    addSelection(parsed.oazaName, feature);
  }

  document.getElementById("parse-errors").textContent = errors.join("\n");

  if (state.selections.size > 0) {
    const allBounds = L.latLngBounds([]);
    for (const sel of state.selections.values()) {
      allBounds.extend(sel.layer.getBounds());
    }
    map.fitBounds(allBounds, { maxZoom: 17, padding: [40, 40] });
  }
}

function clearAll() {
  for (const key of Array.from(state.selections.keys())) {
    removeSelection(key);
  }
  document.getElementById("parse-errors").textContent = "";
}

function openSidebar() {
  document.getElementById("sidebar").classList.add("open");
  document.getElementById("sidebar-backdrop").classList.add("open");
}
function closeSidebar() {
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("sidebar-backdrop").classList.remove("open");
}
const isMobile = () => window.matchMedia("(max-width: 768px)").matches;

document.getElementById("btn-menu").addEventListener("click", openSidebar);
document.getElementById("btn-close-sidebar").addEventListener("click", closeSidebar);
document.getElementById("sidebar-backdrop").addEventListener("click", closeSidebar);

document.getElementById("btn-apply").addEventListener("click", async () => {
  await applyAddressInput();
  if (isMobile()) closeSidebar();
});
document.getElementById("btn-clear-all").addEventListener("click", clearAll);
document.getElementById("btn-top").addEventListener("click", () => {
  clearAll();
  document.getElementById("address-input").value = "";
  map.setView(CONFIG.MAP_CENTER, CONFIG.MAP_ZOOM);
});
document.getElementById("btn-print").addEventListener("click", () => window.print());
document.getElementById("btn-pdf").addEventListener("click", () => {
  alert("印刷ダイアログが開きます。出力先(プリンター)で「PDFに保存」を選択してください。");
  window.print();
});

(async function init() {
  setLoading(true);
  try {
    await loadCityIndex();
  } catch (e) {
    alert(e.message);
  } finally {
    setLoading(false);
  }
})();
