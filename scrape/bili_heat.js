// Bilibili 水族内容热度收割 —— 用结构化搜索 API 抓每关键词的视频标题/播放/分区。
// 输出 data/raw/bili_heat.jsonl（逐条落盘，断点续传：已抓关键词跳过）。
// 运行：node scrape/bili_heat.js   （Node>=18 自带 fetch）
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const _kws = ["bili_kw.json", "bili_kw_nonfish.json"]
  .flatMap((f) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, "data/raw/" + f), "utf8")); } catch { return []; } });
const KW = [...new Set(_kws)];
const OUT = path.join(ROOT, "data/raw/bili_heat.jsonl");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const CONC = 2;
const DELAY = 450;
const PAGES = 2; // 每词抓前 2 页（约 40 条）

function strip(html) { return String(html || "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim(); }

async function getCookie() {
  try {
    const r = await fetch("https://www.bilibili.com/", { headers: { "User-Agent": UA }, redirect: "follow" });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    return sc.map((c) => c.split(";")[0]).join("; ");
  } catch { return ""; }
}

async function apiSearch(cookie, kw, page) {
  const url = "https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=" +
    encodeURIComponent(kw) + "&page=" + page;
  const r = await fetch(url, { headers: { "User-Agent": UA, "Referer": "https://www.bilibili.com/", "Cookie": cookie } });
  const j = await r.json().catch(() => null);
  return j;
}

function doneSet() {
  const done = new Set();
  if (!fs.existsSync(OUT)) return done;
  for (const l of fs.readFileSync(OUT, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try { done.add(JSON.parse(l).kw); } catch {}
  }
  return done;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function work(kw, cookie, stream) {
  try {
    for (let p = 1; p <= PAGES; p++) {
      const j = await apiSearch(cookie, kw, p);
      if (!j || j.code !== 0 || !j.data) {
        // 风控/限流：短暂等待后整体标记，交由下次跑重试
        stream.write(JSON.stringify({ kw, page: p, code: j ? j.code : null, fail: true }) + "\n");
        await sleep(1500);
        return;
      }
      const items = (j.data.result || []);
      for (const it of items) {
        stream.write(JSON.stringify({
          kw,
          title: strip(it.title),
          play: Number(it.play) || 0,
          tag: strip(it.tag),
          typeid: String(it.typeid || ""),
          bvid: it.bvid || "",
          author: it.author || "",
        }) + "\n");
      }
      await sleep(DELAY);
    }
    console.log("ok", kw);
  } catch (e) {
    stream.write(JSON.stringify({ kw, fail: true, err: String(e && e.message || e) }) + "\n");
  }
}

async function main() {
  const cookie = await getCookie();
  console.log("cookie buvid3?", /buvid3/.test(cookie));
  const done = doneSet();
  const pending = KW.filter((k) => !done.has(k));
  console.log("keywords", KW.length, "pending", pending.length);
  const stream = fs.createWriteStream(OUT, { flags: "a" });
  const queue = [...pending];
  let idx = 0;
  async function worker() {
    while (idx < queue.length) {
      const k = queue[idx++];
      await work(k, cookie, stream);
      await sleep(DELAY);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  stream.end();
  console.log("BILI DONE");
}

main();
