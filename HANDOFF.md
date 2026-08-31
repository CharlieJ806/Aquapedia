# 交接文档 — 水族百科 v2 → 下一任 Agent

> 写于 2026-08-28。面向后续接手本项目的 agent：先读「当前状态」，再做「未完成工作」。
> 操作类知识（浏览器收割、edit 工具坑）在「关键操作知识」，动手前必读。
>
> **v3 更新（2026-08-31）**：项目已改名 `Z:/Files/Aquapedia`，所有收割脚本路径已修正为 Aquapedia。
> 新增哔哩哔哩水族热度选种（`scrape/bili_heat.js` → `data/raw/bili_heat.jsonl`，中文平台、免登录、播放量做热度）
> 与热门缺失物种补充（`scrape/zh_baike_hot.js` → `data/raw/zh_baike_hot.jsonl`，百度百科中文名+正文）。
> 最新状态：物种 **1263**（图鉴只留有中文数据源的物种；无中文名 SF 冷门鱼已剔除），中文名 **1263（100%）**，有图 **1216/1263**，商品 2975。
> 物品档案 = LiveAquaria 器材+饲料商品（**853** 条，带图+人民币价格，过滤「全部/器材/设备/饲料」）；物种类型过滤已去掉器材/饲料；非鱼物种补图：LiveAquaria 同学名商品图 + iNaturalist 照片兜底（`scrape/inat_img.py` → `data/raw/inat_img.json`），全站有图 **1202/1251**（仅 2 个 nf 物种无图源）。中文名覆盖率以 README 为准；
> 下文「当前状态」表（751 中文名、物种 1804 等）已过时，仅作历史参考。

## 项目概况

本地离线水族百科：Seriously Fish（1804 篇物种饲养档案）× LiveAquaria（2944 条在售商品）
× 百度百科中文名（751 个已验证）× 人民币价格（固定近似汇率 7.2）。

```bash
python serve.py   # → http://127.0.0.1:8790（禁缓存头，端口写死在 serve.py）
```

纯静态前端，无构建步骤。图片 360MB 已全部本地化 `app/img/{sf,la}/`。

## 当前状态（v2 已交付，全部验证过）

| 项 | 状态 |
| --- | --- |
| 物种数据 | 1804/1804 渲染，0 坏图 |
| 商品数据 | 2944/2944 渲染，0 坏图 |
| 中文名 | **751 个**（zh_hits=755 含商品侧 4 个），物种覆盖 42%，按热度优先命中 |
| 价格 | 展示 ¥（CNY 整数），`price_usd` 保留原始美元；`RATE = 7.2` 固定常量（用户明确不要每日实时汇率） |
| 前端 | 三 Tab：物种档案 / 在售商品 / **模拟鱼缸**（用户自己加的 tank.js，已共存验证） |
| README | 已更新（数据口径、中文名验证规则、管道说明） |

### 数据结构（app/data/species.json）

```
顶层: { generated, stats: {species, with_price, with_zh, freshwater, marine, products} }
      ⚠ 顶层 rate/rate_date 已随固定汇率移除，别在旧文档里找
条目: { ..., price: {min,max,currency:"CNY"}, price_usd: {min,max,currency:"USD"},
        name_zh: string|null, zh_aliases: string[] }
```

### 文件地图

```
app/index.html          三 Tab 布局；script 顺序 app.js → tank.js（顺序别动）
app/assets/app.js       主应用：筛选/搜索/卡片/详情弹窗（v2 已全部中文化+¥化）
app/assets/tank.js      用户写的模拟鱼缸（自包含 IIFE，自己 fetch 数据，localStorage 存缸）
app/assets/style.css    样式（卡片 .name/.sci 两行结构）
app/data/species.json   前端数据包（merge.py 产物，17.7MB）
data/merge.py           合并器：SF+LA+zh → species.json（含图片下载/清洗/换汇）
data/raw/sf.jsonl       SF 抓取产物
data/raw/la.json        LA 抓取产物
data/raw/zh.json        中文名汇总（merge 的输入，由 jsonl 生成，见下）
data/raw/zh.jsonl / zh_a.jsonl / zh_b.jsonl      SF 学名收割断点（a/b 双分片）
data/raw/zh_la_a.jsonl / zh_la_b.jsonl           LA 学名收割断点（可能还不存在）
scrape/sf.py, la.py     站点抓取器（已完成使命，数据齐全）
scrape/zh_harvest.js / _b.js        SF 学名收割器（slice(0,40) 小批量版）
scrape/zh_harvest_la.js / _la_b.js  LA 学名收割器（仍是 slice(0,120)，建议同步调小）
```

## 未完成工作（按优先级）

### 1. 百度中文名续收（当前被 IP 反爬挡住）

- SF 侧剩 ~1050 个学名、LA 商品侧 ~1100 个唯一学名未收。
- **探测解封**：浏览器打开 `https://baike.baidu.com/item/fish`，title 是「百度安全验证」= 仍封锁；
  正常词条 = 解封。封锁是 IP 级，清 cookie 无用。冷却时长约 10–20 分钟，但最近一次封锁持续更久。
- **解封后操作**（两个 tab 并行，timeout 292s，xd://browser run）：

```js
// tab "baike"：
const src = require('fs').readFileSync('Z:/Files/baike/scrape/zh_harvest.js', 'utf8');
const fn = new Function('page','tab','require','return (async () => {'+src+'})()');
return await fn(page, tab, require);
// tab "baike2"：同样方式跑 zh_harvest_b.js；LA 阶段换 zh_harvest_la.js / zh_harvest_la_b.js
```

- 收割器自带断点续传（done-set 读 jsonl）+ 检测到「百度安全验证」即 abort，**append 模式不怕中断**，
  超时/被封后直接重跑即可。每轮结束 `wc -l data/raw/zh_*.jsonl` 看进度。
- 建议节奏：小批量（slice 40）× 多轮，比一次 120 更不容易触发封锁；被封就停手等下一窗口。

- **每轮收割后**：跑下面的汇总 → merge → 验收：

```bash
python -c "
import json
seen = {}
for f in ['data/raw/zh.jsonl','data/raw/zh_a.jsonl','data/raw/zh_b.jsonl',
          'data/raw/zh_la_a.jsonl','data/raw/zh_la_b.jsonl']:
    try:
        for l in open(f, encoding='utf8'):
            if not l.strip(): continue
            r = json.loads(l)
            k = r['sci'].lower()
            if k not in seen or (r.get('zh') and not seen[k].get('zh')): seen[k] = r
    except FileNotFoundError: pass
out = {r['sci'].lower(): {'zh': r['zh'], 'aliases': r.get('aliases') or []}
       for r in seen.values() if r.get('zh')}
json.dump(out, open('data/raw/zh.json','w',encoding='utf8'), ensure_ascii=False, indent=0)
print('zh:', len(out))"
python data/merge.py
```

### 2. 收割全部完成后的收尾

- README 数据口径表更新覆盖率数字。
- 交付说明：最终中文名覆盖率、LA 商品页中文名抽查（详情弹窗 H2）。

### 3. 可选打磨（用户未要求，别主动扩）

- 商品卡无学名时 `.sci` 副行显示 description 截断，器材类开头常是 "* WIFI…"，略噪但沿用旧行为。
- LA 学名分片脚本里 `slice(0,120)` 未调小。

## 关键操作知识（踩过的坑，必读）

### edit 工具在本项目大文件上不可信

本会话 merge.py 因行号错位出过 **3 次事故**（`la = load_la()` 被覆盖、water 判断行被覆盖、
函数体叠加），每次都靠 read 回读修复。规则：

- **编辑前必须 `read` 拿真实行号**，每次编辑后核对返回的行号上下文，发现叠行/错位立即回读修复；
- 大段重构宁可整个函数 `PUT N*:` 重写，不要信任跨 hunks 的行号推算；
- 改完 python 文件先 `python -c "import ast; ast.parse(open('data/merge.py',encoding='utf8').read())"`。

### 浏览器收割（xd://browser）

- run 代码模式硬上限 300s，harvest 按 292s 超时设计。
- `tab.goto` 后紧跟 `tab.evaluate` 会 context destroyed —— 必须 `.then(() => tab.evaluate(...))` 链式。
- harvest 文件用 `new Function('page','tab','require',...)` 包装执行（见上）。
- 收割器已内置：同源 fetch 三层策略、拉丁学名验证、脏词黑名单、0.3–0.7s 随机延迟。
- 百度封锁探测不要用 requests（403），必须真 Chromium（百度对无头/脚本 UA 有指纹识别，
  纯 requests 全挂，Chromium 同源 fetch 可行——这是当初选型结论）。

### 前端验证（无测试套件，禁止跑；纯静态无构建）

- `node --check app/assets/app.js`（tank.js 同理）验语法。
- 浏览器验收清单：1804/1804 与 2944/2944 全渲染、搜「斗鱼」「灯鱼」有中文命中、
  卡片中文主标题+斜体学名副行、¥ 角标、价格滑杆（max 8000）生效、详情弹窗中文名、0 坏图、
  三 Tab 切换互斥正常（tank tab 隐藏 main/toolbars）。
- 浏览器 tab 缓存坑：强刷用 `?v=N` 新导航（tab.reload/$$eval 不存在）；eval 里调
  `location.reload()` 会毁掉执行上下文，宁可关 tab 重开。
- 本地服务是 hub 常驻进程 `aquapedia`（serve.py），验收前确认它活着。

### 工程纪律

- 礼貌抓取：并发 ≤2、随机延迟、浏览器 UA、jsonl 逐条落盘。数据仅供个人学习，页脚已有声明。
- 数据诚实原则：中文名只在词条内容含该拉丁学名时采信，查不到留英文，**不造译名**。
- 价格口径：用户拍板「大致范围即可」，RATE=7.2 写死，不要再加回实时汇率。
- 物种正文保持 SF 英文原貌不翻译，中文名只做标题/检索增强。

## 环境备忘

- Windows 11，工作目录 `Z:/Files/baike`。
- 百度封锁状态（截至交接）：**封锁中**，探测命令见上。
- 浏览器 tab 名约定：`aquapedia`=本地验收、`baike`/`baike2`=收割双分片、`aqua3`=最后一次验收用的新 tab。
- LA 学名来源：`data/raw/la.json` 里 `scientific_name` 去重排序（zh_harvest_la*.js 已实现）。
