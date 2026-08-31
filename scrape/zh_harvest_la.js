// 百度百科 中文名收割器 v4 — 在 browser run 作用域内 new Function 执行（page/tab/require 可用）
// 三层：① 同源 fetch /item/{sci} ② 搜索页富卡片摘要 ③ 搜索页词条链接二次抓取（薄卡片兜底）
// 断点：zh.jsonl(基础) + zh_<SHARD>.jsonl(本片) 已记录的 sci 跳过
const fs = require('fs');

const laRaw = JSON.parse(fs.readFileSync('Z:/Files/Aquapedia/data/raw/la.json', 'utf8'));
const seen = new Set();
const SF = [];
for (const p of laRaw) {
  const s = (p.scientific_name || '').trim();
  const k = s.toLowerCase();
  if (!s || seen.has(k)) continue;
  seen.add(k); SF.push({ sci: s, ens: [] });
}
SF.sort((a, b) => a.sci.localeCompare(b.sci));

const SHARD = 'a';
const basePath = 'Z:/Files/Aquapedia/data/raw/zh.jsonl';
const zhPath = 'Z:/Files/Aquapedia/data/raw/zh_la_' + SHARD + '.jsonl';
const done = new Set(
  [basePath, zhPath].filter(p => fs.existsSync(p))
    .flatMap(p => fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean))
    .map(l => JSON.parse(l).sci.toLowerCase())
);

const pending = SF.filter(x => !done.has(x.sci.toLowerCase()))
  .filter(x => x.sci.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 2 === (SHARD === 'a' ? 0 : 1))
  .slice(0, 40);

let ok = 0, miss = 0, errs = 0, abort = null;
const log = fs.createWriteStream(zhPath, { flags: 'a' });

const onBaike = await tab.evaluate(() => location.hostname === 'baike.baidu.com').catch(() => false);
if (!onBaike) {
  await tab.goto('https://baike.baidu.com/item/fish', { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 1500));
}

for (const item of pending) {
  if (abort) break;
  const sci = item.sci;
  const sciN = sci.toLowerCase().replace(/\s+/g, ' ').trim();
  let found = null, via = null;

  // ① 同源 fetch 快路
  try {
    const r = await tab.evaluate(async (w) => {
      const resp = await fetch('/item/' + encodeURIComponent(w), { credentials: 'include' });
      if (resp.status !== 200) return { miss: true };
      const t = await resp.text();
      if (t.length < 50000) return { miss: true };
      const re = new RegExp(w.toLowerCase().replace(/\s+/g, '\\s+'), 'i');
      if (!re.test(t)) return { miss: true };
      const m = t.match(/<title>([^<]+?)_百度百科<\/title>/);
      return m ? { title: m[1].replace(/（[^）]*）$/, '').trim() } : { miss: true };
    }, sci);
    if (r && r.title && /^[\u4e00-\u9fff\u3400-\u4dbf]{2,12}$/.test(r.title)) {
      found = { zhs: [r.title], snippet: r.title }; via = 'item-fetch';
    }
  } catch (e) {}
  await new Promise(rr => setTimeout(rr, 250));

  // ② 搜索页富卡片 + ③ 薄卡片链接二次抓取（同一渲染页完成）
  if (!found) {
    for (const word of [sci].concat((item.ens || []).slice(0, 1).filter(Boolean))) {
      if (abort) break;
      try {
        const res = await tab.goto('https://baike.baidu.com/search?word=' + encodeURIComponent(word) + '&rn=8&enc=utf8', { waitUntil: 'domcontentloaded', timeout: 40000 })
          .then(() => tab.evaluate(async (sciN) => {
            await new Promise(r => setTimeout(r, 2200));
            const blocked = /百度安全验证|wappass/.test(document.body.innerHTML.slice(0, 3000));
            if (blocked) return { blocked: true };
            const docTitle = (document.title || '').replace(/_百度百科.*$/, '').trim();
            let text = document.body.innerText.replace(/\s+/g, ' ');
            const full = (docTitle + ' ' + text).slice(0, 6000);
            let rich = null;
            if (full.toLowerCase().includes(sciN)) {
              const zhs = [];
              for (const re of [
                /俗称([\u4e00-\u9fff\u3400-\u4dbf]{2,12})/, /又名([\u4e00-\u9fff\u3400-\u4dbf]{2,12})/,
                /(?:别名|又称|称为)([\u4e00-\u9fff\u3400-\u4dbf]{2,12})/, /中文名[：:：]?([\u4e00-\u9fff\u3400-\u4dbf]{2,12})/
              ]) { const m = full.match(re); if (m) zhs.push(m[1]); }
              const bad = /形态|特征|分布|繁殖|习性|饲养|价值|文化|保护|品种|亚种|外形|方法|科学|分类/;
              if (zhs.length) rich = { zhs: [...new Set(zhs)].filter(z => !/(目|科|属|总称)$/.test(z) && !bad.test(z)), snippet: full.slice(0, 140) };
            }
            if (rich) return { found: rich };
            // 薄卡片：抓词条链接二次验证
            const links = [...new Set([...document.querySelectorAll('a[href*="/item/"]')]
              .map(a => { try { return new URL(a.getAttribute('href'), location.origin).pathname; } catch (e) { return null; } })
              .filter(h => h && h.startsWith('/item/') && h !== '/item/'))].slice(0, 4);
            for (const h of links) {
              try {
                const resp = await fetch(h, { credentials: 'include' });
                if (resp.status !== 200) continue;
                const t = await resp.text();
                if (t.length < 50000) continue;
                const re = new RegExp(sciN.replace(/ /g, '\\s+'), 'i');
                if (!re.test(t)) continue;
                const m = t.match(/<title>([^<]+?)_百度百科<\/title>/);
                if (!m) continue;
                const title = m[1].replace(/（[^）]*）$/, '').trim();
                const zhs = [];
                for (const re2 of [/俗称([\u4e00-\u9fff\u3400-\u4dbf]{2,12})/, /又名([\u4e00-\u9fff\u3400-\u4dbf]{2,12})/, /(?:别名|又称|称为)([\u4e00-\u9fff\u3400-\u4dbf]{2,12})/]) {
                  const mm = t.match(re2); if (mm) zhs.push(mm[1]);
                }
                if (/^[\u4e00-\u9fff\u3400-\u4dbf]{2,12}$/.test(title)) zhs.unshift(title);
                const bad = /形态|特征|分布|繁殖|习性|饲养|价值|文化|保护|品种|亚种|外形|方法|科学|分类/;
                const uniq = [...new Set(zhs)].filter(z => !/(目|科|属|总称)$/.test(z) && !bad.test(z));
                if (uniq.length) return { found: { zhs: uniq, snippet: title } };
              } catch (e) {}
              await new Promise(r => setTimeout(r, 250));
            }
            return { found: null };
          }, sciN));
        if (res && res.blocked) { abort = 'blocked by baike anti-bot'; break; }
        if (res && res.found) { found = res.found; via = 'search'; break; }
      } catch (e) { errs++; }
      await new Promise(rr => setTimeout(rr, 300));
    }
  }

  if (found && found.zhs && found.zhs.length) {
    log.write(JSON.stringify({ sci, zh: found.zhs[0], aliases: found.zhs.slice(1, 4), via, snippet: found.snippet }) + '\n');
    ok++;
  } else {
    log.write(JSON.stringify({ sci, zh: null }) + '\n');
    miss++;
    if (errs >= 12) { abort = 'too many errors'; }
  }
}
log.end();
await new Promise(r => setTimeout(r, 200));
return { shard: SHARD, chunk: pending.length, ok, miss, errs, abort };
