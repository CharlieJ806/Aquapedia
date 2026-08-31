# Merge Seriously Fish profiles with LiveAquaria catalog into the app data package.
# SF = species backbone (care data); LA = prices/products. Match on scientific name
# (normalized), fall back to exact common-name match. LA-only items land in "products".
import json, pathlib, re, time
import requests

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "data/raw"
APP = ROOT / "app"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36"}

LA_CAT_TYPE = {"fresh_fish": "fish", "marine_fish": "fish", "plant": "plant",
               "fresh_invert": "invertebrate", "marine_invert": "invertebrate", "coral": "coral", "other": "other"}

_INVERT_RE = re.compile(r"marine invert|freshwater invert|freshwater shrimp|\banemone|\bcrab\b|\bshrimp\b|\bsnail\b|\burchin\b|starfish|invertebrate")
_FOOD_RE = re.compile(r"\bfood\b|frozen food|dry food|feeder")
_EQUIP_RE = re.compile(r"hard good|filter|lighting|\bpump\b|stand|canopy|aquascap|controller|conditioner|additive|heater|\bsump\b|skimmer|\bled\b|test kit|aquarium supply|pond supply|\bsalt\b")


def product_type(rec):
    # LiveAquaria buckets most non-fish/coral/plant items as "other"; recover the
    # real category from tags/title (invertebrates, foods, equipment) so the app
    # can present them separately.
    cat = rec.get("category") or ""
    blob = (" ".join(rec.get("tags") or []) + " " + (rec.get("title") or "")).lower()
    if cat in ("fresh_fish", "marine_fish"):
        return "fish"
    if cat == "plant":
        return "plant"
    if cat == "coral":
        return "coral"
    if cat in ("fresh_invert", "marine_invert") or _INVERT_RE.search(blob):
        return "invertebrate"
    if _FOOD_RE.search(blob):
        return "food"
    if _EQUIP_RE.search(blob):
        return "equipment"
    return "other"


def norm_sci(s):
    if not s:
        return None
    s = re.sub(r"['\"]", "", s or "")
    s = re.sub(r"\s+", " ", s).strip().lower()
    return s or None


def norm_common(s):
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def split_author(sci):
    # SF profile titles end with an ALL-CAPS citation, e.g. "(EIGENMANN & HILDEBRAND, 1922)".
    if not sci:
        return None, None
    m = re.search(r"\(?([A-Z][A-Z& .'\-]{2,}), (\d{4})\)?$", sci)
    if m and not re.search(r"[a-z]", m.group(1)):
        name = sci[: m.start()].strip()
        name = re.sub(r"['\"]", "", name)
        name = re.sub(r"\s+", " ", name).strip()
        return (name or None), f"({m.group(1)}, {m.group(2)})"
    name = re.sub(r"['\"]", "", sci or "")
    name = re.sub(r"\s+", " ", name).strip()
    return (name or None), None


def fix_temps(tc):
    # Scraper mis-applied F->C to some Celsius values: recover v<5 via v*9/5+32,
    # drop impossible (>45) values, keep honest absence when nothing survives.
    if not tc or not isinstance(tc, list):
        return None
    vals = []
    for v in tc[:2]:
        try:
            v = float(v)
        except (TypeError, ValueError):
            continue
        if v < 5:
            v = round(v * 9 / 5 + 32, 1)
        if v <= 45:
            vals.append(v)
    if not vals:
        return None
    if len(vals) == 1:
        return [vals[0], vals[0]]
    return [min(vals), max(vals)]


def load_sf():
    records, path = [], RAW / "sf.jsonl"
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return records


def load_la():
    path = RAW / "la.json"
    return json.loads(path.read_text()) if path.exists() else []
def load_zh():
    # Baidu Baike Chinese names, keyed by normalized scientific name.
    # Regenerate the de-noised map (build_zh.py) from the harvester's .jsonl each run,
    # so freshly harvested names always flow through; fall back to cached zh.json.
    try:
        import build_zh
        return build_zh.build_zh_map()
    except Exception:
        path = RAW / "zh.json"
        return json.loads(path.read_text()) if path.exists() else {}


def load_translate():
    # Machine-translated body text (description/sections) from scrape/translate_zh.py,
    # keyed by item id. Only translated items are present; missing ones fall back to English.
    path = RAW / "zh_translate.jsonl"
    out = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
                out[r["id"]] = r
            except Exception:
                pass
    return out


def load_baike():
    # Authentic Chinese name + body from Baidu Baike (scrape/zh_baike_body.js), keyed by
    # item id. A genus-level article (e.g. "搏鱼属" for a species) is rejected: the full
    # scientific name must appear in the body, so only the species' own article is used.
    path = RAW / "zh_baike.jsonl"
    out = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except Exception:
            continue
        if not r.get("body_zh"):
            continue
        sci = (r.get("sci") or "").lower()
        body = (r.get("body_zh") or "").lower().replace(" ", "").replace("\n", "")
        if sci and sci.replace(" ", "") not in body:
            continue  # not this species' article
        name = r.get("name_zh")
        if not name or len(name) < 2:
            continue
        out[r["id"]] = r
    return out


def load_nonfish():
    # Plants / corals / invertebrates + extra fish harvested from Baidu Baike
    # (zh_baike_nonfish.js / zh_baike_add.js) with a Chinese name + body; appended
    # to the species archive to broaden coverage beyond Seriously Fish.
    out = []
    for filename in ("zh_baike_hot.jsonl", "zh_baike_nonfish.jsonl", "zh_baike_add.jsonl"):
        path = RAW / filename
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get("name_zh") and r.get("body_zh") and r.get("sci"):
                out.append(r)
    return out


def load_inat_img():
    # iNaturalist photo mapping from scrape/inat_img.py: { <norm_sci>: img path }
    path = RAW / "inat_img.json"
    try:
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    except Exception:
        return {}


NOISE_TYPES = {"21", "76", "172", "183", "4", "119", "130", "138"}
AQUA_RE = re.compile(r"鱼缸|水族|养鱼|造景|水草|观赏鱼|热带鱼|海水|珊瑚|虾缸|观赏虾|观赏螺|青鳉|溪流|草缸|繁殖|鱼苗|野采|原生|鱼友|鲷|鳉|龟|虾|螺|鱼")


def load_heat():
    # Popularity score from the Bilibili heat harvest: { kw: total aquarium-shown play }
    heat = {}
    path = RAW / "bili_heat.jsonl"
    if not path.exists():
        return heat
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except Exception:
            continue
        if "title" not in r:
            continue
        if r.get("typeid") in NOISE_TYPES:
            continue
        if not AQUA_RE.search((r.get("title") or "") + " " + (r.get("tag") or "")):
            continue
        kw = r.get("kw")
        heat[kw] = heat.get(kw, 0) + (r.get("play") or 0)
    return heat


def load_variants():
    # Color-form variants for hot species: { <norm_sci>: [{name, desc}] }
    path = RAW / "variants.json"
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return {norm_sci(k): v for k, v in d.items()}


# Approximate fixed USD→CNY for reference pricing (no daily fetching needed).
RATE = 7.2


def to_cny(price):
    # Keep original USD for reference; display price becomes CNY.
    if not price:
        return None, None
    cny = {"min": round(price["min"] * RATE), "max": round(price["max"] * RATE), "currency": "CNY"}
    usd = {"min": price["min"], "max": price["max"], "currency": "USD"}
    return cny, usd


def sf_water_oneof(rec):
    w = rec.get("water")
    return w if w in ("freshwater", "brackish", "marine") else "freshwater"


def sf_type(rec, la_match):
    # Seriously Fish profiles are fish (or rare plants, per the classification
    # section). The LiveAquaria match must not override species type: an LA item
    # matched by common name can be mis-tagged, which turned fish into
    # "invertebrate"/"other" before.
    cls = (rec.get("sections") or {}).get("classification", "")
    if re.search(r"Plantae|Alismatales|Amaryllidaceae|Acanthaceae|Ceratophyll|Hydrocharit|Potamogeton", cls, re.I):
        return "plant"
    return "fish"


def download(url, dest, timeout=40):
    if dest.exists() and dest.stat().st_size > 3000:
        return True
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        r = requests.get(url, headers=UA, timeout=timeout)
        if r.status_code == 200 and len(r.content) > 3000:
            dest.write_bytes(r.content)
            return True
    except Exception:
        pass
    return False


def main():
    sf = load_sf()
    zh_map = load_zh()
    tr_map = load_translate()
    baike_map = load_baike()
    la = load_la()

    la_by_sci = {}
    for p in la:
        key = norm_sci(p.get("scientific_name"))
        if key:
            la_by_sci.setdefault(key, []).append(p)
    la_by_common = {}
    for p in la:
        k = norm_common(p["title"])
        if k:
            la_by_common.setdefault(k, []).append(p)

    species, used_la_handles = [], set()
    img_fail = 0

    for rec in sf:
        slug = rec.get("slug") or (rec.get("url") or "unknown").rstrip("/").split("/")[-1]
        sci, author_auto = split_author(rec.get("scientific_name"))
        if not sci and re.fullmatch(r"[a-z\-]+", slug):
            parts = [p for p in slug.split("-") if p.isalpha()]
            if 1 <= len(parts) <= 3:
                sci = " ".join([parts[0].capitalize()] + parts[1:])
        la_match = la_by_sci.get(norm_sci(sci), [])
        if not la_match:
            for cn in rec.get("common_names", []):
                la_match = la_by_common.get(norm_common(cn), [])
                if la_match:
                    break
        # 图鉴只保留有中文名的物种（至少一个中文数据源）；无中文名的 SF 物种删除，
        # 且不占用其 LA 商品（对应商品仍留在 products）。
        zh_info = zh_map.get(norm_sci(sci)) or {}
        bk = baike_map.get(f"sf:{slug}") or {}
        if not (bk.get("name_zh") or zh_info.get("zh")):
            continue
        for m in la_match:
            used_la_handles.add(m["handle"])
        price = None
        price_usd = None
        if la_match:
            priced = [m for m in la_match if m.get("price")]
            if priced:
                price, price_usd = to_cny(
                    {"min": min(m["price"]["min"] for m in priced),
                     "max": max(m["price"]["max"] for m in priced)})
        care = dict(rec.get("care") or {})
        care["temp_c"] = fix_temps(care.get("temp_c"))
        if care.get("hardness_text"):
            care["hardness_text"] = re.split(r"\s*;\s*|\s+see\s+", care["hardness_text"])[0].strip() or None
        if la_match:
            lc = la_match[0].get("care") or {}
            care["care_level"] = care.get("care_level") or lc.get("care_level")
            care["size_text"] = care.get("size_text") or lc.get("size_text")

        images = list(rec.get("images") or [])
        if not images and la_match and la_match[0].get("image_url"):
            m = la_match[0]
            url = m["image_url"] + ("&" if "?" in m["image_url"] else "?") + "width=640"
            dest = APP / "img/la" / f"{m['handle']}.jpg"
            if download(url, dest):
                images = [f"img/la/{m['handle']}.jpg"]
            else:
                img_fail += 1

        water = sf_water_oneof(rec)
        if la_match and water == "freshwater" and la_match[0].get("water") == "marine":
            water = "marine"

        tr = tr_map.get(f"sf:{slug}") or {}
        bk = baike_map.get(f"sf:{slug}") or {}
        species.append({
            "id": f"sf:{slug}",
            "scientific_name": sci,
            "author": rec.get("author") or author_auto,
            "common_names": rec.get("common_names") or [],
            "synonyms": rec.get("synonyms") or [],
            "type": sf_type(rec, la_match),
            "water": water,
            "care": care,
            "description": rec.get("description") or "",
            "description_zh": bk.get("body_zh") or tr.get("desc_zh"),
            "sections": rec.get("sections") or {},
            "sections_zh": tr.get("sections_zh") or {},
            "images": images,
            "price": price,
            "price_usd": price_usd,
            "name_zh": bk.get("name_zh") or zh_info.get("zh"),
            "zh_aliases": zh_info.get("aliases") or [],
            "sources": {"sf": rec.get("url"), **({"la": la_match[0]["url"]} if la_match else {})},
        })

    # Non-fish organisms (plants/coral/invertebrates) from the Baidu Chinese harvest.
    # Deduplicate by scientific name so an organism already covered (SF backbone or a
    # previously-added Baidu species) is not added twice (prevents duplicate ids too).
    covered_sci = set()
    for s in species:
        ssc = norm_sci(s.get("scientific_name"))
        if ssc:
            covered_sci.add(ssc)
    for r in load_nonfish():
        sci = r["sci"]
        ssc = norm_sci(sci)
        if ssc and ssc in covered_sci:
            continue
        slug = re.sub(r"\s+", "-", (ssc or sci).lower())
        species.append({
            "id": f"nf:{slug}",
            "scientific_name": sci,
            "author": None,
            "common_names": [],
            "synonyms": [],
            "type": r.get("type") or "other",
            "water": r.get("water") or "freshwater",
            "care": {},
            "description": "",
            "description_zh": r.get("body_zh"),
            "sections": {},
            "sections_zh": {},
            "images": [],
            "price": None,
            "price_usd": None,
            "name_zh": r.get("name_zh"),
            "zh_aliases": r.get("aliases") or [],
            "sources": {"baike": "百度百科"},
        })
        if ssc:
            covered_sci.add(ssc)

    # 给百度补的非鱼物种补图：先试 LiveAquaria 同学名商品图，再用 iNaturalist 照片兜底。
    inat_img = load_inat_img()
    for s in species:
        if s["id"].startswith("nf:") and not s.get("images"):
            sc_n = norm_sci(s.get("scientific_name"))
            m = la_by_sci.get(sc_n) if sc_n else None
            if m and m[0].get("image_url"):
                lpm = m[0]
                url = lpm["image_url"] + ("&" if "?" in lpm["image_url"] else "?") + "width=640"
                dest = APP / "img/la" / f"{lpm['handle']}.jpg"
                if download(url, dest):
                    s["images"] = [f"img/la/{lpm['handle']}.jpg"]
            elif sc_n and sc_n in inat_img:
                dest = APP / "img" / inat_img[sc_n].split("/")[1]
                if dest.exists() and dest.stat().st_size > 3000:
                    s["images"] = [inat_img[sc_n]]

    # 热门数据：给每个物种存哔哩哔哩热度分（按中文名/别名命中搜索词）。
    heat_map = load_heat()
    for s in species:
        s["heat"] = 0
        for k in [s.get("name_zh"), *(s.get("zh_aliases") or [])]:
            if k and k in heat_map:
                s["heat"] = heat_map[k]
                break

    # 色系变种（仅颜色/形态不同的同种）：名字+简介+代表图，供搜索与详情展示。
    variants_map = load_variants()
    for s in species:
        vs = variants_map.get(norm_sci(s.get("scientific_name")))
        if vs:
            img = (s.get("images") or [None])[0]
            s["variants"] = [{"name": v["name"], "desc": v["desc"], "image": v.get("image") or img} for v in vs]

    products = []
    for p in la:
        if p["handle"] in used_la_handles:
            continue
        img = None
        zh_info = zh_map.get(norm_sci(p.get("scientific_name"))) or {}
        price, price_usd = to_cny(p.get("price"))
        if p.get("image_url"):
            url = p["image_url"] + ("&" if "?" in p["image_url"] else "?") + "width=480"
            dest = APP / "img/la" / f"{p['handle']}.jpg"
            if download(url, dest):
                img = f"img/la/{p['handle']}.jpg"
            else:
                img_fail += 1
        products.append({
            "id": f"la:{p['handle']}",
            "price": price,
            "price_usd": price_usd,
            "name_zh": zh_info.get("zh"),
            "zh_aliases": zh_info.get("aliases") or [],
            "scientific_name": p.get("scientific_name"),
            "title": p["title"],
            "type": product_type(p),
            "water": p.get("water"),
            "care": {"size_text": (p.get("care") or {}).get("size_text"),
                     "purchase_size_text": (p.get("care") or {}).get("purchase_size_text"),
                     "care_level": (p.get("care") or {}).get("care_level")},
            "description": p.get("description") or "",
            "description_zh": (tr_map.get(f"la:{p['handle']}") or {}).get("desc_zh"),
            "images": [img] if img else [],
            "image_url": p.get("image_url"),
            "sources": {"la": p["url"]},
        })

    stats = {
        "species": len(species),
        "with_price": sum(1 for s in species if s["price"]),
        "with_zh": sum(1 for s in species if s.get("name_zh")),
        "with_zh_products": sum(1 for p in products if p.get("name_zh")),
        "freshwater": sum(1 for s in species if s["water"] == "freshwater"),
        "marine": sum(1 for s in species if s["water"] == "marine"),
        "products": len(products),
    }
    payload = {"generated": time.strftime("%Y-%m-%d %H:%M:%S"),
               "stats": stats, "species": species, "products": products}
    print(f"rate={RATE}(fixed) zh_hits={stats['with_zh']}")
    out_dir = APP / "data"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "species.json").write_text(json.dumps(payload, ensure_ascii=False))
    print(f"DONE species={stats['species']} with_price={stats['with_price']} "
          f"products={stats['products']} img_fail={img_fail} -> app/data/species.json")


if __name__ == "__main__":
    main()
