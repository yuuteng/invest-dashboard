// /api/quotes — Boursorama 主源 + Yahoo 补位 的行情代理
// 返回: { data: { [code]: {price, pct, src, t, stale} }, t: serverEpoch }
const bands = require("../bands.json");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// 冷启动之外的进程内缓存:上次成功值(stale 兜底)+ 短 TTL 防抖
const lastGood = {}; // code -> {price, pct, src, t}
let cacheAt = 0;
let cachePayload = null;

function parseFrNumber(s) {
  if (!s) return null;
  const cleaned = s.replace(/[\s  ]/g, "").replace(",", ".").replace("%", "").replace("+", "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": UA, "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8" },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fromBourso(inst) {
  const url = inst.page
    ? `https://www.boursorama.com${inst.page}`
    : `https://www.boursorama.com/cours/${inst.code}/`;
  let html = await fetchWithTimeout(url, 6000);
  if (inst.page) {
    // 专属页(如 crypto)首个 data-ist-last 是页头行情条的别家标的,
    // 必须定位到 data-ist="{code}" 块内再取值
    const i = html.indexOf(`data-ist="${inst.code}"`);
    if (i < 0) throw new Error("bourso ist block not found");
    html = html.slice(i, i + 12000);
  }
  // 页面首个 c-instrument--last / --variation 即主标的(已逐码验证)
  const mLast = html.match(/c-instrument--last"\s*data-ist-last>([^<]+)</) || html.match(/data-ist-last[^>]*>([^<]+)</);
  const mVar = html.match(/c-instrument--variation"\s*data-ist-variation>([^<]+)</) || html.match(/data-ist-variation[^>]*>([^<]+)</);
  const price = parseFrNumber(mLast && mLast[1]);
  const rawVar = mVar && mVar[1];
  const pct = rawVar ? parseFloat(rawVar.replace(/[\s %]/g, "").replace(",", ".")) : null;
  if (price == null) throw new Error("bourso parse failed");
  return { price, pct, src: "bourso" };
}

async function fromYahoo(ysym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ysym
  )}?interval=1d&range=1d`;
  const body = await fetchWithTimeout(url, 6000);
  const j = JSON.parse(body);
  const meta = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
  if (!meta || meta.regularMarketPrice == null) throw new Error("yahoo parse failed");
  const price = meta.regularMarketPrice;
  const prev = meta.chartPreviousClose != null ? meta.chartPreviousClose : meta.previousClose;
  const pct = prev ? ((price - prev) / prev) * 100 : null;
  return { price, pct, src: "yahoo" };
}

async function quoteOne(inst) {
  const now = Math.floor(Date.now() / 1000);
  try {
    const q = await fromBourso(inst);
    const out = { ...q, t: now, stale: false };
    lastGood[inst.code] = out;
    return out;
  } catch (e1) {
    try {
      const q = await fromYahoo(inst.yahoo);
      const out = { ...q, t: now, stale: false };
      lastGood[inst.code] = out;
      return out;
    } catch (e2) {
      const prev = lastGood[inst.code];
      if (prev) return { ...prev, stale: true };
      return { price: null, pct: null, src: null, t: now, stale: true };
    }
  }
}

module.exports = async (req, res) => {
  const now = Date.now();
  if (cachePayload && now - cacheAt < 10_000) {
    res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=45");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).send(cachePayload);
  }
  const instruments = bands.instruments;
  const results = await Promise.all(instruments.map(quoteOne));
  const data = {};
  instruments.forEach((inst, i) => (data[inst.code] = results[i]));
  const payload = JSON.stringify({ data, t: Math.floor(now / 1000) });
  cachePayload = payload;
  cacheAt = now;
  res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=45");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(200).send(payload);
};
