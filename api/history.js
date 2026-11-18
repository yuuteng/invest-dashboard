// /api/history?code=1rPBVI&period=1M — 历史序列代理:Boursorama 主源(重试 1 次)→ Yahoo 补位
// period → GetTicksEOD length(仅标准档有效,非标值会退化为分钟流):
//   1J:1(当日分钟线) 5J:5(五日分钟线) 1M:30 3M:90 6M:180 1A:365 5A:1825 10A:3650(日线)
// QuoteTab.d 两种格式:> 1e9 为 yyMMdd+当日分钟数(后4位是 minutes-since-midnight,非 HHmm:0540=9h00 开盘,1055=17h35 收盘竞价);否则为天数纪元
// 返回: { points: [{t: epochMs, c: close}], period, code, src }
const bands = require("../bands.json");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const LEN = { "1J": 1, "5J": 5, "1M": 30, "3M": 90, "6M": 180, "1A": 365, "5A": 1825, "10A": 3650 };
const cache = {}; // key -> {at, body}

function toEpoch(d) {
  if (d > 1e9) {
    // yyMMdd + 当日分钟数(交易所本地时,仅作展示轴)。按 HHmm 解析是错的:
    // 分钟数 599→600 会时间倒跳、且相邻小时段 40% 时间戳互撞,去重后丢点画出长直线
    const s = String(d).padStart(10, "0");
    return Date.UTC(2000 + +s.slice(0, 2), +s.slice(2, 4) - 1, +s.slice(4, 6)) + +s.slice(6) * 60000;
  }
  return d * 86400000; // 天数纪元
}

// Yahoo range/interval,时间戳折算成与 Bourso 同口径(交易所本地时当 UTC;日线取当日 0 点)
const YH = {
  "1J": ["1d", "1m"], "5J": ["5d", "5m"], "1M": ["1mo", "1d"], "3M": ["3mo", "1d"],
  "6M": ["6mo", "1d"], "1A": ["1y", "1d"], "5A": ["5y", "1d"], "10A": ["10y", "1d"],
};

async function fetchJson(url, headers, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA, ...headers } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function dedupe(pairs) {
  const byT = new Map();
  for (const [t, c] of pairs) if (Number.isFinite(t) && Number.isFinite(c)) byT.set(t, c);
  const points = [...byT.entries()].sort((a, b) => a[0] - b[0]).map(([t, c]) => ({ t, c }));
  if (points.length < 2) throw new Error("no data");
  return points;
}

async function fromBourso(code, len) {
  const j = await fetchJson(
    `https://www.boursorama.com/bourse/action/graph/ws/GetTicksEOD?symbol=${encodeURIComponent(code)}&length=${len}&period=0&guid=`,
    { "X-Requested-With": "XMLHttpRequest", "Accept-Language": "fr-FR,fr;q=0.9" },
    4000
  );
  const qt = j && j.d && j.d.QuoteTab;
  if (!Array.isArray(qt) || qt.length < 2) throw new Error("no data");
  return dedupe(qt.filter(p => p != null && p.c != null).map(p => [toEpoch(p.d), p.c]));
}

async function fromYahoo(ysym, period) {
  const [range, interval] = YH[period];
  const j = await fetchJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ysym)}?interval=${interval}&range=${range}`,
    {},
    5000
  );
  const r0 = j && j.chart && j.chart.result && j.chart.result[0];
  const ts = r0 && r0.timestamp;
  const cl = r0 && r0.indicators && r0.indicators.quote && r0.indicators.quote[0] && r0.indicators.quote[0].close;
  if (!Array.isArray(ts) || !Array.isArray(cl)) throw new Error("yahoo no data");
  const off = (r0.meta && r0.meta.gmtoffset) || 0;
  const daily = interval === "1d";
  return dedupe(ts.map((t, i) => {
    const local = (t + off) * 1000;
    return [daily ? Math.floor(local / 86400000) * 86400000 : local, cl[i] == null ? NaN : Math.round(cl[i] * 1e4) / 1e4];
  }));
}

async function load(code, period, len) {
  const t0 = Date.now();
  try {
    return { points: await fromBourso(code, len), src: "bourso" };
  } catch (e1) {
    if (e1.message !== "no data" && Date.now() - t0 < 2000) {
      try { return { points: await fromBourso(code, len), src: "bourso" }; } catch (e2) {}
    }
    const inst = bands.instruments.find(i => i.code === code);
    if (!inst || !inst.yahoo) throw e1;
    return { points: await fromYahoo(inst.yahoo, period), src: "yahoo" };
  }
}

module.exports = async (req, res) => {
  const url = new URL(req.url, "http://x");
  const code = url.searchParams.get("code") || "";
  const period = url.searchParams.get("period") || "1M";
  const len = LEN[period];
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (!/^[0-9a-zA-Z]{2,12}$/.test(code) || !len) {
    return res.status(400).send(JSON.stringify({ error: "bad params" }));
  }
  const intraday = len <= 5;
  const maxage = intraday ? 60 : 600;
  const key = code + "|" + period;
  const hit = cache[key];
  const cc = `s-maxage=${maxage}, stale-while-revalidate=${maxage * 3}`;
  if (hit && Date.now() - hit.at < maxage * 1000) {
    res.setHeader("Cache-Control", cc);
    return res.status(200).send(hit.body);
  }
  try {
    const { points, src } = await load(code, period, len);
    const body = JSON.stringify({ code, period, src, points });
    cache[key] = { at: Date.now(), body };
    res.setHeader("Cache-Control", cc);
    res.status(200).send(body);
  } catch (e) {
    if (hit) {
      res.setHeader("Cache-Control", cc);
      return res.status(200).send(hit.body);
    }
    res.setHeader("Cache-Control", "no-store");
    res.status(502).send(JSON.stringify({ error: String(e.message || e) }));
  }
};
