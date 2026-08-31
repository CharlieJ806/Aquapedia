#!/usr/bin/env python3
"""Harvest Chinese names for non-fish aquarium organisms (plants/coral/invertebrates).

Builds the organism list from LiveAquaria's scientific names whose product is a
plant/coral/invertebrate, queries iNaturalist for the Chinese name, and keeps only
taxa that are NOT fish (iconic_taxon_name != Actinopterygii) and whose name matches
the queried scientific name. Output: data/raw/zh_inat_nonfish.jsonl (append, resumable).
"""
import json
import os
import pathlib
import re
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = pathlib.Path(__file__).resolve().parent.parent
LA = ROOT / "data/raw/la.json"
OUT = ROOT / "data/raw/zh_inat_nonfish.jsonl"
UA = {"User-Agent": "Aquapedia/1.0 (local research)"}
WORKERS = int(os.environ.get("NONFISH_WORKERS", "3"))
_tls = threading.local()

BINO = re.compile(r"^[A-Z][a-z]+ [a-z][a-z\-]*$")
_INV = re.compile(r"marine invert|freshwater invert|freshwater shrimp|\banemone|\bcrab\b|\bshrimp\b|\bsnail\b|\burchin\b|starfish|invertebrate")
_FOOD = re.compile(r"\bfood\b|frozen food|dry food|feeder")
_EQUIP = re.compile(r"hard good|filter|lighting|\bpump\b|stand|canopy|aquascap|controller|conditioner|additive|heater|\bsump\b|skimmer|\bled\b|test kit|aquarium supply|pond supply|\bsalt\b")


def norm(s):
    return " ".join(s.lower().replace("-", " ").split()) if s else None


def ptype(r):
    cat = r.get("category") or ""
    blob = (" ".join(r.get("tags") or []) + " " + (r.get("title") or "")).lower()
    if cat in ("fresh_fish", "marine_fish"):
        return "fish"
    if cat == "plant":
        return "plant"
    if cat == "coral":
        return "coral"
    if cat in ("fresh_invert", "marine_invert") or _INV.search(blob):
        return "invertebrate"
    if _FOOD.search(blob):
        return "food"
    if _EQUIP.search(blob):
        return "equipment"
    return "other"


def session():
    if not hasattr(_tls, "s"):
        _tls.s = urllib.request.build_opener()
        _tls.s.addheaders = [("User-Agent", UA["User-Agent"])]
    return _tls.s


def targets():
    la = json.loads(LA.read_text(encoding="utf-8"))
    uniq = {}
    for r in la:
        sci = (r.get("scientific_name") or "").strip()
        if not sci or not BINO.match(sci):
            continue
        t = ptype(r)
        if t not in ("plant", "coral", "invertebrate"):
            continue
        k = norm(sci)
        if k not in uniq:
            uniq[k] = {"sci": sci, "type": t, "water": r.get("water")}
    return list(uniq.values())


def done_set():
    done = set()
    if OUT.exists():
        for line in OUT.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
                if r.get("name_zh"):
                    done.add(norm(r.get("sci")))
            except Exception:
                pass
    return done


def query(sci):
    url = ("https://api.inaturalist.org/v1/taxa?q=" + urllib.parse.quote(sci)
           + "&locale=zh-CN&per_page=1")
    try:
        with session().open(url, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None
    res = data.get("results") or []
    if not res:
        return None
    t = res[0]
    iconic = t.get("iconic_taxon_name") or ""
    if iconic == "Actinopterygii":  # a fish (mis-labelled LA product) — reject
        return None
    if t.get("rank") != "species" or not t.get("is_active", True):
        return None
    if norm(t.get("name")) != norm(sci):
        return None
    cn = (t.get("preferred_common_name") or "").strip()
    if not cn:
        return None
    return cn


def main():
    tg = targets()
    done = done_set()
    todo = [t for t in tg if norm(t["sci"]) not in done]
    print(f"nonfish: targets={len(tg)} done={len(done)} todo={len(todo)}", flush=True)
    lock = threading.Lock()
    with open(OUT, "a", encoding="utf-8") as f:
        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            futs = {ex.submit(query, t["sci"]): t for t in todo}
            n = 0
            for fut in as_completed(futs):
                t = futs[fut]
                cn = fut.result()
                n += 1
                with lock:
                    f.write(json.dumps({"sci": t["sci"], "type": t["type"], "water": t["water"], "name_zh": cn}, ensure_ascii=False) + "\n")
                    f.flush()
                if n <= 3 or n % 25 == 0:
                    print(f"[nonfish] {n}/{len(todo)} {t['sci']}->{cn}", flush=True)
    print("NONFISH DONE", flush=True)


if __name__ == "__main__":
    main()
