#!/usr/bin/env python3
"""Build a de-noised zh.json map from the Baidu Baike harvest (data/raw/zh*.jsonl).

The harvester (scrape/zh_harvest*.js) writes one JSON object per line, and its
search-card path (via='search') frequently returns family/genus-level terms
(e.g. "迷鳃鱼类" for many Betta) or a neighbouring species. This step:

  1. keeps only all-Han names of 2-12 chars,
  2. drops taxonomy-rank / noise suffixes (科/属/目/纲/亚科/鱼类/类型/图谱...),
  3. drops a name assigned to >=2 distinct genera UNLESS a high/medium
     confidence source (item-fetch or the base zh.jsonl) produced it — in that
     case the name is kept for those sources and dropped for search-derived ones.

Output: data/raw/zh.json  { <norm_sci>: {"zh":..., "aliases":[...]} }
"""
import json
import pathlib
import re
from collections import defaultdict

RAW = pathlib.Path(__file__).resolve().parent / "raw"
OUT = RAW / "zh.json"

SUFFIX_BAD = re.compile(r"(科|属|目|纲|亚科|亚目|鱼类|鱼科|总科|总称|分类|品种|类型|类|图谱)$")
HAN = re.compile(r"^[\u4e00-\u9fff\u3400-\u4dbf]{2,12}$")


def norm_sci(s):
    if not s:
        return None
    return re.sub(r"\s+", " ", s).strip().lower() or None


def _conf(via):
    if via == "inat":
        return "inat"
    if via == "item-fetch":
        return "high"
    if via is None:
        return "med"
    return "low"


def build_zh_map():
    # sci -> {name: (conf, is_primary)}; a name may come from base + shard files.
    by_sci = defaultdict(dict)
    name_genera = defaultdict(set)
    for p in sorted(RAW.glob("zh*.jsonl")):
        if not p.exists():
            continue
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            key = norm_sci(r.get("sci"))
            if not key:
                continue
            c = _conf(r.get("via"))
            items = []
            if r.get("zh"):
                items.append(("zh", r["zh"]))
            for a in (r.get("aliases") or []):
                items.append(("alias", a))
            for kind, nm in items:
                nm = nm.strip()
                if not nm or not HAN.match(nm) or SUFFIX_BAD.search(nm):
                    continue
                g = key.split()[0].lower() if key else ""
                name_genera[nm].add(g)
                cur = by_sci[key].get(nm)
                isp = 1 if kind == "zh" else 0
                pk = {"inat": 4, "high": 3, "med": 2, "low": 1}
                if cur is None or pk[c] > pk[cur[0]] or (pk[c] == pk[cur[0]] and isp > cur[1]):
                    by_sci[key][nm] = (c, isp)

    def is_generic(nm):
        return len(name_genera.get(nm, set())) >= 2

    out = {}
    for key, d in by_sci.items():
        cands = []
        for nm, (c, isp) in d.items():
            if is_generic(nm) and c not in ("inat", "high", "med"):
                continue
            cands.append((nm, c, isp))
        if not cands:
            continue
        cands.sort(key=lambda t: ({"inat": 0, "high": 1, "med": 2, "low": 3}[t[1]], 0 if t[2] else 1))
        prim = [n for n, c, i in cands if i]
        z = (prim or [cands[0][0]])[0]
        al = [n for n, c, i in cands if n != z][:3]
        out[key] = {"zh": z, "aliases": al}

    OUT.write_text(json.dumps(out, ensure_ascii=False))
    return out


if __name__ == "__main__":
    m = build_zh_map()
    n = sum(1 for v in m.values() if v.get("zh"))
    print(f"build_zh: keyed={len(m)} with_zh={n} -> {OUT}")
