"use strict";

const state = {
  lang: "zh",
  tab: "species",
  data: { species: [], products: [], stats: {} },
  filters: { q: "", water: "", type: "", sort: "default", tmin: 4, tmax: 40, ph_min: 4, ph_max: 9, size_min: 1, size_max: 300, price_min: 0, price_max: 8000, has_img: false, has_price: false },
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => (n == null || isNaN(n) ? "—" : Number.isInteger(n) ? n : Math.round(n * 10) / 10);

// 收藏（localStorage 持久化）
const FAV_KEY = "aquapedia_favs";
let favs = new Set();
try { favs = new Set(JSON.parse(localStorage.getItem(FAV_KEY) || "[]")); } catch { favs = new Set(); }
const isFav = (id) => favs.has(id);
function toggleFav(id) {
  if (favs.has(id)) favs.delete(id); else favs.add(id);
  localStorage.setItem(FAV_KEY, JSON.stringify([...favs]));
  render();
  const mf = document.querySelector("#modal_body .modal-fav");
  if (mf && mf.dataset.id === id) { mf.classList.toggle("on", favs.has(id)); mf.textContent = favs.has(id) ? "★已收藏" : "☆收藏"; }
}

const L = {
  zh: {
    species: "物种档案", products: "在售商品", tabTank: "模拟鱼缸",
    statsSpec: "物种", statsPrice: "有报价", statsFresh: "淡水", statsMarine: "海水", statsProd: "物品",
    searchPh: "搜索中文名 / 学名 / 俗名，如 斗鱼、灯鱼、Betta、Apistogramma…",
    waterAll: "全部水域", typeAll: "全部类别", sortDefault: "默认排序",
    waterFresh: "淡水", waterBrack: "汽水（半咸）", waterMarine: "海水",
    typeFish: "鱼类", typePlant: "水草", typeInvert: "无脊椎", typeCoral: "珊瑚", typeEquip: "器材/设备", typeFood: "饲料", typeOther: "其他",
    equipment: "物品档案", q_allCat: "全部类别", q_equip: "器材/设备", q_food: "饲料",
    sortSizeAsc: "体长 ↑", sortSizeDesc: "体长 ↓", sortTempAsc: "水温 ↑", sortPriceAsc: "价格 ↑", sortPriceDesc: "价格 ↓", sortHeatDesc: "热度 ↓",
    temp: "水温", ph: "pH", size: "体长", price: "价格",
    hasImg: "有图片", hasPrice: "有报价", reset: "重置", empty: "没有符合条件的记录", count: "条", favOnly: "只看收藏", filter: "筛选",
    temp_water: "水温", hardness: "硬度", maxSize: "最大体长", tank: "水族箱", careLevel: "饲养难度", purchaseSize: "购买规格",
    water: "水域", type: "类别", intro: "简介", aliases: "别名", source: "数据来源", refPrice: "参考价", refEn: "参考原文（英文）", variants: "色系变种",
  },
  en: {
    species: "Species", products: "Products", tabTank: "Aquarium",
    statsSpec: "Species", statsPrice: "Priced", statsFresh: "Freshwater", statsMarine: "Marine", statsProd: "Products",
    searchPh: "Search Chinese / Latin / common name…",
    waterAll: "All waters", typeAll: "All types", sortDefault: "Default",
    waterFresh: "Freshwater", waterBrack: "Brackish", waterMarine: "Marine",
    typeFish: "Fish", typePlant: "Plants", typeInvert: "Invertebrates", typeCoral: "Corals", typeEquip: "Equipment", typeFood: "Foods", typeOther: "Other",
    sortSizeAsc: "Size ↑", sortSizeDesc: "Size ↓", sortTempAsc: "Temp ↑", sortPriceAsc: "Price ↑", sortPriceDesc: "Price ↓", sortHeatDesc: "Heat ↓",
    temp: "Temp", ph: "pH", size: "Size", price: "Price",
    hasImg: "Has image", hasPrice: "Has price", reset: "Reset", empty: "No matching records", count: "items", favOnly: "Favorites only", filter: "Filter",
    temp_water: "Temp", hardness: "Hardness", maxSize: "Max size", tank: "Tank", careLevel: "Care level", purchaseSize: "Purchase size",
    water: "Water", type: "Type", intro: "About", aliases: "Synonyms", source: "Source", refPrice: "Ref. price", variants: "Color variants",
  },
};

const SECTIONS = {
  distribution: { zh: "分布", en: "Distribution" },
  habitat: { zh: "栖息环境", en: "Habitat" },
  maintenance: { zh: "饲养与造景", en: "Setup & Care" },
  diet: { zh: "食性", en: "Diet" },
  compatibility: { zh: "行为与混养", en: "Compatibility" },
  breeding: { zh: "繁殖", en: "Breeding" },
  sexual_dimorphism: { zh: "雌雄区别", en: "Sexual dimorphism" },
  notes: { zh: "备注", en: "Notes" },
};
const TYPE_NAME = { fish: { zh: "鱼", en: "Fish" }, plant: { zh: "水草", en: "Plant" }, invertebrate: { zh: "无脊椎", en: "Invertebrate" }, coral: { zh: "珊瑚", en: "Coral" }, equipment: { zh: "器材/设备", en: "Equipment" }, food: { zh: "饲料", en: "Food" }, other: { zh: "其他", en: "Other" } };
const WATER_NAME = { freshwater: { zh: "淡水", en: "Freshwater" }, brackish: { zh: "汽水", en: "Brackish" }, marine: { zh: "海水", en: "Marine" } };

const t = (k) => (L[state.lang] && L[state.lang][k]) ?? L.zh[k] ?? k;
const tn = (k) => (TYPE_NAME[k] ? TYPE_NAME[k][state.lang] : (k || ""));
const wn = (k) => (WATER_NAME[k] ? WATER_NAME[k][state.lang] : (k || ""));
const sn = (k) => (SECTIONS[k] ? SECTIONS[k][state.lang] : (k || ""));

const WATER_OPTS = [["", "waterAll"], ["freshwater", "waterFresh"], ["brackish", "waterBrack"], ["marine", "waterMarine"]];
const TYPE_OPTS = [["", "typeAll"], ["fish", "typeFish"], ["plant", "typePlant"], ["invertebrate", "typeInvert"], ["coral", "typeCoral"], ["other", "typeOther"]];
const SORT_OPTS = [["default", "sortDefault"], ["heat_desc", "sortHeatDesc"], ["size_asc", "sortSizeAsc"], ["size_desc", "sortSizeDesc"], ["temp_asc", "sortTempAsc"], ["price_asc", "sortPriceAsc"], ["price_desc", "sortPriceDesc"]];
const EQUIP_OPTS = [["", "q_allCat"], ["equipment", "q_equip"], ["food", "q_food"]];
const NUM_IDS = ["tmin", "tmax", "ph_min", "ph_max", "size_min", "size_max", "price_min", "price_max"];
const DEFAULTS = { q: "", water: "", type: "", sort: "default", tmin: 4, tmax: 40, ph_min: 4, ph_max: 9, size_min: 1, size_max: 300, price_min: 0, price_max: 8000, has_img: false, has_price: false, fav_only: false };

function fillSelect(id, opts) {
  const el = $(id);
  const cur = el.value;
  el.innerHTML = opts.map(([v, k]) => `<option value="${esc(v)}">${esc(t(k))}</option>`).join("");
  el.value = [...el.options].some((o) => o.value === cur) ? cur : opts[0][0];
}

function applyLang() {
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  $("q").placeholder = t("searchPh");
  fillSelect("water", WATER_OPTS);
  fillSelect("type", TYPE_OPTS);
  fillSelect("sort", SORT_OPTS);
}

function applyTabUI() {
  const isSpecies = state.tab === "species";
  fillSelect("type", state.tab === "equipment" ? EQUIP_OPTS : TYPE_OPTS);
  $("type").value = "";
  state.filters.type = "";
  $("q").placeholder = state.tab === "equipment" ? "搜索物品名称，如 加热棒、鱼缸、水泵…" : t("searchPh");
  $("water").classList.toggle("hidden", !isSpecies);
  $("sort").classList.toggle("hidden", !isSpecies);
  const sl = document.querySelector(".toolbar.sliders");
  if (sl) sl.classList.toggle("hidden", !isSpecies);
}

async function init() {
  try {
    const r = await fetch("data/species.json");
    if (!r.ok) throw new Error(r.status);
    state.data = await r.json();
    // 物品档案 = LiveAquaria 器材+饲料商品（带图），不再读自定义 equipment.json
    state.data.equipment = (state.data.products || []).filter((p) => p.type === "equipment" || p.type === "food");
  } catch (e) {
    $("grid").innerHTML = `<div class="empty">数据加载失败（${esc(e.message)}）。请通过本地 HTTP 服务访问，例如：<code>python -m http.server</code></div>`;
    $("splash").classList.add("vanish");
    return;
  }
  applyLang();
  renderStats();
  bindControls();
  render();
  $("splash").classList.add("vanish");
}

function renderStats() {
  const s = state.data.stats || {};
  $("stats").innerHTML = [
    `${t("statsSpec")} <b>${s.species ?? 0}</b>`,
    `${t("statsPrice")} <b>${s.with_price ?? 0}</b>`,
    `${t("statsFresh")} <b>${s.freshwater ?? 0}</b>`,
    `${t("statsMarine")} <b>${s.marine ?? 0}</b>`,
    `${t("statsProd")} <b>${(state.data.equipment || []).length}</b>`,
  ].join("");
}

function bindControls() {
  $("q").addEventListener("input", (e) => { state.filters.q = e.target.value.trim().toLowerCase(); render(); });
  for (const id of ["water", "type", "sort"]) {
    $(id).addEventListener("change", (e) => { state.filters[id] = e.target.value; render(); });
  }
  for (const id of NUM_IDS) {
    $(id).addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      state.filters[id] = isNaN(v) ? DEFAULTS[id] : v;
      render();
    });
  }
  for (const id of ["has_img", "has_price", "fav_only"]) {
    $(id).addEventListener("change", (e) => { state.filters[id] = e.target.checked; render(); });
  }
  $("filter_toggle").addEventListener("click", () => {
    const sb = $("toolbar_sliders");
    sb.classList.toggle("open");
    $("filter_toggle").textContent = t("filter") + (sb.classList.contains("open") ? " ▴" : " ▾");
  });
  $("reset").addEventListener("click", () => {
    for (const id of NUM_IDS) $(id).value = DEFAULTS[id];
    $("q").value = ""; $("water").value = ""; $("type").value = ""; $("sort").value = "default";
    $("has_img").checked = false; $("has_price").checked = false; $("fav_only").checked = false;
    Object.assign(state.filters, DEFAULTS);
    render();
  });
  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
    state.tab = b.dataset.tab;
    applyTabUI();
    render();
  }));
  $("modal_close").addEventListener("click", () => $("modal").classList.add("hidden"));
  $("modal").addEventListener("click", (e) => { if (e.target === $("modal")) $("modal").classList.add("hidden"); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("modal").classList.add("hidden"); });
}

function matchesBase(item) {
  const f = state.filters;
  if (f.fav_only && !isFav(item.id)) return false;
  if (state.tab === "equipment") {
    const eName = item.name_zh || item.title || item.name || "";
    if (f.type && item.type !== f.type) return false;
    if (f.q && !((eName + " " + (item.description_zh || item.description || ""))).toLowerCase().includes(f.q)) return false;
    return true;
  }
  if (f.water && item.water !== f.water) return false;
  if (f.type && item.type !== f.type) return false;
  const care = item.care || {};
  if (care.temp_c) {
    if (care.temp_c[1] < f.tmin || care.temp_c[0] > f.tmax) return false;
  }
  if (care.ph) {
    if (care.ph[0] > f.ph_max || care.ph[1] < f.ph_min) return false;
  }
  if (care.size_cm) {
    if (care.size_cm < f.size_min || care.size_cm > f.size_max) return false;
  }
  if (item.price) {
    if (item.price.min < f.price_min || item.price.min > f.price_max) return false;
  }
  if (f.has_img && !(item.images || []).length) return false;
  if (f.has_price && !item.price) return false;
  if (f.q) {
    const hay = [item.name_zh, item.description_zh, ...(item.zh_aliases || []), item.scientific_name, item.author, ...(item.common_names || []), ...(item.synonyms || []), item.title, ...(item.variants || []).map((v) => v.name)]
      .filter(Boolean).join(" ").toLowerCase();
    if (!hay.includes(f.q)) return false;
  }
  return true;
}

function sortItems(items) {
  const s = state.filters.sort;
  const arr = [...items];
  const cmp = {
    size_asc: (a, b) => (a.care?.size_cm ?? 9e9) - (b.care?.size_cm ?? 9e9),
    size_desc: (a, b) => (b.care?.size_cm ?? -1) - (a.care?.size_cm ?? -1),
    temp_asc: (a, b) => (a.care?.temp_c?.[0] ?? 9e9) - (b.care?.temp_c?.[0] ?? 9e9),
    price_asc: (a, b) => (a.price?.min ?? 9e9) - (b.price?.min ?? 9e9),
    price_desc: (a, b) => (b.price?.min ?? -1) - (a.price?.min ?? -1),
    heat_desc: (a, b) => (b.heat ?? -1) - (a.heat ?? -1),
    default: (a, b) => (b.images?.length ? 1 : 0) - (a.images?.length ? 1 : 0) || (a.scientific_name || a.title || "").localeCompare(b.scientific_name || b.title || ""),
  }[s];
  return arr.sort(cmp);
}

function cardHtml(item) {
  const img = (item.images && item.images[0]) || null;
  const care = item.care || {};
  const chips = [];
  if (care.temp_c) chips.push(`${fmt(care.temp_c[0])}–${fmt(care.temp_c[1])}°C`);
  if (care.ph) chips.push(`pH ${fmt(care.ph[0])}–${fmt(care.ph[1])}`);
  if (care.size_cm) chips.push(`≤${fmt(care.size_cm)}cm`);
  if (item.price) chips.push(`¥${fmt(item.price.min)}${item.price.max > item.price.min ? `–${fmt(item.price.max)}` : ""}`);
  if (item.heat) chips.push(`热度 ${item.heat >= 10000 ? (item.heat / 10000).toFixed(1) + "万" : item.heat}`);
  const badge = wn(item.water) || "";
  // 中文优先；无中文名用拉丁学名（学名是学界通用，不显示英文俗名）
  const name = item.name_zh || item.scientific_name || item.title || "?";
  const sci = (item.scientific_name && item.scientific_name !== name) ? item.scientific_name : "";
  return `<div class="card" data-id="${esc(item.id)}">
    <button class="fav${isFav(item.id) ? " on" : ""}" data-id="${esc(item.id)}" title="收藏">${isFav(item.id) ? "★" : "☆"}</button>
    <div class="thumb">${img ? `<img loading="lazy" src="${esc(img)}" onerror="this.style.display='none'">` : `<div class="ph">${esc((item.scientific_name || item.title || "?").slice(0, 2))}</div>`}
    ${badge ? `<span class="badge">${esc(badge)}</span>` : ""}</div>
    <div class="body">
      <div class="name">${esc(name)}</div>
      <div class="sci">${esc(sci)}</div>
      <div class="chips">${chips.map((c) => `<span class="chip ${c.includes("¥") ? "price" : ""}">${esc(c)}</span>`).join("")}</div>
    </div>
  </div>`;
}

function render() {
  const isEquip = state.tab === "equipment";
  const pool = state.tab === "species" ? state.data.species : isEquip ? (state.data.equipment || []) : [];
  const items = isEquip ? pool.filter(matchesBase) : sortItems(pool.filter(matchesBase));
  $("count").textContent = `${items.length} / ${pool.length} ${t("count")}`;
  if (isEquip) {
    $("grid").innerHTML = items.slice(0, 400).map(equipCard).join("");
    $("empty").classList.toggle("hidden", items.length > 0);
    document.querySelectorAll(".card").forEach((el) =>
      el.addEventListener("click", () => openEquip(el.dataset.id)));
    document.querySelectorAll(".fav").forEach((b) =>
      b.addEventListener("click", (e) => { e.stopPropagation(); toggleFav(b.dataset.id); }));
    return;
  }
  $("grid").innerHTML = items.slice(0, 400).map(cardHtml).join("");
  $("empty").classList.toggle("hidden", items.length > 0);
  document.querySelectorAll(".card").forEach((el) =>
    el.addEventListener("click", () => openDetail(el.dataset.id)));
  document.querySelectorAll(".fav").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); toggleFav(b.dataset.id); }));
}

const EQUIP_CAT = { tank: "鱼缸", heating: "加热", filter: "过滤", pump: "水泵/造流", aeration: "打氧", lighting: "照明", temp: "温控", substrate: "底砂", decoration: "造景", co2: "二氧化碳", tool: "工具" };

function equipCard(item) {
  const name = item.name_zh || item.title || item.name || "?";
  const cat = (item.type && TYPE_NAME[item.type]) ? (TYPE_NAME[item.type][state.lang] || item.type) : (item.category || "");
  const price = item.price ? `¥${fmt(item.price.min)}${item.price.max > item.price.min ? `–${fmt(item.price.max)}` : ""}` : "";
  const specs = Object.entries(item.specs || {}).slice(0, 2).map(([k, v]) => `${esc(k)} ${esc(v)}`).join(" · ");
  const chips = [price, specs].filter(Boolean);
  return `<div class="card" data-id="${esc(item.id)}">
    <button class="fav${isFav(item.id) ? " on" : ""}" data-id="${esc(item.id)}" title="收藏">${isFav(item.id) ? "★" : "☆"}</button>
    <div class="thumb">${(item.images && item.images[0]) ? `<img loading="lazy" src="${esc(item.images[0])}" onerror="this.style.display='none'">` : `<div class="ph">${esc(name.slice(0, 2))}</div>`}</div>
    <div class="body">
      <div class="name">${esc(name)}</div>
      <div class="sci">${esc(cat)}${item.water ? " · " + esc(wn(item.water)) : ""}</div>
      <div class="chips">${chips.map((c) => `<span class="chip ${c.includes("¥") ? "price" : ""}">${esc(c)}</span>`).join("")}</div>
    </div>
  </div>`;
}

function openEquip(id) {
  const item = (state.data.equipment || []).find((x) => x.id === id);
  if (!item) return;
  const name = item.name_zh || item.title || item.name || "?";
  const cat = (item.type && TYPE_NAME[item.type]) ? (TYPE_NAME[item.type][state.lang] || item.type) : (item.category || "");
  const price = item.price ? `<div class="buyline">${esc(t("refPrice"))} <b>¥${fmt(item.price.min)}${item.price.max > item.price.min ? ` – ¥${fmt(item.price.max)}` : ""}</b></div>` : "";
  const specs = Object.entries(item.specs || {}).filter(([k]) => !/^作用2$/.test(k))
    .map(([k, v]) => `<div class="spec"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join("");
  const desc = (item.description_zh || item.description) ? `<section><h3>${esc(t("intro"))}</h3><p>${esc(item.description_zh || item.description)}</p></section>` : "";
  const img = (item.images && item.images[0]) || null;
  $("modal_body").innerHTML = `<div class="detail">
    <button class="fav modal-fav${isFav(item.id) ? " on" : ""}" data-id="${esc(item.id)}">${isFav(item.id) ? "★已收藏" : "☆收藏"}</button>
    <h2>${esc(name)}</h2>
    <div class="common"><i>${esc(cat)}</i>${item.water ? ` · ${esc(wn(item.water))}` : ""}</div>
    ${img ? `<img class="hero" src="${esc(img)}" onerror="this.style.display='none'">` : ""}
    ${specs ? `<div class="specgrid">${specs}</div>` : ""}
    ${price}${desc}
    <div class="src">${esc(t("source"))}：LiveAquaria</div>
  </div>`;
  $("modal").classList.remove("hidden");
  $("modal").scrollTop = 0;
  document.querySelector("#modal_body .modal-fav")?.addEventListener("click", (e) => { toggleFav(item.id); });
}

function openDetail(id) {
  const item = [...state.data.species, ...state.data.products].find((x) => x.id === id);
  if (!item) return;
  const care = item.care || {};
  const specs = [
    [t("temp_water"), care.temp_c ? `${fmt(care.temp_c[0])} – ${fmt(care.temp_c[1])} °C` : null],
    [t("hardness"), care.hardness_text || (care.hardness_ppm ? `${care.hardness_ppm[0]} – ${care.hardness_ppm[1]} ppm` : null)],
    [t("maxSize"), care.size_cm ? `≈ ${fmt(care.size_cm)} cm` : care.size_text],
    [t("tank"), care.tank_text || null],
    [t("careLevel"), care.care_level || null],
    [t("purchaseSize"), care.purchase_size_text || null],
    [t("water"), wn(item.water) || null],
    [t("type"), tn(item.type) || null],
  ].filter(([, v]) => v);
  const img = (item.images && item.images[0]) || null;
  const sections = Object.keys(SECTIONS)
    .map((k) => (item.sections_zh?.[k] || item.sections?.[k]) ? `<section><h3>${esc(sn(k))}</h3><p>${esc(item.sections_zh?.[k] || item.sections[k])}</p></section>` : "")
    .join("");
  const desc = (item.description_zh || item.description) ? `<section><h3>${esc(t("intro"))}</h3><p>${esc(item.description_zh || item.description)}</p></section>` : "";
  const head = item.name_zh || item.scientific_name || item.title || (item.common_names || [])[0] || "?";
  const srcs = Object.entries(item.sources || {})
    .map(([k]) => (k === "sf" ? "Seriously Fish" : "LiveAquaria"))
    .join(" / ");
  const refPrice = item.price
    ? `<div class="buyline">${esc(t("refPrice"))} <b>¥${fmt(item.price.min)}${item.price.max > item.price.min ? ` – ¥${fmt(item.price.max)}` : ""}</b></div>`
    : "";
  const engDesc = item.description ? `<section><h3>About</h3><p>${esc(item.description)}</p></section>` : "";
  const engSecs = Object.keys(SECTIONS)
    .map((k) => item.sections?.[k] ? `<section><h3>${esc(SECTIONS[k].en)}</h3><p>${esc(item.sections[k])}</p></section>` : "")
    .join("");
  const engRef = (item.description_zh && (engDesc || engSecs))
    ? `<details class="ref"><summary>${esc(t("refEn"))}</summary>${engDesc}${engSecs}</details>`
    : "";
  const variantsHTML = (item.variants || []).map((v) => `<div class="variant"><div class="vimg">${v.image ? `<img loading="lazy" src="${esc(v.image)}" onerror="this.style.display='none'">` : `<div class="ph">${esc((v.name || "?").slice(0, 2))}</div>`}</div><div class="vbody"><b>${esc(v.name)}</b><p>${esc(v.desc)}</p></div></div>`).join("");
  const variantsSec = variantsHTML ? `<section><h3>${esc(t("variants"))}</h3><div class="variants">${variantsHTML}</div></section>` : "";
  $("modal_body").innerHTML = `<div class="detail">
    <button class="fav modal-fav${isFav(item.id) ? " on" : ""}" data-id="${esc(item.id)}">${isFav(item.id) ? "★已收藏" : "☆收藏"}</button>
    <h2>${esc(head)}</h2>
    <div class="common"><i>${esc(item.scientific_name || "")}</i>${item.author ? ` <span class="author">${esc(item.author)}</span>` : ""}</div>
    ${(item.synonyms || []).length ? `<div class="author">${esc(t("aliases"))}：${esc(item.synonyms.join("、"))}</div>` : ""}
    ${img ? `<img class="hero" src="${esc(img)}" onerror="this.style.display='none'">` : ""}
    <div class="specgrid">${specs.map(([k, v]) => `<div class="spec"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join("")}</div>
    ${refPrice}${desc}${variantsSec}${sections}${engRef}
    <div class="src">${esc(t("source"))}：${srcs}${item.name_zh || item.zh_aliases?.length ? " · 百度百科 / iNaturalist" : ""}</div>
  </div>`;
  $("modal").classList.remove("hidden");
  $("modal").scrollTop = 0;
  document.querySelector("#modal_body .modal-fav")?.addEventListener("click", (e) => { toggleFav(item.id); });
}

init();
