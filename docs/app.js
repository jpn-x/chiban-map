const state = {
  manifest: null,          // { cities: { citycode: {pref, city} } } 全国対応市区町村一覧
  cityIndexCache: new Map(), // citycode -> index.json の内容
  oazaCache: new Map(),     // "citycode:oaza名" -> GeoJSON FeatureCollection
  oazaLayers: new Map(),    // "citycode:oaza名" -> L.geoJSON layer (地図上のクリック可能レイヤー)
  selections: new Map(),    // key(citycode|oaza|chiban) -> {label, layer, feature}
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

async function loadManifest() {
  const res = await fetch(`${CONFIG.DATA_BASE_URL}/manifest.json`);
  if (!res.ok) throw new Error("市区町村一覧の取得に失敗しました");
  state.manifest = await res.json();
}

async function loadCityIndex(citycode) {
  if (state.cityIndexCache.has(citycode)) return state.cityIndexCache.get(citycode);
  setLoading(true);
  try {
    const res = await fetch(`${CONFIG.DATA_BASE_URL}/${citycode}/index.json`);
    if (!res.ok) return null;
    const index = await res.json();
    state.cityIndexCache.set(citycode, index);
    return index;
  } catch {
    return null;
  } finally {
    setLoading(false);
  }
}

async function loadOaza(citycode, oazaName, cityIndex) {
  const cacheKey = `${citycode}:${oazaName}`;
  if (state.oazaCache.has(cacheKey)) return state.oazaCache.get(cacheKey);
  const entry = cityIndex.oaza.find((o) => o.name === oazaName);
  if (!entry) return null;
  setLoading(true);
  try {
    const res = await fetch(`${CONFIG.DATA_BASE_URL}/${citycode}/${encodeURIComponent(entry.file)}`);
    if (!res.ok) throw new Error(`${oazaName} の読み込みに失敗しました`);
    const geojson = await res.json();
    state.oazaCache.set(cacheKey, geojson);
    return geojson;
  } finally {
    setLoading(false);
  }
}

function ensureOazaClickLayer(citycode, oazaName, geojson) {
  const cacheKey = `${citycode}:${oazaName}`;
  if (state.oazaLayers.has(cacheKey)) return;
  const layer = L.geoJSON(geojson, {
    style: { color: "#4a90d9", weight: 1, fillOpacity: 0.02, opacity: 0.35 },
    onEachFeature: (feature, lyr) => {
      lyr.on("click", () => toggleSelection(citycode, oazaName, feature, lyr));
      lyr.on("mouseover", () => lyr.setStyle({ fillOpacity: 0.15, opacity: 0.8 }));
      lyr.on("mouseout", () => lyr.setStyle({ fillOpacity: 0.02, opacity: 0.35 }));
    },
  }).addTo(map);
  state.oazaLayers.set(cacheKey, layer);
}

function selectionKey(citycode, oazaName, chiban) {
  return `${citycode}|${oazaName}|${chiban}`;
}

function addSelection(citycode, pref, city, oazaName, feature) {
  const chiban = feature.properties["地番"];
  const key = selectionKey(citycode, oazaName, chiban);
  if (state.selections.has(key)) return;

  const label = `${pref}${city}${oazaName}${chiban}`;
  const layer = L.geoJSON(feature, {
    style: { color: "#e8b400", weight: 2, fillColor: "#ffe066", fillOpacity: 0.6 },
  }).bindTooltip(label, { className: "parcel-tooltip" });
  layer.addTo(highlightLayerGroup);

  state.selections.set(key, { label, layer, feature });
  renderSelectionList();
}

function removeSelection(key) {
  const sel = state.selections.get(key);
  if (!sel) return;
  highlightLayerGroup.removeLayer(sel.layer);
  state.selections.delete(key);
  renderSelectionList();
}

function toggleSelection(citycode, oazaName, feature, lyr) {
  const chiban = feature.properties["地番"];
  const key = selectionKey(citycode, oazaName, chiban);
  if (state.selections.has(key)) {
    removeSelection(key);
  } else {
    const manifestEntry = state.manifest.cities[citycode];
    addSelection(citycode, manifestEntry.pref, manifestEntry.city, oazaName, feature);
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

// 都道府県+市区町村名で最長一致するmanifestエントリを探す。
// 都道府県が省略され、市区町村名が一意に決まらない場合はambiguousを返す。
function resolveCityFromLine(line) {
  const cities = Object.entries(state.manifest.cities);
  let best = null;
  for (const [citycode, info] of cities) {
    const full = info.pref + info.city;
    if (line.startsWith(full) && (!best || full.length > best.matchedPrefix.length)) {
      best = { citycode, pref: info.pref, city: info.city, matchedPrefix: full };
    }
  }
  if (best) return best;

  const cityOnly = cities
    .filter(([, info]) => line.startsWith(info.city))
    .sort((a, b) => b[1].city.length - a[1].city.length);
  if (cityOnly.length === 0) return null;
  const topLen = cityOnly[0][1].city.length;
  const ties = cityOnly.filter(([, info]) => info.city.length === topLen);
  if (ties.length > 1) {
    return { ambiguous: ties.map(([citycode, info]) => ({ citycode, pref: info.pref, city: info.city })) };
  }
  const [citycode, info] = ties[0];
  return { citycode, pref: info.pref, city: info.city, matchedPrefix: info.city };
}

// 完全一致 / 冠字省略 / 分筆後の枝番一括 のいずれかで該当featureを探す。
// 戻り値: { features: [...], note: string|null }
function findFeaturesByChiban(geojson, chibanQuery) {
  if (!chibanQuery) return { features: [], note: null };
  const feats = geojson.features;

  const exact = feats.find((f) => f.properties["地番"] === chibanQuery);
  if (exact) return { features: [exact], note: null };

  // 「甲」「乙」等の冠字が省略されている場合の救済
  const suffixMatch = feats.find((f) => f.properties["地番"].endsWith(chibanQuery));
  if (suffixMatch) return { features: [suffixMatch], note: null };

  // 親地番が分筆され「458」が無く「458-1」「458-2」等の枝番のみ存在するケース
  const branchPattern = new RegExp(`(^|[甲乙丙丁])${chibanQuery}-\\d+$`);
  const branches = feats.filter((f) => branchPattern.test(f.properties["地番"]));
  if (branches.length > 0) {
    return { features: branches, note: `${chibanQuery}は分筆されており、${branches.length}件の枝番をまとめて表示しました` };
  }

  return { features: [], note: null };
}

const CHOME_PATTERN = /\d+\s*丁目/;

// 全角数字・全角/各種ダッシュ記号を半角に正規化する(実データは半角表記のため)
function normalizeAddressText(s) {
  return s
    .normalize("NFKC")
    .replace(/[‐֊‑‒–—―−ー]/g, "-");
}

async function applyAddressInput() {
  const raw = document.getElementById("address-input").value;
  const lines = raw
    .split("\n")
    .map((l) => normalizeAddressText(l.trim()))
    .filter((l) => l.length > 0);
  const errors = [];

  for (const line of lines) {
    const cityMatch = resolveCityFromLine(line);
    if (!cityMatch) {
      errors.push(`市区町村を特定できませんでした(未対応のエリアの可能性があります): ${line}`);
      continue;
    }
    if (cityMatch.ambiguous) {
      const names = cityMatch.ambiguous.map((m) => `${m.pref}${m.city}`).join(" / ");
      errors.push(`市区町村があいまいです。都道府県から入力してください(候補: ${names}): ${line}`);
      continue;
    }

    const { citycode, pref, city, matchedPrefix } = cityMatch;
    const rest = line.slice(matchedPrefix.length).trim();

    const cityIndex = await loadCityIndex(citycode);
    if (!cityIndex) {
      errors.push(`${pref}${city} はまだデータ準備中です。しばらくしてから再度お試しください: ${line}`);
      continue;
    }

    const oazaCandidates = cityIndex.oaza
      .map((o) => o.name)
      .filter((name) => rest.startsWith(name))
      .sort((a, b) => b.length - a.length);

    if (oazaCandidates.length === 0) {
      const hint = CHOME_PATTERN.test(rest)
        ? "(「◯丁目」は住居表示のため、地番データとは一致しない場合があります)"
        : "";
      errors.push(`大字/町名を特定できませんでした: ${line} ${hint}`);
      continue;
    }

    const oazaName = oazaCandidates[0];
    const chibanQuery = rest.slice(oazaName.length).trim();

    const geojson = await loadOaza(citycode, oazaName, cityIndex);
    if (!geojson) {
      errors.push(`データ取得に失敗しました: ${line}`);
      continue;
    }
    ensureOazaClickLayer(citycode, oazaName, geojson);

    const { features: matchedFeatures, note } = findFeaturesByChiban(geojson, chibanQuery);
    if (matchedFeatures.length === 0) {
      const hint = CHOME_PATTERN.test(line)
        ? "(「◯丁目」形式の住所は住居表示のため、地番とは番号が異なり見つからない場合があります)"
        : "";
      errors.push(`地番が見つかりませんでした: ${line} ${hint}`);
      continue;
    }
    for (const feature of matchedFeatures) {
      addSelection(citycode, pref, city, oazaName, feature);
    }
    if (note) errors.push(`${line}: ${note}`);
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
    await loadManifest();
  } catch (e) {
    alert(e.message);
  } finally {
    setLoading(false);
  }
})();
