// 百度百科 追加生物正文收割器 v1 — 在 browser run 作用域内 new Function 执行（page/tab/require 可用）
// 抓追加生物(海边鱼/淡水鱼/水草/珊瑚/无脊椎)的中文正文作主内容。断点：zh_baike_add.jsonl 已记录的 sci 跳过。
const fs = require('fs');

const NAMED = fs.readFileSync('Z:/Files/Aquapedia/data/raw/zh_inat_add.jsonl', 'utf8')
  .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.name_zh);
const outPath = 'Z:/Files/Aquapedia/data/raw/zh_baike_add.jsonl';
const done = new Set(
  fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).sci.toLowerCase()) : []
);
const SHARD = (typeof __SHARD !== 'undefined') ? __SHARD : 'a';
const pending = NAMED
  .filter((r) => !done.has(r.sci.toLowerCase()))
  .filter((r) => (r.sci.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 2) === (SHARD === 'a' ? 0 : 1))
  .slice(0, 40);

let ok = 0, miss = 0, abort = null;
const log = fs.createWriteStream(outPath, { flags: 'a' });

const onBaike = await tab.evaluate(() => location.hostname === 'baike.baidu.com').catch(() => false);
if (!onBaike) {
  await tab.goto('https://baike.baidu.com/item/观赏鱼', { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
}

async function fetchItem(word, sci) {
  const r = await tab.evaluate(async (w, s) => {
    const resp = await fetch('/item/' + encodeURIComponent(w), { credentials: 'include' });
    if (resp.status !== 200) return null;
    const t = await resp.text();
    if (t.length < 20000) return null;
    const title = (t.match(/<title>([^<]+?)_百度百科<\/title>/) || [])[1] || null;
    if (!title || /安全验证/.test(title)) return null;
    const doc = new DOMParser().parseFromString(t, 'text/html');
    const paras = [...doc.querySelectorAll('div[class*="para"]')]
      .map((p) => p.innerText.trim())
      .filter((x) => x && /[\u4e00-\u9fff]/.test(x) && x.length > 25);
    const body = paras.slice(0, 4).join('\n');
    if (!body || !body.toLowerCase().includes(s.toLowerCase())) return null; // not this species' article
    return { title: title.replace(/（[^）]*）$/, '').trim(), body };
  }, word, sci);
  return r;
}

for (const r of pending) {
  if (abort) break;
  let got = null;
  try { got = await fetchItem(r.sci, r.sci); } catch (e) {}
  await new Promise((rr) => setTimeout(rr, 300));
  if (!got) { try { got = await fetchItem(r.name_zh, r.sci); } catch (e) {} await new Promise((rr) => setTimeout(rr, 300)); }
  if (got && got.body) { log.write(JSON.stringify({ sci: r.sci, name_zh: got.title, body_zh: got.body, type: r.type, water: r.water }) + '\n'); ok++; }
  else { log.write(JSON.stringify({ sci: r.sci, name_zh: null, body_zh: null }) + '\n'); miss++; }
}
log.end();
await new Promise((r) => setTimeout(r, 200));
return { chunk: pending.length, ok, miss, abort };
