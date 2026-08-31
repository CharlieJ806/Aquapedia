// 百度百科 热门物种正文收割 —— 按中文关键词取词条正文 + 学名（浏览器同源 fetch 规避反爬）。
// 读 data/raw/hot_targets.json [ {kw,sci,type,water} ]，输出 data/raw/zh_baike_hot.jsonl。
// 断点续传：zh_baike_hot.jsonl 已记录的 kw 跳过。
// 在 baike 域浏览器 tab 内用 new Function('page','tab','require','return (async () => {'+src+'})()') 执行。
const fs = require('fs');
const DATA = 'Z:/Files/Aquapedia/data/raw';

const TARGETS = JSON.parse(fs.readFileSync(DATA + '/hot_targets.json', 'utf8'));
const outPath = DATA + '/zh_baike_hot.jsonl';
const done = new Set(
  fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l).kw) : []);
const pending = TARGETS.filter(t => !done.has(t.kw));

const AQUA = /水草|水生|水族|水族箱|鱼缸|水体|沉水|淡水|海水|观赏鱼|饲养|鱼|虾|螺|龟|蕨|原生|原产|植株|植物/;
let ok = 0, miss = 0;
const log = fs.createWriteStream(outPath, { flags: 'a' });

const on = await tab.evaluate(() => location.hostname === 'baike.baidu.com').catch(() => false);
if (!on) {
  await tab.goto('https://baike.baidu.com/item/观赏鱼', { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 1500));
}

async function fetchKw(kw) {
  const r = await tab.evaluate(async (w) => {
    const resp = await fetch('/item/' + encodeURIComponent(w), { credentials: 'include' });
    if (resp.status !== 200) return null;
    const t = await resp.text();
    if (t.length < 12000) return null;
    const tm = t.match(/<title>([^<]+?)_百度百科<\/title>/);
    const title = tm ? tm[1] : null;
    if (!title || /安全验证/.test(title)) return null;
    const doc = new DOMParser().parseFromString(t, 'text/html');
    const paras = [...doc.querySelectorAll('div[class*="para"]')]
      .map(p => p.innerText.trim())
      .filter(x => x && /[\u4e00-\u9fff]/.test(x) && x.length > 20);
    const body = paras.slice(0, 4).join('\n');
    return { title: title.replace(/（[^）]*）$/, '').trim(), body };
  }, kw);
  return r;
}

function extractSci(body, hint) {
  let m = body.match(/学名[：:]\s*([A-Z][a-z]+ [a-z][a-z\-]+)/);
  if (m) return m[1];
  m = body.match(/\b([A-Z][a-z]+) ([a-z][a-z\-]+)\b/);
  if (m) return m[1] + ' ' + m[2];
  return hint || null;
}

for (const t of pending) {
  let got = null;
  try { got = await fetchKw(t.kw); } catch (e) {}
  await new Promise(r => setTimeout(r, 350));
  if (got && got.body) {
    const sci = extractSci(got.body, t.sci);
    const cleanSci = (sci || '').split(/[×,]/)[0].trim().split(/\s+/).slice(0, 2).join(' ');
    const aqua = AQUA.test(got.body);
          log.write(JSON.stringify({ kw: t.kw, sci: t.sci, name_zh: got.title, body_zh: got.body, type: t.type, water: t.water, aliases: t.alias || [t.kw], aqua }) + '\n');
      ok++;
    } else {
      log.write(JSON.stringify({ kw: t.kw, sci: null, name_zh: null, body_zh: null, type: t.type, water: t.water, aliases: t.alias || [t.kw], aqua: false }) + '\n');
      miss++;
    }
}
log.end();
await new Promise(r => setTimeout(r, 200));
return { chunk: pending.length, ok, miss };
