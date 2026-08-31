# Scrape LiveAquaria full catalog via Shopify products.json
# Page-level cache in data/raw/la_pages/ makes reruns resume where they left off.
import json, re, time, pathlib, html as htmllib
import requests

ROOT = pathlib.Path(__file__).resolve().parent.parent
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"}
BASE = "https://www.liveaquaria.com"

TAG_MAP = [
    ("Corals", "coral"), ("Marine Invertebrates", "marine_invert"),
    ("Marine Fish", "marine_fish"), ("Freshwater Invertebrates", "fresh_invert"),
    ("Freshwater Fish", "fresh_fish"), ("Aquatic Plants", "plant"),
    ("Freshwater Plants", "plant"), ("Plants", "plant"),
]
BINOMIAL = re.compile(r"^[A-Z][a-z\u00C0-\u017F]+ [a-z\u00C0-\u017F][a-z\u00C0-\u017F\-]*$")


def text_of(raw):
    txt = re.sub(r"<[^>]+>", " ", raw or "")
    return re.sub(r"\s+", " ", htmllib.unescape(txt)).strip()


def categorize(tags):
    for tag, cat in TAG_MAP:
        if tag in tags:
            return cat
    return "other"


def water_of(cat, tags, body):
    t = " ".join(tags).lower() + " " + body[:600].lower()
    if cat == "coral" or "marine" in t:
        return "marine"
    if "brackish" in t:
        return "brackish"
    return "freshwater"


def parse_range(text):
    nums = [float(x) for x in re.findall(r"\d+(?:\.\d+)?", text or "")]
    return [min(nums), max(nums)] if nums else None


def temp_c(text):
    nums = parse_range(text)
    if not nums:
        return None
    if "F" in text:
        nums = [round((x - 32) * 5 / 9, 1) for x in nums]
    return nums


def fetch_page(session, page):
    cache = ROOT / "data/raw/la_pages" / f"page-{page}.json"
    if cache.exists():
        return json.loads(cache.read_text()).get("products", [])
    url = f"{BASE}/products.json?limit=250&page={page}"
    for attempt in range(4):
        try:
            r = session.get(url, timeout=90)
            r.raise_for_status()
            data = r.json()
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps(data, ensure_ascii=False))
            return data.get("products", [])
        except Exception as e:
            if attempt == 3:
                raise
            wait = [2, 6, 15][attempt]
            print(f"page {page} attempt {attempt+1} failed ({type(e).__name__}), retry in {wait}s", flush=True)
            time.sleep(wait)


def main():
    out = ROOT / "data/raw/la.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.headers.update(UA)
    products, page = [], 1
    while page <= 30:
        batch = fetch_page(session, page)
        if not batch:
            break
        products.extend(batch)
        print(f"page {page}: +{len(batch)} (total {len(products)})", flush=True)
        page += 1
        time.sleep(0.4)
    records = []
    for p in products:
        tags = p.get("tags") or []
        body = text_of(p.get("body_html"))
        sci = (p.get("product_type") or "").strip()
        if not BINOMIAL.match(sci):
            sci = None
        prices = [float(v["price"]) for v in p.get("variants", []) if v.get("price")]
        avail = [float(v["price"]) for v in p.get("variants", []) if v.get("price") and v.get("available")]
        use = avail or prices
        wc = re.search(r"Water Conditions[:\s]+([^.]{5,90})", body)
        ms = re.search(r"Max Size[:\s]+([^.]{2,40})", body)
        ps = re.search(r"Approximate Purchase Size[:\s]+([^.]{2,40})", body)
        cl = re.search(r"Care Level[:\s]+([A-Za-z \-]{2,20})", body)
        imgs = p.get("images") or []
        img = imgs[0]["src"] if imgs else None
        cat = categorize(tags)
        title = re.sub(r"\s*(EXPERT ONLY|WYSIWYG)\s*", " ", p["title"]).strip()
        records.append({
            "source": "la",
            "handle": p["handle"],
            "url": f"{BASE}/products/{p['handle']}",
            "title": title,
            "scientific_name": sci,
            "category": cat,
            "water": water_of(cat, tags, body),
            "price": {"min": min(use), "max": max(use), "currency": "USD"} if use else None,
            "sold_out": not avail and bool(prices),
            "care": {
                "temp_c": temp_c(wc.group(1)) if wc else None,
                "size_text": ms.group(1).strip() if ms else None,
                "purchase_size_text": ps.group(1).strip() if ps else None,
                "care_level": cl.group(1).strip() if cl else None,
            },
            "description": body[:1200],
            "image_url": img,
            "tags": tags[:8],
        })
    out.write_text(json.dumps(records, ensure_ascii=False))
    with_sci = sum(1 for r in records if r["scientific_name"])
    with_price = sum(1 for r in records if r["price"])
    print(f"DONE products={len(records)} with_scientific_name={with_sci} with_price={with_price} -> {out}")


if __name__ == "__main__":
    main()
