// /api/indicators — 日线技术指标:52周最高收盘 / MA200 / RSI(14)
// 数据:GetTicksEOD length=365(≈250 交易日,MA200 刚好够)→ 失败退 Yahoo range=1y
// 回撤/乖离不在这里算:高点与均线缓存 1 小时,现价由前端用 /api/quotes 实时值代入
// 返回: { data: { [code]: {high52w, ma200, rsi14, lastClose, asOf} | null }, t }
const bands = require("../bands.json");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const TTL = 3600_000; // 日线级数据,1 小时足够
const lastGood = {}; // code -> indicators(stale 兜底)
let cacheAt = 0;
let cachePayload = null;

async function fetchJson(url, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA, ...headers } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// closes 按时间升序;不足 15 点连 RSI 都算不了,返回 null
function compute(closes) {
  const n = closes.length;
  if (n < 15) return null;
  const high52w = Math.max(...closes); // 以收盘价计(双源口径一致,且不受盘中毛刺影响)
  const ma200 = n >= 200 ? closes.slice(-200).reduce((a, b) => a + b, 0) / 200 : null;
  // RSI(14) Wilder 平滑
  let gain = 0, loss = 0;
  for (let i = 1; i <= 14; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= 14; loss /= 14;
  for (let i = 15; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * 13 + Math.max(d, 0)) / 14;
    loss = (loss * 13 + Math.max(-d, 0)) / 14;
  }
  const rsi14 = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  return {
    high52w: Math.round(high52w * 1e4) / 1e4,
    ma200: ma200 == null ? null : Math.round(ma200 * 1e4) / 1e4,
    rsi14: Math.round(rsi14 * 10) / 10,
    lastClose: closes[n - 1],
  };
}

async function fromBourso(code) {
  const j = await fetchJson(
    `https://www.boursorama.com/bourse/action/graph/ws/GetTicksEOD?symbol=${encodeURIComponent(code)}&length=365&period=0&guid=`,
    { "X-Requested-With": "XMLHttpRequest", "Accept-Language": "fr-FR,fr;q=0.9" }
  );
  const qt = j && j.d && j.d.QuoteTab;
  if (!Array.isArray(qt) || qt.length < 15) throw new Error("no data");
  const rows = qt.filter(p => p && Number.isFinite(p.c)).sort((a, b) => a.d - b.d);
  const closes = rows.map(p => p.c);
  const asOf = new Date(rows[rows.length - 1].d * 86400000).toISOString().slice(0, 10);
  return { closes, asOf };
}

async function fromYahoo(ysym) {
  const j = await fetchJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ysym)}?interval=1d&range=1y`
  );
  const r0 = j && j.chart && j.chart.result && j.chart.result[0];
  const raw = r0 && r0.indicators && r0.indicators.quote && r0.indicators.quote[0] && r0.indicators.quote[0].close;
  const ts = r0 && r0.timestamp;
  if (!Array.isArray(raw) || raw.length < 15) throw new Error("yahoo no data");
  const closes = [];
  let lastT = null;
  raw.forEach((c, i) => { if (Number.isFinite(c)) { closes.push(c); lastT = ts && ts[i]; } });
  const asOf = lastT ? new Date(lastT * 1000).toISOString().slice(0, 10) : null;
  return { closes, asOf };
}

async function indicatorsOne(inst) {
  try {
    const { closes, asOf } = await fromBourso(inst.code);
    const ind = compute(closes);
    if (!ind) throw new Error("too few points");
    const out = { ...ind, asOf };
    lastGood[inst.code] = out;
    return out;
  } catch (e1) {
    try {
      const { closes, asOf } = await fromYahoo(inst.yahoo);
      const ind = compute(closes);
      if (!ind) throw new Error("too few points");
      const out = { ...ind, asOf };
      lastGood[inst.code] = out;
      return out;
    } catch (e2) {
      return lastGood[inst.code] || null;
    }
  }
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=7200");
  const now = Date.now();
  if (cachePayload && now - cacheAt < TTL) return res.status(200).send(cachePayload);
  const instruments = bands.instruments;
  const results = await Promise.all(instruments.map(indicatorsOne));
  const data = {};
  instruments.forEach((inst, i) => (data[inst.code] = results[i]));
  const payload = JSON.stringify({ data, t: Math.floor(now / 1000) });
  cachePayload = payload;
  cacheAt = now;
  res.status(200).send(payload);
};
