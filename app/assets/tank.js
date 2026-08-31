"use strict";
(() => {
  const WATER_ZH = { freshwater: "淡水", brackish: "汽水（半咸）", marine: "海水" };
  const TYPE_ZH = { fish: "鱼类", plant: "水草", invertebrate: "无脊椎", coral: "珊瑚", other: "其他" };
  const CM_PER_L = 1 / 1.5;            // 标准密度：1cm 鱼 / 1.5L 水
  const KEY = "aquapedia_tank_v1";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (v, d = 0) => (v == null || isNaN(+v)) ? d : +v;
  const fmt = (n) => { if (n == null || isNaN(n)) return "—"; const r = Math.round(n * 10) / 10; return r === Math.round(r) ? String(Math.round(r)) : String(r); };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const round1 = (v) => Math.round(v * 10) / 10;

  let DB = null;
  let ROWS = null;
  let built = false;

  // ---------- 状态 ----------
  function loadTank() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) { const t = JSON.parse(raw); if (t && t.dims && Array.isArray(t.items)) return { volAuto: t.volAuto !== false, water: t.water || "", volume: t.volume || 0, dims: { l: +t.dims.l || 0, w: +t.dims.w || 0, h: +t.dims.h || 0 }, items: (t.items || []).filter((i) => i && i.id) }; }
    } catch (e) {}
    return { dims: { l: 60, w: 30, h: 30 }, volAuto: true, volume: 0, water: "", items: [] };
  }
  const tank = loadTank();
  const saveTank = () => { try { localStorage.setItem(KEY, JSON.stringify(tank)); } catch (e) {} };

  const grossVolume = () => Math.max(0, num(tank.dims.l) * num(tank.dims.w) * num(tank.dims.h)) / 1000;
  const waterVolume = () => { const g = grossVolume(); if (!g) return 0; const v = num(tank.volume, 0) || (g * 0.9); return clamp(v, 0.5, g); };

  async function ensureDB() {
    if (DB) return DB;
    try { const r = await fetch("data/species.json"); DB = await r.json(); }
    catch (e) { DB = { species: [], products: [] }; }
    return DB;
  }

  // ---------- 数据归一化 ----------
  const keyOf = (src) => src.id || (src.sources && src.sources.la) || ("x:" + (src.title || ""));
  function normItem(src, kind) {
    const care = src.care || {};
    const pair = (v) => (Array.isArray(v) && v.length === 2) ? v.slice() : null;
    return {
      id: keyOf(src), kind,
      sci: src.scientific_name || src.title || "",
      name: src.name_zh || (src.common_names && src.common_names[0]) || src.title || src.scientific_name || "?",
      type: src.type || "other",
      water: src.water || "",
      size_cm: care.size_cm ?? null,
      temp: pair(care.temp_c),
      ph: pair(care.ph),
      hardness: pair(care.hardness_ppm),
      hardtext: care.hardness_text || "",
      img: (src.images && src.images[0]) || null,
      compat: (src.sections && src.sections.compatibility) || "",
      count: 1,
    };
  }
  function findSource(id) {
    if (!DB) return null;
    return (DB.species && DB.species.find((s) => keyOf(s) === id)) || (DB.products && DB.products.find((p) => keyOf(p) === id)) || null;
  }
  function pickerRows() {
    if (ROWS) return ROWS;
    ROWS = [];
    for (const s of DB.species) ROWS.push({ src: s, it: normItem(s, "species") });
    for (const p of DB.products) ROWS.push({ src: p, it: normItem(p, "product") });
    return ROWS;
  }
  const srcText = (src) => [src.scientific_name, src.title, ...(src.common_names || []), ...(src.synonyms || []), ...(src.zh_aliases || []), src.name_zh, src.description].filter(Boolean).join(" ").toLowerCase();

  function thumbHtml(it, w, h) {
    if (it.img) return `<img src="${esc(it.img)}" style="width:${w}px;height:${h}px;object-fit:cover;border-radius:6px;background:#fff;flex-shrink:0" onerror="this.style.display='none'">`;
    return `<div style="width:${w}px;height:${h}px;background:#dbe5ec;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:12px;color:#5d7285;flex-shrink:0">${esc((it.name || "?").slice(0, 1))}</div>`;
  }

  // ---------- 分析 ----------
  function intersectRanges(ranges) {
    if (!ranges.length) return null;
    let lo = -Infinity, hi = Infinity;
    for (const [a, b] of ranges) { lo = Math.max(lo, a); hi = Math.min(hi, b); }
    return lo <= hi ? [lo, hi] : null;
  }

  function analyze() {
    const items = tank.items;
    const volume = waterVolume();
    const gross = grossVolume();

    const ws = [...new Set(items.map((i) => i.water).filter(Boolean))];
    const target = (tank.water && WATER_ZH[tank.water]) ? tank.water : (ws.length === 1 ? ws[0] : null);
    const waterBad = items.filter((i) => i.water && target && i.water !== target);
    let waterStatus = "ok", waterMsg;
    if (!items.length) { waterStatus = "na"; waterMsg = "尚未加入生物"; }
    else if (ws.length > 1 && !(tank.water && WATER_ZH[tank.water])) { waterStatus = "fail"; waterMsg = `混含不同水域：${ws.map((w) => WATER_ZH[w] || w).join("、")}。请统一水源或手动指定`; }
    else if (waterBad.length) { waterStatus = "fail"; waterMsg = `${waterBad.length} 项与${WATER_ZH[target] || target}不符：${waterBad.map((i) => i.name).join("、")}`; }
    else waterMsg = target ? `统一为${WATER_ZH[target] || target}` : "（未指定/无数据）";

    const temps = items.map((i) => i.temp).filter(Array.isArray);
    const temp = intersectRanges(temps);
    let tempStatus = "ok", tempMsg;
    if (!items.length || !temps.length) { tempStatus = "na"; tempMsg = "无水温数据，不参与水温匹配"; }
    else if (!temp) { tempStatus = "fail"; tempMsg = "水温区间无交集，无法共存于同一水温"; }
    else tempMsg = `交集 ${fmt(temp[0])}–${fmt(temp[1])}°C，建议设定 ${Math.round((temp[0] + temp[1]) / 2)}°C`;

    const phs = items.map((i) => i.ph).filter(Array.isArray);
    const ph = intersectRanges(phs);
    let phStatus = "ok", phMsg;
    if (!items.length || !phs.length) { phStatus = "na"; phMsg = "无 pH 数据，不参与 pH 匹配"; }
    else if (!ph) { phStatus = "fail"; phMsg = "pH 区间无交集"; }
    else phMsg = `交集 pH ${fmt(ph[0])}–${fmt(ph[1])}`;

    const hards = items.map((i) => i.hardness).filter(Array.isArray);
    const hard = intersectRanges(hards);
    let hardMsg = "—";
    if (hard) hardMsg = `${fmt(hard[0])}–${fmt(hard[1])} ppm`;
    else if (items.length) hardMsg = items.find((i) => i.hardtext)?.hardtext || "数据未收录";

    const fishLen = items.filter((i) => i.type === "fish").reduce((s, i) => s + (num(i.size_cm) * i.count), 0);
    const cap = volume * CM_PER_L;
    const util = cap > 0 ? fishLen / cap : 0;
    const denPct = items.length ? Math.round(util * 100) : null;
    let denStatus = "ok", denMsg;
    if (!items.length) { denStatus = "na"; denMsg = "—"; }
    else if (util > 1) { denStatus = "fail"; denMsg = `鱼只全长 ${fmt(fishLen)}cm / 标准容量 ${fmt(cap)}cm（${denPct}%），超载，需减少鱼只或增大水体`; }
    else if (util > 0.8) { denStatus = "warn"; denMsg = `鱼只全长 ${fmt(fishLen)}cm（${denPct}%），接近上限，注意过滤与换水`; }
    else denMsg = `鱼只全长 ${fmt(fishLen)}cm / 标准容量 ${fmt(cap)}cm（${denPct}%）`;

    const nPlant = items.filter((i) => i.type === "plant").reduce((s, i) => s + i.count, 0);
    const nCoral = items.filter((i) => i.type === "coral").reduce((s, i) => s + i.count, 0);

    const warnings = [];
    const fish = items.filter((i) => i.type === "fish");
    for (let a = 0; a < fish.length; a++) for (let b = a + 1; b < fish.length; b++) {
      const sa = num(fish[a].size_cm), sb = num(fish[b].size_cm);
      if (sa && sb) { const big = Math.max(sa, sb), small = Math.min(sa, sb); if (big / small > 3) warnings.push(`体型悬殊：${fish[a].name}(${fmt(sa)}cm) 与 ${fish[b].name}(${fmt(sb)}cm) 可能吞食/压制小型鱼`); }
    }
    const noSizeFish = items.filter((i) => i.type === "fish" && !i.size_cm);
    if (noSizeFish.length) warnings.push(`${noSizeFish.length} 种鱼类未收录体长，未计入密度估算`);
    for (const i of items) {
      const t = (i.compat || "").toLowerCase();
      if (t && /aggress|piscivor|territor|not.*(suitable|good)|will (eat|attack|kill|harass)/.test(t)) warnings.push(`“${i.name}”混养提示：${i.compat.slice(0, 90)}`);
    }
    if (nPlant >= 3 && fishLen > 0) warnings.push("水草较密，鱼只泳道与受光可能受挤占，注意留出活动空间");
    if (nCoral > 0 && target && target !== "marine") warnings.push("珊瑚需海水环境，与你设定的水质不符");

    let lightText, lightWpl;
    if (nCoral > 0) { lightText = "强光（珊瑚需充足光谱，LED 白+蓝）"; lightWpl = 1.2; }
    else if (nPlant > 0) { lightText = nPlant >= 4 ? "中强光（多水草造景）" : "中光（适生水草）"; lightWpl = nPlant >= 4 ? 0.8 : 0.5; }
    else { lightText = "弱光基础照明（观赏/显色）"; lightWpl = 0.25; }

    const aeroReasons = []; let aeroNeed = false;
    if (nCoral > 0 || target === "marine") { aeroNeed = true; aeroReasons.push("海水/珊瑚需水流与溶氧"); }
    if (util > 0.8) { aeroNeed = true; aeroReasons.push("鱼只密度偏高"); }
    if (temp && temp[1] >= 28) { aeroNeed = true; aeroReasons.push(`水温可达 ${fmt(temp[1])}°C，溶氧下降`); }
    let aeroText;
    if (aeroNeed) aeroText = "建议打氧（" + aeroReasons.join("、") + "）";
    else if (nPlant >= 3) aeroText = "可选——水草供氧，保持水面扰动即可";
    else aeroText = "一般无需（低负荷）";

    let ffactor, ftype;
    if (nCoral > 0 || target === "marine") { ffactor = 10; ftype = "强力过滤 + 蛋白分离器（海水/珊瑚）"; }
    else { ffactor = nPlant >= 3 ? 5 : 4; ftype = nPlant >= 3 ? "滤桶/瀑布式（草缸）" : "瀑布式 / 滤桶"; }
    const fflow = Math.round(volume * ffactor);

    let sub;
    if (nCoral > 0 || target === "marine") sub = "活沙 + 活石骨架（海水缸）";
    else if (nPlant > 0) sub = "水草泥 / 营养底砂 + 沉木石景";
    else if (target === "brackish") sub = "珊瑚砂 / 混合砂（含盐环境）";
    else sub = "中性细沙或砾石";

    const statuses = [waterStatus, tempStatus, phStatus, denStatus];
    let overall = "ok";
    if (!items.length) overall = "empty";
    else if (statuses.includes("fail")) overall = "fail";
    else if (statuses.includes("warn")) overall = "warn";

    return { items, volume, gross, target, waterStatus, waterMsg, temp, tempStatus, tempMsg, ph, phStatus, phMsg, hardMsg, denStatus, denMsg, denPct, fishLen, cap, util, lightText, lightWpl, lightW: Math.round(volume * lightWpl), aeroText, fflow, ftype, sub, warnings, overall, nPlant, nCoral };
  }

  // ---------- 渲染 ----------
  function renderItems() {
    const cont = $("#titems");
    if (!tank.items.length) { cont.innerHTML = `<div style="font-size:12px;color:var(--mut)">尚未加入生物，点击上方按钮从百科添加。</div>`; return; }
    cont.innerHTML = tank.items.map((it, idx) => {
      const missing = !it.size_cm && !it.temp;
      const meta = [TYPE_ZH[it.type] || it.type, WATER_ZH[it.water] || (it.water || ""), it.size_cm ? `≤${fmt(it.size_cm)}cm` : "", it.temp ? `${fmt(it.temp[0])}–${fmt(it.temp[1])}°C` : "", it.ph ? `pH ${fmt(it.ph[0])}–${fmt(it.ph[1])}` : ""].filter(Boolean).map((s) => `<span>${esc(s)}</span>`).join(" · ");
      return `<div class="titem" data-idx="${idx}">
        ${thumbHtml(it, 36, 27)}
        <div class="ti-info">
          <div class="ti-name">${esc(it.name)}</div>
          <div class="ti-sub">${meta}${missing ? `<span class="tag-missing">数据未收录</span>` : ""}</div>
        </div>
        <div class="ti-cnt"><button data-act="dec">−</button><span>${it.count}</span><button data-act="inc">＋</button></div>
        <button class="ti-del" data-act="del">×</button>
      </div>`;
    }).join("");
    $$("#titems button").forEach((b) => b.addEventListener("click", (e) => {
      const row = e.target.closest(".titem");
      const idx = +row.dataset.idx;
      const act = b.dataset.act;
      if (act === "inc") tank.items[idx].count++;
      else if (act === "dec") { tank.items[idx].count--; if (tank.items[idx].count <= 0) tank.items.splice(idx, 1); }
      else if (act === "del") tank.items.splice(idx, 1);
      saveTank(); renderDynamic();
    }));
  }

  function renderVisual(volume, gross) {
    const cont = $("#tvisual");
    const l = num(tank.dims.l), w = num(tank.dims.w), h = num(tank.dims.h);
    if (!l || !w || !h) { cont.innerHTML = `<div class="tank-empty">请输入长宽高尺寸</div>`; return; }
    const scale = Math.max(1.2, Math.min(560 / l, 320 / h));
    const idealW = Math.round(l * scale), idealH = Math.round(h * scale);
    // 自适应容器宽度（移动端不溢出，避免需手动缩放）
    const availW = Math.max(160, cont && cont.clientWidth ? cont.clientWidth : (window.innerWidth || 360));
    const W = Math.min(idealW, Math.round(availW));
    const H = Math.max(48, Math.round(W * idealH / idealW));
    const level = gross > 0 ? Math.min(1, volume / gross) : 0;
    const waterH = Math.round(H * level);
    const items = tank.items;
    let body = "";
    if (!items.length) body = `<div class="tank-empty">从百科添加生物 / 水草，即可在此看到可视化</div>`;
    else {
      const pref = { plant: 0.78, coral: 0.55, invertebrate: 0.62, fish: 0.35, other: 0.5 };
      const margin = 18, usableW = Math.max(20, W - 2 * margin);
      items.forEach((it, idx) => {
        const jx = (((idx * 0.7548) % 1) - 0.5) * 0.10;
        const x = margin + usableW * ((idx + 0.5) / Math.max(1, items.length) + jx);
        const p = pref[it.type] ?? 0.5;
        const jy = (((idx * 0.618) % 1) - 0.5) * 0.20;
        const vf = clamp(p + jy, 0.05, 0.92);
        const yFrac = (1 - level) + level * vf;
        let px = it.type === "fish" ? (it.size_cm ? Math.round(it.size_cm * scale) : 46) : it.type === "plant" ? 48 : it.type === "coral" ? 42 : 38;
        px = clamp(px, 22, 96);
        const hpx = Math.round(px * 0.7);
        const img = it.img ? `<img src="${esc(it.img)}" style="width:${px}px;max-height:${hpx}px;object-fit:contain" onerror="this.style.display='none'">`
          : `<div style="width:${px}px;height:${hpx}px;background:#cfe9f4;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:12px;color:#5d7285">${esc((it.name || "?").slice(0, 1))}</div>`;
        const title = `${it.name}${it.count > 1 ? " ×" + it.count : ""}${it.temp ? "，" + fmt(it.temp[0]) + "–" + fmt(it.temp[1]) + "°C" : ""}`;
        body += `<div class="tank-item" style="left:${Math.round(x)}px;top:${Math.round(yFrac * H)}px" title="${esc(title)}" data-id="${esc(it.id)}">
          ${img}${it.count > 1 ? `<span class="cnt">×${it.count}</span>` : ""}<span class="lbl">${esc(it.name)}</span></div>`;
      });
    }
    cont.innerHTML = `<div class="tank-box" style="width:${W}px;height:${H}px">
      <div class="tank-water" style="height:${waterH}px"></div>${body}
      <div class="tank-dim">${fmt(l)}×${fmt(w)}×${fmt(h)} cm · 水体 ${fmt(volume)}L</div></div>`;
    // 点击缸内条目 -> 详情
    $$(".tank-item", cont).forEach((el) => el.addEventListener("click", () => {
      const it = tank.items.find((x) => x.id === el.dataset.id);
      if (it) openItemDetail(it);
    }));
  }

  function renderAnalysis(a) {
    const cont = $("#tanalysis");
    const stTxt = { ok: "方案可行", warn: "基本可行 · 注意提醒", fail: "存在冲突 · 建议调整", empty: "空缸 — 添加生物/水草后自动分析" }[a.overall];
    const stCls = a.overall === "empty" ? "na" : a.overall;
    const ind = (k, v, st, m) => `<div class="ind ${st}"><div class="k">${k}</div><div class="v">${v}</div>${m ? `<div class="m">${m}</div>` : ""}</div>`;
    const inds = [
      ind("水域一致性", a.target ? (WATER_ZH[a.target] || a.target) : "未定", a.waterStatus, a.waterMsg),
      ind("水温匹配", a.temp ? `${fmt(a.temp[0])}–${fmt(a.temp[1])}°C` : "—", a.tempStatus, a.tempMsg),
      ind("pH 匹配", a.ph ? `${fmt(a.ph[0])}–${fmt(a.ph[1])}` : "—", a.phStatus, a.phMsg),
      ind("饲养密度", a.denPct == null ? "—" : a.denPct + "%", a.denStatus, a.denMsg),
      ind("混养相容", a.warnings.length ? a.warnings.length + " 条提醒" : "未见明显冲突", a.warnings.length ? "warn" : "ok", a.warnings.length ? a.warnings[0] : ""),
    ];
    cont.innerHTML = `<div class="result-status st-${stCls}"><span class="dot"></span>${stTxt}</div><div class="indicators">${inds.join("")}</div>`;
  }

  function renderCfg(a) {
    const cont = $("#tconfig");
    const waterName = a.target ? (WATER_ZH[a.target] || a.target) : "未确定（先添加生物或指定水源）";
    const cfg = [
      ["水源", waterName],
      ["温度", a.temp ? `${fmt(a.temp[0])}–${fmt(a.temp[1])}°C（推荐 ${Math.round((a.temp[0] + a.temp[1]) / 2)}°C）` : "由生物决定"],
      ["pH", a.ph ? `${fmt(a.ph[0])}–${fmt(a.ph[1])}` : "由生物决定"],
      ["硬度", a.hardMsg],
      ["光照", `${a.lightText} · 约 ${a.lightW}W（${fmt(a.lightWpl)}W/L）`],
      ["打氧", a.aeroText],
      ["过滤", `约 ${a.fflow} L/h（循环约 ${Math.round(a.fflow / Math.max(0.1, a.volume))}×/h）`],
      ["底砂/造景", a.sub],
    ];
    cont.innerHTML = `<div class="cfg-grid">${cfg.map(([k, v]) => `<div class="cfg"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join("")}</div>`;
    const adv = $("#tadvice");
    adv.innerHTML = a.warnings.length ? a.warnings.map((w) => `<li>${esc(w)}</li>`).join("") : `<li class="empty">未发现明显混养冲突；入缸前建议检疫并适应水质。</li>`;
  }

  function renderDynamic() {
    const g = grossVolume();
    $("#tgross").textContent = fmt(g);
    const tv = $("#tvol");
    tv.max = g; tv.min = 0.5; tv.step = 0.5;
    if (document.activeElement !== tv) tv.value = round1(waterVolume());
    $("#twater").value = tank.water || "";
    renderItems();
    const a = analyze();
    renderVisual(a.volume, a.gross);
    renderAnalysis(a);
    renderCfg(a);
  }

  function build() {
    $("#tankview").innerHTML = `<div class="tank-wrap">
      <div class="tank-controls">
        <h2>模拟鱼缸</h2>
        <div class="tc-group">尺寸 cm：长 <input type="number" id="tl" min="5" max="2000" step="1" value="${num(tank.dims.l)}"> 宽 <input type="number" id="tw" min="5" max="2000" step="1" value="${num(tank.dims.w)}"> 高 <input type="number" id="th" min="5" max="2000" step="1" value="${num(tank.dims.h)}"></div>
        <div class="tc-group">最大容积 <b id="tgross">—</b> L</div>
        <div class="tc-group">实际水体 <input type="number" id="tvol" min="0.5" max="${num(grossVolume(), 1)}" step="0.5"> L（≤ 最大容积，默认 90%）</div>
        <div class="tc-group">水源 <select id="twater">
          <option value="">自动（随生物）</option><option value="freshwater">淡水</option><option value="brackish">汽水（半咸）</option><option value="marine">海水</option>
        </select></div>
        <button id="tadd" class="btn primary">＋ 从百科添加生物 / 水草</button>
        <div id="titems"></div>
      </div>
      <div class="tank-main">
        <div class="tank-visual"><h3>鱼缸可视化</h3><div id="tvisual"></div></div>
        <div class="tank-analysis"><h3>可行性分析</h3><div id="tanalysis"></div></div>
        <div class="tank-cfg"><h3>建议环境配置</h3><div id="tconfig"></div></div>
        <div class="tank-cfg"><h3>混养建议</h3><ul id="tadvice" class="tank-advice"></ul></div>
      </div>
    </div>`;
    const tl = $("#tl"), tw = $("#tw"), th = $("#th"), tv = $("#tvol"), twa = $("#twater");
    const upd = () => {
      tank.dims.l = clamp(+tl.value || 0, 0, 2000);
      tank.dims.w = clamp(+tw.value || 0, 0, 2000);
      tank.dims.h = clamp(+th.value || 0, 0, 2000);
      const g = grossVolume();
      if (tank.volAuto) tank.volume = round1(g * 0.9);
      tank.volume = clamp(tank.volume || g * 0.9, 0.5, g || 0.5);
      saveTank(); renderDynamic();
    };
    tl.addEventListener("input", upd); tw.addEventListener("input", upd); th.addEventListener("input", upd);
    tv.addEventListener("input", () => {
      let v = +tv.value;
      if (!isFinite(v)) v = grossVolume() * 0.9;
      tank.volume = clamp(v, 0.5, grossVolume() || 0.5);
      tank.volAuto = false;
      saveTank(); renderDynamic();
    });
    tv.addEventListener("change", () => { tv.value = round1(waterVolume()); });
    twa.addEventListener("change", () => { tank.water = twa.value; saveTank(); renderDynamic(); });
    $("#tadd").addEventListener("click", openPicker);
    renderDynamic();
  }

  function renderTank() { if (!built) { build(); built = true; } else renderDynamic(); }

  // ---------- 详情（缸内条目） ----------
  function openItemDetail(it) {
    const modal = $("#modal"), body = $("#modal_body");
    const care = [];
    if (it.temp) care.push(["水温", `${fmt(it.temp[0])} – ${fmt(it.temp[1])} °C`]);
    if (it.ph) care.push(["pH", `${fmt(it.ph[0])} – ${fmt(it.ph[1])}`]);
    if (it.hardness) care.push(["硬度", `${fmt(it.hardness[0])} – ${fmt(it.hardness[1])} ppm`]);
    if (it.size_cm) care.push(["最大体长", `≈ ${fmt(it.size_cm)} cm`]);
    if (it.hardtext) care.push(["硬度备注", it.hardtext]);
    const specs = [...care, ["水域", WATER_ZH[it.water] || (it.water || "—")], ["类别", TYPE_ZH[it.type] || it.type]].filter(([, v]) => v);
    const img = it.img ? `<img class="hero" src="${esc(it.img)}" onerror="this.style.display='none'">` : "";
    body.innerHTML = `<div class="detail">
      <h2>${esc(it.sci || it.name)}</h2>
      <div class="common">${esc(it.name)}</div>
      ${img}
      <div class="specgrid">${specs.map(([k, v]) => `<div class="spec"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join("")}</div>
      ${it.compat ? `<section><h3>行为与混养</h3><p>${esc(it.compat)}</p></section>` : ""}
      <div class="src">来源：${it.kind === "species" ? "Seriously Fish 物种档案" : "LiveAquaria 在售商品"}</div>
    </div>`;
    modal.classList.remove("hidden");
    modal.scrollTop = 0;
  }

  // ---------- 添加弹窗 ----------
  function openPicker() {
    const modal = $("#modal"), body = $("#modal_body");
    modal.classList.remove("hidden");
    if (!DB) { body.innerHTML = `<div style="padding:24px;color:var(--mut)">正在加载数据…</div>`; ensureDB().then(renderPicker); return; }
    renderPicker();
  }
  function renderPicker() {
    const body = $("#modal_body");
    body.innerHTML = `<div class="picker">
      <div class="pk-row"><input type="search" id="pkq" placeholder="搜索学名 / 俗名 / 中文名 / 别名，如 Betta、斗鱼、Cryptocoryne…"><select id="pktype">
        <option value="">全部类别</option><option value="fish">鱼类</option><option value="plant">水草</option><option value="invertebrate">无脊椎</option><option value="coral">珊瑚</option>
      </select></div>
      <div class="pk-note">物种档案与在售商品均可加入。商品项多未收录水温/体长等数值参数，仅参与水域匹配与可视化。</div>
      <div class="pklist" id="pklist"></div>
    </div>`;
    const q = $("#pkq"), t = $("#pktype");
    q.addEventListener("input", renderPickerList);
    t.addEventListener("change", renderPickerList);
    renderPickerList();
    q.focus();
  }
  function renderPickerList() {
    const q = $("#pkq").value.trim().toLowerCase();
    const type = $("#pktype").value;
    const cont = $("#pklist");
    let rows = pickerRows();
    if (type) rows = rows.filter((r) => r.it.type === type);
    if (q) rows = rows.filter((r) => srcText(r.src).includes(q));
    const shown = rows.slice(0, 400);
    cont.innerHTML = shown.length ? shown.map(({ it }) => {
      const missing = !it.size_cm && !it.temp;
      const inTank = tank.items.find((x) => x.id === it.id);
      const meta = [TYPE_ZH[it.type] || it.type, WATER_ZH[it.water] || (it.water || ""), it.size_cm ? `≤${fmt(it.size_cm)}cm` : "", it.temp ? `${fmt(it.temp[0])}–${fmt(it.temp[1])}°C` : "", it.ph ? `pH ${fmt(it.ph[0])}–${fmt(it.ph[1])}` : ""].filter(Boolean).join(" · ");
      return `<div class="pkitem" data-id="${esc(it.id)}">
        ${thumbHtml(it, 44, 33)}
        <div class="pk-info"><div class="pk-name">${esc(it.name)}${inTank ? ` <span class="tag-missing">已加 ×${inTank.count}</span>` : ""}</div>
          <div class="pk-sub">${esc(it.sci)} · ${meta}</div></div>
        <button class="btn add" data-id="${esc(it.id)}">加入</button>
      </div>`;
    }).join("") : `<div style="padding:20px;color:var(--mut);text-align:center">无匹配结果</div>`;
    $$("button.add", cont).forEach((b) => b.addEventListener("click", () => { addToTank(b.dataset.id); renderPickerList(); renderDynamic(); }));
  }
  function addToTank(id) {
    const src = findSource(id); if (!src) return;
    const kind = (DB.species && DB.species.some((s) => keyOf(s) === id)) ? "species" : "product";
    const existing = tank.items.find((x) => x.id === id);
    if (existing) existing.count++;
    else tank.items.push(normItem(src, kind));
    saveTank();
  }

  // ---------- 启动 ----------
  function ensureChrome() {
    const nav = document.querySelector("header nav");
    if (nav && !nav.querySelector('button.tab[data-tab="tank"]')) {
      const b = document.createElement("button");
      b.className = "tab"; b.dataset.tab = "tank"; b.textContent = "模拟鱼缸";
      nav.appendChild(b);
    }
    if (!document.querySelector('link[href*="tank.css"]')) {
      const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "assets/tank.css"; document.head.appendChild(l);
    }
    if (!$("#tankview")) {
      const tv = document.createElement("section"); tv.id = "tankview"; tv.className = "hidden";
      const footer = document.querySelector("footer");
      if (footer) footer.parentNode.insertBefore(tv, footer); else document.body.appendChild(tv);
    }
  }
  function init() {
    ensureChrome();
    const nav = document.querySelector("header nav");
    if (!nav) return;
    nav.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-tab]");
      if (!b) return;
      const isTank = b.dataset.tab === "tank";
      // Only the primary toolbar (search/category) + main are toggled here; the
      // species sliders (.toolbar.sliders) are controlled by app.js per tab.
      const toolbar = document.querySelector(".toolbar");
      if (toolbar) toolbar.classList.toggle("hidden", isTank);
      const main = document.querySelector("main");
      if (main) main.classList.toggle("hidden", isTank);
      const tv = $("#tankview");
      if (tv) tv.classList.toggle("hidden", !isTank);
      if (isTank) renderTank();
    });
    // 横竖屏/窗口变化时，若鱼缸页可见则重新适配容器宽度
    let rz = null;
    window.addEventListener("resize", () => {
      const tv = $("#tankview");
      if (!tv || tv.classList.contains("hidden")) return;
      clearTimeout(rz);
      rz = setTimeout(renderTank, 200);
    });
  }
  init();
})();
