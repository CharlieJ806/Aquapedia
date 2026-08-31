#!/usr/bin/env python3
"""Rank aquarium species by Bilibili content heat, cross-referenced with the encyclopedia.

Reads data/raw/bili_heat.jsonl (kw, title, play, tag, typeid). Keeps only
aquarium-relevant records (excludes music/food/game/drama noise), sums play per
species keyword, and reports which popular species are missing from species.json.
"""
import json
import re
from collections import defaultdict
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
HEAT = ROOT / "data/raw/bili_heat.jsonl"
APP = ROOT / "app/data/species.json"

# Partitions that are aquarium content (动物圈/生活/日常/野生/纪录片).
AQUA_TYPES = {"222", "75", "161", "221", "201", "254", "206"}
# Partitions that are clearly NOT aquarium (音乐/美食/游戏/动画/剧集).
NOISE_TYPES = {"21", "76", "172", "183", "4", "119", "130", "138"}
# Aquatic context words that appear alongside aquarium content.
AQUA_RE = re.compile(
    r"鱼缸|水族|养鱼|造景|水草|观赏鱼|热带鱼|海水|珊瑚|虾缸|观赏虾|观赏螺|青鳉|溪流|"
    r"草缸|繁殖|鱼苗|野采|原生|鱼友|水草缸|鱼塘|鲷|鳉|龟|虾|螺|鱼")

# Keywords that name a (likely) aquarium species rather than a broad category.
BROAD = {"观赏鱼", "水族", "养鱼", "鱼缸", "水族造景", "草缸", "热带鱼", "海水缸",
         "珊瑚", "观赏虾", "观赏螺", "原生鱼", "鱼缸开缸", "养鱼经验", "水草"}


def is_aqua(r):
    if r.get("typeid") in NOISE_TYPES:
        return False
    blob = (r.get("title") or "") + " " + (r.get("tag") or "")
    if not AQUA_RE.search(blob):
        return False
    return True


def main():
    heat = defaultdict(lambda: [0, 0])  # kw -> [total_play, count]
    for line in open(HEAT, encoding="utf8"):
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except Exception:
            continue
        if not is_aqua(r):
            continue
        h = heat[r["kw"]]
        h[0] += r.get("play") or 0
        h[1] += 1

    # Cross-reference with encyclopedia (name_zh or sci or title).
    d = json.load(open(APP, encoding="utf8"))
    species = d["species"]
    by_zh = {}
    for s in species:
        n = (s.get("name_zh") or "").strip()
        if n:
            by_zh.setdefault(n, s)
        sci = (s.get("scientific_name") or "").lower().split()
        # also index by first-given Latin genus+species? handled below via sci string
    # build a set of all ascii sci lowercase for matching
    def lookup(kw):
        # find a species whose name_zh equals the keyword, or sci common term
        if kw in by_zh:
            return by_zh[kw]
        # match by species name being substring of another name_zh (e.g. 灯鱼 within "红绿灯鱼")
        for n, s in by_zh.items():
            if kw in n:
                return s
        return None

    rows = []
    for kw, (tot, cnt) in heat.items():
        if kw in BROAD:
            continue
        s = lookup(kw)
        present = bool(s and s.get("name_zh"))
        rows.append({"kw": kw, "play": tot, "count": cnt, "present": present,
                     "present_id": (s or {}).get("id") if present else None})
    rows.sort(key=lambda x: -x["play"])

    print("=== 物种关键词热度排名 (水族相关, 按总播放) ===")
    print(f"{'词':<10}{'总播放':>10}{'条数':>6}  图鉴")
    for r in rows:
        flag = f"{r['present_id']}" if r["present"] else "❌缺失"
        print(f"{r['kw']:<12}{r['play']:>10}{r['count']:>6}  {flag}")

    miss = [r for r in rows if not r["present"]]
    print("\n=== 图鉴缺失的热门物种 (按热度) ===")
    for r in miss[:30]:
        print(f"  {r['kw']:<12} play={r['play']} count={r['count']}")


if __name__ == "__main__":
    main()
