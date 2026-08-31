#!/usr/bin/env python3
"""Translate Seriously Fish English body (description + care sections) to Simplified Chinese.

Why: the app targets Chinese hobbyists, but Seriously Fish content is English-only and
no free comprehensive Chinese source exists. A paced, resumable machine translation
(Google translate gtx endpoint) provides a Chinese 简介/正文. Quality is MT-level.

Chunks text > 700 chars per request, paces requests, retries on 429/5xx, and caches
results to data/raw/zh_translate.jsonl keyed by item id so re-runs resume and skip done.

Output: data/raw/zh_translate.jsonl  {"id","desc_zh","sections_zh"}  (append).
"""
import json
import os
import pathlib
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = pathlib.Path(__file__).resolve().parent.parent
APP_DATA = ROOT / "app/data/species.json"
OUT = ROOT / "data/raw/zh_translate.jsonl"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36"}
WORKERS = int(os.environ.get("TRANS_WORKERS", "3"))
CHUNK = 700
_tls = threading.local()


def session():
    if not hasattr(_tls, "s"):
        _tls.s = urllib.request.build_opener()
        _tls.s.addheaders = [("User-Agent", UA["User-Agent"])]
    return _tls.s


def translate(text):
    """Translate a block of English text to Simplified Chinese via Google gtx."""
    pieces = []
    for i in range(0, len(text), CHUNK):
        pieces.append(text[i:i + CHUNK])
    out = []
    for piece in pieces:
        q = urllib.parse.quote(piece)
        url = ("https://translate.googleapis.com/translate_a/single?client=gtx"
               "&sl=en&tl=zh-CN&dt=t&q=" + q)
        data = None
        for attempt in range(5):
            try:
                with session().open(url, timeout=30) as r:
                    body = json.loads(r.read().decode("utf-8"))
                data = "".join(seg[0] for seg in body[0] if seg and seg[0])
                break
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    time.sleep(8 + attempt * 4)
                elif e.code >= 500:
                    time.sleep(4 + attempt * 2)
                else:
                    break
            except Exception:
                time.sleep(3)
        if data:
            out.append(data)
        time.sleep(1.2)
    return "".join(out).strip() if out else None


def done_set():
    done = set()
    if OUT.exists():
        for line in OUT.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                done.add(json.loads(line)["id"])
            except Exception:
                pass
    return done


def load_targets():
    d = json.loads(APP_DATA.read_text(encoding="utf-8"))
    targets = []
    for group in (d["species"], d["products"]):
        for rec in group:
            desc = (rec.get("description") or "").strip()
            # By default translate only the intro (简介) — the care sections are
            # ~10M chars and would take many hours. Enable with TRANS_SECTIONS=1.
            secs = {}
            if os.environ.get("TRANS_SECTIONS", "0") == "1":
                secs = {k: v for k, v in (rec.get("sections") or {}).items() if v and re.search(r"[A-Za-z]{3,}", v)}
            text = desc + (" ||| " if secs else "") + " ||| ".join(secs.values())
            if re.search(r"[A-Za-z]{3,}", text or ""):
                targets.append({"id": rec["id"], "desc": desc, "sections": secs})
    return targets


def work(t, done):
    if t["id"] in done:
        return None
    desc_zh = translate(t["desc"]) if t["desc"] else None
    sections_zh = {}
    for k, v in t["sections"].items():
        zh = translate(v)
        if zh:
            sections_zh[k] = zh
    return {"id": t["id"], "desc_zh": desc_zh, "sections_zh": sections_zh}


def main():
    targets = load_targets()
    done = done_set()
    todo = [t for t in targets if t["id"] not in done]
    print(f"translate: targets={len(targets)} done={len(done)} todo={len(todo)} workers={WORKERS}", flush=True)
    lock = threading.Lock()
    n = 0
    with open(OUT, "a", encoding="utf-8") as f:
        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            futs = {ex.submit(work, t, done): t for t in todo}
            for fut in as_completed(futs):
                res = fut.result()
                if res is None:
                    continue
                n += 1
                with lock:
                    f.write(json.dumps(res, ensure_ascii=False) + "\n")
                    f.flush()
                if n <= 3 or n % 25 == 0:
                    print(f"[translate] {n}/{len(todo)} {res['id']} -> zh {len(res['desc_zh'] or '')} chars", flush=True)
    print("TRANSLATE DONE", flush=True)


if __name__ == "__main__":
    main()
