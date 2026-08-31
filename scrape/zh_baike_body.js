// 百度百科 中文正文收割器 v1 — 在 browser run 作用域内 new Function 执行（page/tab/require 可用）
// 抓中文名 + 词条正文前几段（含饲养信息），作主内容；SF 英文留作参考。
// 断点：zh_baike.jsonl 已记录的 id 跳过。append 模式，抽到即落盘。
// 每轮 slice(0, 40)，检测「百度安全验证」即停，冷却后可续（已抓自动跳过）。
const fs = require('fs');

const DATA = JSON.parse(fs.readFileSync('Z:/Files/Aquapedia/app/data/species.json', 'utf8'));
const species = DATA.species;
const outPath = 'Z:/Files/Aquapedia/data/raw/zh_baike.jsonl';
const done = new Set(
  fs.existsSync(outPath)
    ? fs.readFileSync(outPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).id)
    : []
);

// 优先有中文名的物种（更可能有百度词条）；按 id 奇偶分片让双标签并行，每轮 40 条
const SHARD = (typeof __SHARD !== 'undefined') ? __SHARD : 'a';
const pending = species
  .filter((s) => s.name_zh && !done.has(s.id))
  .filter((s) => (s.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 2) === (SHARD === 'a' ? 0 : 1))
  .slice(0, 40);

let ok = 0, miss = 0, abort = null;
const log = fs.createWriteStream(outPath, { flags: 'a' });

const onBaike = await tab.evaluate(() => location.hostname === 'baike.baidu.com').catch(() => false);
if (!onBaike) {
  await tab.goto('https://baike.baidu.com/item/泰国斗鱼', { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
}

const BODY_RE = /class="(?:para|lemma-summary|lemmaWgt-lemmaSummary)[^"]*"/;

async function fetchItem(word) {
  // returns {title, body} or null; body = intro paragraphs joined
  const r = await tab.evaluate(async (w) => {
    const resp = await fetch('/item/' + encodeURIComponent(w), { credentials: 'include' });
    if (resp.status !== 200) return null;
    const t = await resp.text();
    if (t.length < 30000) return null;
    const title = (t.match(/<title>([^<]+?)_百度百科<\/title>/) || [])[1] || null;
    if (!title || /安全验证/.test(title)) return null;
    const doc = new DOMParser().parseFromString(t, 'text/html');
    const paras = [...doc.querySelectorAll('div[class*="para"]')]
      .map((p) => p.innerText.trim())
      .filter((x) => x && /[\u4e00-\u9fff]/.test(x) && x.length > 30);
    const body = paras.slice(0, 5).join('\n');
    return { title: title.replace(/（[^）]*）$/, '').trim(), body };
  }, word);
  return r;
}

for (const s of pending) {
  if (abort) break;
  let got = null;
  // ① 学名直连
  try { got = await fetchItem(s.scientific_name); } catch (e) {}
  await new Promise((rr) => setTimeout(rr, 300));
  // ② 中文名直连
  if (!got || !got.body) {
    try { got = await fetchItem(s.name_zh); } catch (e) {}
    await new Promise((rr) => setTimeout(rr, 300));
  }
  // ③ 搜索页兜底（中文名）
  if (!got || !got.body || !got.title) {
    try {
      await tab.goto('https://baike.baidu.com/search?word=' + encodeURIComponent(s.name_zh) + '&rn=8&enc=utf8', { waitUntil: 'domcontentloaded', timeout: 40000 });
      const res = await tab.evaluate(async (sciN) => {
        await new Promise((r) => setTimeout(r, 1800));
        if (/百度安全验证/.test(document.body.innerHTML.slice(0, 3000))) return { blocked: true };
        const links = [...new Set([...document.querySelectorAll('a[href*="/item/"]')]
          .map((a) => { try { return new URL(a.getAttribute('href'), location.origin).pathname; } catch (e) { return null; } })
          .filter((h) => h && h.startsWith('/item/') && h !== '/item/'))].slice(0, 3);
        for (const h of links) {
          const resp = await fetch(h, { credentials: 'include' });
          if (resp.status !== 200) continue;
          const t = await resp.text();
          if (t.length < 30000) continue;
          if (!t.toLowerCase().includes(sciN.toLowerCase())) continue;
          const title = (t.match(/<title>([^<]+?)_百度百科<\/title>/) || [])[1] || null;
          if (!title) continue;
          const doc = new DOMParser().parseFromString(t, 'text/html');
          const paras = [...doc.querySelectorAll('div[class*="para"]')]
            .map((p) => p.innerText.trim())
            .filter((x) => x && /[\u4e00-\u9fff]/.test(x) && x.length > 30);
          const body = paras.slice(0, 5).join('\n');
          if (body) return { title: title.replace(/（[^）]*）$/, '').trim(), body };
        }
        return null;
      }, s.scientific_name || s.name_zh);
      if (res && res.blocked) { abort = 'blocked by baike anti-bot'; break; }
      if (res && res.title) got = res;
    } catch (e) {}
    await new Promise((rr) => setTimeout(rr, 400));
  }

  if (got && got.title && got.body) {
    log.write(JSON.stringify({ id: s.id, sci: s.scientific_name, name_zh: got.title, body_zh: got.body }) + '\n');
    ok++;
  } else {
    log.write(JSON.stringify({ id: s.id, sci: s.scientific_name, name_zh: null, body_zh: null }) + '\n');
    miss++;
  }
}
log.end();
await new Promise((r) => setTimeout(r, 200));
return { chunk: pending.length, ok, miss, abort };
