#!/usr/bin/env python3
"""Scrape seriouslyfish.com species profiles into structured JSONL + local images.

Contract:
- output: data/raw/sf.jsonl (one JSON object per line, append+flush)
- failures: data/raw/sf_failed.txt
- images: app/img/sf/<slug>-N.jpg (<=2 per profile, JPEG q82, max side 800, <3KB discarded)
- resume: slugs already present in sf.jsonl are skipped on startup
Politeness: concurrency 4, sleep 0.3-0.7s per request, browser UA, 25s timeout,
2 retries with backoff on 5xx/timeout.
"""
import io
import json
import os
import random
import re
import sys
import threading
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from bs4 import BeautifulSoup

try:
    from PIL import Image  # noqa: F401
    HAVE_PIL = True
except Exception:
    HAVE_PIL = False

BASE = "https://www.seriouslyfish.com"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "raw", "sf.jsonl")
FAILED = os.path.join(ROOT, "data", "raw", "sf_failed.txt")
MAX_IMAGES = 2
SKIP_IMAGES = os.environ.get("SF_IMAGES", "1") == "0"
WORKERS = int(os.environ.get("SF_WORKERS", "2"))
IMG_DIR = os.path.join(ROOT, "app", "img", "sf")

UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}
TIMEOUT = int(os.environ.get("SF_TIMEOUT", "25"))
RETRIES = int(os.environ.get("SF_RETRIES", "2"))

SECTION_KEYS = {
    "profile_distribution": "distribution",
    "profile_habitat": "habitat",
    "profile_tanksetup": "maintenance",
    "profile_diet": "diet",
    "profile_compatibility": "compatibility",
    "profile_breeding": "breeding",
    "profile_notes": "notes",
}

NOISE_SEL = [
    "script", "style", "form", "ins",
    "span[data-method='placement-service']",
    "span[id^=ezoic-pub-ad-placeholder]",
    "span[data-ez-ph-id]",
    "div[id^=ezoic-pub-ad-placeholder]",
    "div.sf_affiliate_link_wrapper",
    "div[class*='advert']",
    "div[class*='affiliate']",
]

_lock = threading.Lock()
_tls = threading.local()
_stats = {"ok": 0, "fail": 0, "imgs": 0}
_abort = threading.Event()


def session():
    if not hasattr(_tls, "s"):
        _tls.s = requests.Session()
        _tls.s.headers.update(UA)
    return _tls.s


def fetch(url, binary=False):
    """GET with polite sleep + 2 retries with backoff on 5xx/timeout. None on 404/410."""
    last = None
    code = None
    for attempt in range(RETRIES + 1):
        try:
            time.sleep(random.uniform(0.3, 0.7))
            r = session().get(url, timeout=TIMEOUT)
            if r.status_code in (404, 410):
                return None
            if r.status_code >= 500:
                code = r.status_code
                raise RuntimeError("http %s" % r.status_code)
            r.raise_for_status()
            return r.content if binary else r.text
        except requests.exceptions.RequestException as e:
            last = "request: %s" % (e.__class__.__name__,)
        except Exception as e:
            last = str(e)
        if attempt < RETRIES:
            if code == 509:  # bandwidth throttled: back well off before retry
                code = None
                time.sleep(random.uniform(45, 75))
            else:
                time.sleep(2 ** (attempt + 1) + random.random())
    raise RuntimeError("fetch failed after retries: %s (%s)" % (url, last))


# ---------------------------------------------------------------- sitemap ---

def sitemap_locs(xml_text):
    root = ET.fromstring(xml_text)
    return [(el.text or "").strip() for el in root.iter()
            if el.tag.split("}")[-1] == "loc" and el.text]


def collect_species_urls():
    top = sitemap_locs(fetch(BASE + "/sitemap.xml"))
    children = [u for u in top if "species-sitemap" in u]
    urls, seen = [], set()
    for child in children:
        for loc in sitemap_locs(fetch(child)):
            if "/species/" in loc and "/page/" not in loc:
                slug = loc.rstrip("/").rsplit("/", 1)[-1]
                if slug and slug not in seen:
                    seen.add(slug)
                    urls.append(loc)
    return urls


# ------------------------------------------------------------ text helpers ---

def clean_fragment(fragment_nodes):
    """Join sibling nodes of a section heading into cleaned paragraph text."""
    frag = BeautifulSoup("".join(str(s) for s in fragment_nodes), "lxml")
    for sel in NOISE_SEL:
        for el in frag.select(sel):
            el.decompose()
    paras = [p.get_text(" ", strip=True) for p in frag.find_all("p")]
    paras = [p for p in paras if p]
    if not paras:
        t = frag.get_text(" ", strip=True)
        paras = [t] if t else []
    return "\n".join(paras)


def section_nodes(h2):
    out = []
    for sib in h2.next_siblings:
        if getattr(sib, "name", None) in ("h1", "h2"):
            break
        if getattr(sib, "name", None) is None and not str(sib).strip():
            continue
        out.append(sib)
    return out


def _nums(text):
    return [float(x) for x in re.findall(r"\d+(?:\.\d+)?", text.replace(",", ""))]


def _range(text):
    ns = _nums(text)
    if not ns:
        return None
    return [ns[0], ns[-1]] if len(ns) > 1 else [ns[0], ns[0]]


def parse_care(soup):
    care = {"temp_c": None, "ph": None, "hardness_ppm": None,
            "size_cm": None, "size_text": None, "tank_text": None,
            "temp_text": None, "ph_text": None, "hardness_text": None}
    ph_h2 = soup.find("h2", class_="profile_phrange")
    if ph_h2 is not None:
        frag = BeautifulSoup("".join(str(s) for s in section_nodes(ph_h2)), "lxml")
        for sel in NOISE_SEL:
            for el in frag.select(sel):
                el.decompose()
        for p in frag.find_all("p"):
            txt = p.get_text(" ", strip=True)
            m = re.match(r"([A-Za-z ]+?)\s*:\s*(.+)$", txt)
            if not m:
                continue
            label, value = m.group(1).strip().lower(), m.group(2).strip()
            if label.startswith("temperature"):
                care["temp_text"] = value
                r = _range(value)
                if r:
                    if "°f" in value.lower():
                        r = [round((v - 32.0) * 5.0 / 9.0, 1) for v in r]
                    care["temp_c"] = [round(r[0], 1), round(r[1], 1)]
            elif label == "ph":
                care["ph_text"] = value
                r = _range(value)
                if r:
                    care["ph"] = [round(r[0], 1), round(r[1], 1)]
            elif label.startswith("hardness"):
                care["hardness_text"] = value
                if "ppm" in value.lower():
                    r = _range(value)
                    if r:
                        care["hardness_ppm"] = [round(r[0]), round(r[1])]

    size_h2 = soup.find("h2", class_="profile_maxstandardlength")
    if size_h2 is not None:
        text = clean_fragment(section_nodes(size_h2))
        care["size_text"] = text.split("\n")[0] if text else None
        if text:
            r = _range(text.split("\n")[0])
            if r:
                t = text.lower()
                if re.search(r"\bmm\b", t):
                    vals = [v / 10.0 for v in r]
                elif '"' in t or re.search(r"\binch", t):
                    vals = [v * 2.54 for v in r]
                else:  # default cm
                    vals = list(r)
                care["size_cm"] = round(max(vals), 2)

    tank_h2 = soup.find("h2", class_="profile_mintanksize")
    if tank_h2 is not None:
        text = clean_fragment(section_nodes(tank_h2))
        m = re.search(
            r"(\d+(?:\.\d+)?)\s*(?:[∗*x×]|by)\s*(\d+(?:\.\d+)?)"
            r"(?:\s*(?:[∗*x×]|by)\s*(\d+(?:\.\d+)?))?\s*(mm|cm|m)(?![a-z])",
            text, re.IGNORECASE)
        if m:
            dims = [float(g) for g in m.group(1, 2, 3) if g]
            unit = m.group(4).lower()
            if unit == "mm":
                dims = [d / 10.0 for d in dims]
            elif unit == "m":
                dims = [d * 100.0 for d in dims]
            dims = [str(int(d)) if d == int(d) else str(d) for d in dims]
            care["tank_text"] = "x".join(dims) + " cm"
    return care


def parse_water(sections_text):
    t = sections_text.lower()
    if "brackish" in t:
        return "brackish"
    marine = any(k in t for k in ("marine", "sea water", "saltwater"))
    if marine and "freshwater" not in t:
        return "marine"
    return "freshwater"


def _strip_author(s):
    s = s.strip().strip(" ,;")
    s2 = re.sub(r"\s*\([^()]*\d{4}[^()]*\)\s*$", "", s).strip()
    s2 = re.sub(r"\s+[A-Z][A-Za-z'\u2019.\- ]{1,40},?\s*\d{4}\s*$", "", s2).strip(" ,;")
    return s2 or s


# ---------------------------------------------------------------- parsing ---

def parse_profile(slug, url, html):
    soup = BeautifulSoup(html, "lxml")

    title = soup.find("h1", class_="profile_title")
    common = soup.find("h1", class_="profile_commonname")

    scientific_name, author = None, None
    if title is not None:
        t = title.get_text(" ", strip=True)
        m = re.search(r"^(.*?)\s*\(([^()]*\d{4}[^()]*)\)\s*$", t)
        if m is None:
            m = re.match(r"^(.*?)\s+((?:[A-Z][\w'\u2019.\-]*\s*(?:&|,)?\s*){1,3}\d{4})$", t)
        if m is not None:
            scientific_name = m.group(1).strip() or None
            author = "(%s)" % m.group(2).strip()
        else:
            scientific_name = t

    common_names = []
    if common is not None:
        for part in re.split(r"[;,]", common.get_text(" ", strip=True)):
            part = part.strip()
            if part:
                common_names.append(part)

    syn_h2 = soup.find("h2", class_="profile_synonyms")
    synonyms = []
    if syn_h2 is not None:
        text = clean_fragment(section_nodes(syn_h2))
        for part in re.split(r"[;\n]", text):
            part = _strip_author(part)
            if part:
                synonyms.append(part)

    sections = {}
    for h2 in soup.find_all("h2"):
        cls = h2.get("class") or []
        key = SECTION_KEYS.get(cls[0] if cls else "")
        if key:
            sections[key] = clean_fragment(section_nodes(h2))
    sections = {k: sections[k] for k in
                ("distribution", "habitat", "maintenance", "diet",
                 "compatibility", "breeding", "notes") if k in sections}

    # description: intro paragraphs if present, else start of first narrative section
    desc = []
    if common is not None:
        for sib in common.next_siblings:
            if getattr(sib, "name", None) in ("h1", "h2"):
                break
            if getattr(sib, "name", None) == "p":
                desc.append(sib.get_text(" ", strip=True))
    if not desc:
        for key in ("distribution", "habitat", "notes"):
            if sections.get(key):
                desc = sections[key].split("\n")[:3]
                break
    description = "\n".join(p for p in desc if p)[:3000]

    care = parse_care(soup)
    water = parse_water(" ".join(sections.values()) + " " + description)

    image_urls = extract_images(soup)

    return {
        "source": "sf",
        "slug": slug,
        "url": url,
        "scientific_name": scientific_name,
        "author": author,
        "common_names": common_names,
        "synonyms": synonyms,
        "sections": sections,
        "care": care,
        "water": water,
        "description": description,
        "images": [],          # filled after download
        "image_urls": image_urls,
    }


def extract_images(soup):
    urls = []
    anchors = soup.select(".sidebar_pics a[href]")
    anchors += soup.select("a.fancybox[href]")
    for a in anchors:
        href = a.get("href") or ""
        if href.startswith("http"):
            urls.append(href)
    for img in soup.select(".sidebar_pics img"):
        u = img.get("data-ezsrc") or img.get("data-lazy-src") or img.get("src") or ""
        if u.startswith("http"):
            urls.append(u)
    out, seen = [], set()
    for u in urls:
        if "/themes/" in u or "data:" in u:
            continue
        u = u.replace("/ezoimgfmt/", "/")
        u = re.sub(r"-\d+x\d+(?=\.[A-Za-z]+$)", "", u)  # strip WP thumb suffix
        u = u.split("#", 1)[0]
        if u and u not in seen:
            seen.add(u)
            out.append(u)
    return out


# ----------------------------------------------------------------- images ---

def save_image(session_, url, path):
    if os.path.exists(path) and os.path.getsize(path) > 3072:
        return True
    try:
        data = fetch(url, binary=True)
    except Exception:
        return False
    if not data or len(data) < 3072:
        return False
    if HAVE_PIL:
        try:
            from PIL import Image
            im = Image.open(io.BytesIO(data))
            im = im.convert("RGB")
            im.thumbnail((800, 800))
            im.save(path, "JPEG", quality=82)
            return True
        except Exception:
            pass
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    return True


def download_images(rec):
    if SKIP_IMAGES:
        rec["images"] = []
        return 0
    saved = []
    for i, u in enumerate(rec["image_urls"]):
        if len(saved) >= MAX_IMAGES or i >= MAX_IMAGES + 2:
            break
        path = os.path.join(IMG_DIR, "%s-%d.jpg" % (rec["slug"], len(saved) + 1))
        if save_image(session(), u, path):
            saved.append("img/sf/%s-%d.jpg" % (rec["slug"], len(saved) + 1))
    rec["images"] = saved
    return len(saved)


# ------------------------------------------------------------------ main ---

def fail(slug, url, reason):
    with _lock:
        _stats["fail"] += 1
        with open(FAILED, "a", encoding="utf-8") as f:
            f.write("%s\t%s\t%s\n" % (slug, url, reason))


def process(url):
    slug = url.rstrip("/").rsplit("/", 1)[-1]
    try:
        html = fetch(url)
        if html is None:
            fail(slug, url, "http 404/410")
            return
        rec = parse_profile(slug, url, html)
        n_img = download_images(rec)
        with _lock:
            with open(OUT, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                f.flush()
                os.fsync(f.fileno())
            _stats["ok"] += 1
            _stats["imgs"] += n_img
            done = _stats["ok"] + _stats["fail"]
            if done % 50 == 0 or done < 5:
                print("[progress] %d/%d ok=%d fail=%d imgs=%d" %
                      (done, TOTAL, _stats["ok"], _stats["fail"], _stats["imgs"]),
                      flush=True)
    except Exception as e:
        fail(slug, url, repr(e)[:200])
        with _lock:
            if _stats["fail"] >= 60 and _stats["fail"] > _stats["ok"]:
                if not _abort.is_set():
                    print("ABORT: server throttling, resume later", flush=True)
                _abort.set()


def done_slugs():
    slugs = set()
    if not os.path.exists(OUT):
        return slugs
    with open(OUT, encoding="utf-8") as f:
        for line in f:
            try:
                slugs.add(json.loads(line)["slug"])
            except Exception:
                continue
    return slugs


def images_only():
    if not os.path.exists(OUT):
        print("no jsonl yet", flush=True)
        return
    recs = []
    with open(OUT, encoding="utf-8") as f:
        for line in f:
            try:
                recs.append(json.loads(line))
            except Exception:
                continue
    todo = [r for r in recs
            if len(r.get("images") or []) < MAX_IMAGES and r.get("image_urls")]
    print("images-only: %d/%d records need images" % (len(todo), len(recs)),
          flush=True)
    added = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(download_images, r): r for r in todo}
        for i, fut in enumerate(as_completed(futs), 1):
            fut.result()
            added += len(futs[fut]["images"])
            if i % 25 == 0:
                print("[images] %d/%d (+%d)" % (i, len(todo), added), flush=True)
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        for r in recs:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, OUT)
    print("IMAGES-ONLY DONE added=%d" % added, flush=True)


def main():
    global TOTAL
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    os.makedirs(IMG_DIR, exist_ok=True)

    if "--images-only" in sys.argv:
        images_only()
        return

    urls = collect_species_urls()
    TOTAL = len(urls)
    print("species urls: %d" % TOTAL, flush=True)
    skip = done_slugs()
    todo = [u for u in urls if u.rstrip("/").rsplit("/", 1)[-1] not in skip]
    print("already done: %d, todo: %d" % (len(skip), len(todo)), flush=True)
    if not todo:
        print("nothing to do", flush=True)
        return

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = [ex.submit(process, u) for u in todo]
        for fut in as_completed(futs):
            fut.result()
            if _abort.is_set():
                for f in futs:
                    f.cancel()
                break
    print("DONE ok=%d fail=%d imgs=%d" %
          (_stats["ok"], _stats["fail"], _stats["imgs"]), flush=True)


if __name__ == "__main__":
    sys.exit(main())
