#!/usr/bin/env python3
"""Fetch iNaturalist default photos for Baidu-added species lacking an image.
Download locally (app/img/inat/<slug>.jpg) and write data/raw/inat_img.json
{ <norm_sci>: "img/inat/<slug>.jpg" } for merge.py. Breakpoint per sci.
"""
import json
import os
import pathlib
import re
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

ROOT = pathlib.Path(__file__).resolve().parent.parent
APP = ROOT / "app/data/species.json"
IMG_DIR = ROOT / "app/img/inat"
OUT = ROOT / "data/raw/inat_img.json"
WORKERS = int(os.environ.get("INATIMG_WORKERS", "3"))
_tls = threading.local()


def norm(s):
    return " ".join(s.lower().replace("-", " ").split()) if s else None


def session():
    if not hasattr(_tls, "s"):
        _tls.s = requests.Session()
        _tls.s.headers["User-Agent"] = "Aquapedia/1.0 (local research)"
    return _tls.s


def targets():
    d = json.loads(APP.read_text(encoding="utf-8"))
    out = []
    for s in d["species"]:
        if s["id"].startswith("nf:") and not s.get("images") and s.get("scientific_name"):
            out.append(s["scientific_name"])
    return out


def photo_url(sci):
    # try the species name first, then fall back to the genus (first word); some
    # aquarium species lack an iNat species-level entry but have a genus photo.
    queries = [sci]
    gen = sci.split()[0] if sci.split() else sci
    if gen != sci:
        queries.append(gen)
    for query in queries:
        url = "https://api.inaturalist.org/v1/taxa?q=" + urllib.parse.quote(query) + "&per_page=1"
        try:
            r = session().get(url, timeout=30)
            if r.status_code == 429:
                time.sleep(8)
                r = session().get(url, timeout=30)
            if r.status_code != 200:
                continue
            data = r.json()
        except Exception:
            continue
        res = data.get("results") or []
        if not res:
            continue
        dp = (res[0].get("default_photo") or {})
        u = dp.get("medium_url") or dp.get("url")
        if u:
            return u
    return None


def slug(sci):
    return re.sub(r"\s+", "-", sci.lower())


def download(url, dest):
    if dest.exists() and dest.stat().st_size > 3000:
        return True
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        r = session().get(url, timeout=40)
        if r.status_code == 200 and len(r.content) > 3000:
            dest.write_bytes(r.content)
            return True
    except Exception:
        pass
    return False


def main():
    tg = targets()
    print("inat_img targets:", len(tg))
    mapping = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    pending = [s for s in tg if norm(s) not in mapping]
    print("pending:", len(pending))
    got = 0

    def work(sci):
        u = photo_url(sci)
        if not u:
            return sci, None
        fn = slug(sci) + ".jpg"
        dest = IMG_DIR / fn
        if download(u, dest):
            return sci, "img/inat/" + fn
        return sci, None

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(work, s): s for s in pending}
        for f in as_completed(futs):
            s = futs[f]
            try:
                sci, path = f.result()
            except Exception:
                sci, path = s, None
            if path:
                mapping[norm(sci)] = path
                got += 1
            time.sleep(0.5)

    OUT.write_text(json.dumps(mapping, ensure_ascii=False))
    print(f"INAT IMG DONE got={got} total_mapped={len(mapping)}")


if __name__ == "__main__":
    main()
