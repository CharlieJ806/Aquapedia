#!/usr/bin/env python3
"""Harvest Chinese common names from iNaturalist for species lacking a name.

Why: Baidu Baike is IP-blocked by anti-bot; iNaturalist gives an authoritative
sci -> Chinese common name mapping via a free public JSON API (no anti-bot).

Honesty rule (same as Baidu): accept a name ONLY when the returned taxon is an
active species whose name exactly equals the queried scientific name. Reject
fuzzy mis-matches (e.g. "Badis badis" -> "Badister", a beetle genus). Names are
converted Traditional -> Simplified (opencc) to match the rest of the app.

Uses a keep-alive requests.Session (fresh per-request TLS was the bottleneck).

Output: data/raw/zh_inat.jsonl  {sci, zh, via:'inat'} (append). Every queried
sci is written (zh=null on miss) so re-runs resume and skip already-queried ones.
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
APP_DATA = ROOT / "app/data/species.json"
OUT = ROOT / "data/raw/zh_inat.jsonl"
UA = {"User-Agent": "Aquapedia/1.0 (local research)"}
WORKERS = int(os.environ.get("INAT_WORKERS", "4"))
_tls = threading.local()


def session():
    if not hasattr(_tls, "s"):
        _tls.s = requests.Session()
        _tls.s.headers.update(UA)
    return _tls.s

try:
    from opencc import OpenCC
    CC = OpenCC("t2s")
except Exception:
    CC = None


def norm(s):
    return " ".join(s.lower().replace("-", " ").split()) if s else None


def load_targets():
    d = json.loads(APP_DATA.read_text(encoding="utf-8"))
    uniq = {}
    for arr in (d["species"], d["products"]):
        for rec in arr:
            k = norm(rec.get("scientific_name"))
            if k and not rec.get("name_zh") and k not in uniq:
                uniq[k] = rec.get("scientific_name")
    return list(uniq.values())


def done_set():
    # Only treat entries that yielded a name as done; requery None ones (they may
    # have been 429 false-misses), so both hits survive and rate-limited gaps recover.
    done = set()
    if OUT.exists():
        for line in OUT.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
                if r.get("zh"):
                    done.add(norm(r.get("sci")))
            except Exception:
                pass
    return done


def query(sci):
    url = ("https://api.inaturalist.org/v1/taxa?q=" + urllib.parse.quote(sci)
           + "&locale=zh-CN&per_page=1")
    try:
        r = session().get(url, timeout=30)
        if r.status_code == 429:
            time.sleep(8)
            r = session().get(url, timeout=30)
        if r.status_code != 200:
            return None
        data = r.json()
    except Exception:
        return None
    res = data.get("results") or []
    if not res:
        return None
    t = res[0]
    if t.get("rank") != "species" or not t.get("is_active", True):
        return None
    if norm(t.get("name")) != norm(sci):
        return None
    cn = (t.get("preferred_common_name") or "").strip()
    if not cn:
        return None
    if CC:
        cn = CC.convert(cn)
    if not re.search(r"[\u4e00-\u9fff]", cn):
        return None
    return cn


def main():
    target = load_targets()
    done = done_set()
    todo = [s for s in target if norm(s) not in done]
    print(f"inat: targets={len(target)} done={len(done)} todo={len(todo)} workers={WORKERS}", flush=True)
    if not todo:
        print("INAT NOTHING TO DO", flush=True)
        return
    lock = threading.Lock()
    with open(OUT, "a", encoding="utf-8") as f:
        def work(sci):
            time.sleep(1.0)
            cn = query(sci)
            with lock:
                f.write(json.dumps({"sci": sci, "zh": cn, "via": "inat"}, ensure_ascii=False) + "\n")
                f.flush()
            return sci, cn
        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            futs = {ex.submit(work, s): s for s in todo}
            n = 0
            for fut in as_completed(futs):
                sci, cn = fut.result()
                n += 1
                if n <= 3 or n % 50 == 0:
                    print(f"[inat] {n}/{len(todo)} +{int(bool(cn))} {sci}->{cn}", flush=True)
    print("INAT DONE", flush=True)


if __name__ == "__main__":
    main()
