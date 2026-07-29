// /api/history?code=1rPBVI&period=1M — Boursorama 历史序列代理
// period → GetTicksEOD length(仅标准档有效,非标值会退化为分钟流):
//   1J:1(当日分钟线) 5J:5(五日分钟线) 1M:30 3M:90 6M:180 1A:365 5A:1825 10A:3650(日线)
// QuoteTab.d 两种格式:> 1e9 为 yyMMddHHmm 分钟时间戳;否则为天数纪元
// 返回: { points: [{t: epochMs, c: close}], period, code }
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const LEN = { "1J": 1, "5J": 5, "1M": 30, "3M": 90, "6M": 180, "1A": 365, "5A": 1825, "10A": 3650 };
const cache = {}; // key -> {at, body}

function toEpoch(d) {
  if (d > 1e9) {
    // yyMMddHHmm(交易所本地时,仅作展示轴)
    const s = String(d).padStart(10, "0");
    return Date.UTC(2000 + +s.slice(0, 2), +s.slice(2, 4) - 1, +s.slice(4, 6), +s.slice(6, 8), +s.slice(8, 10));
  }
  return d * 86400000; // 天数纪元
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
  res.setHeader("Cache-Control", `s-maxage=${maxage}, stale-while-revalidate=${maxage * 3}`);
  const key = code + "|" + period;
  const hit = cache[key];
  if (hit && Date.now() - hit.at < maxage * 1000) return res.status(200).send(hit.body);
  try {
    const r = await fetch(
      `https://www.boursorama.com/bourse/action/graph/ws/GetTicksEOD?symbol=${encodeURIComponent(code)}&length=${len}&period=0&guid=`,
      { headers: { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest", "Accept-Language": "fr-FR,fr;q=0.9" } }
    );
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const qt = j && j.d && j.d.QuoteTab;
    if (!Array.isArray(qt) || qt.length < 2) throw new Error("no data");
    // 排序 + 去重:Bourso 分钟流偶有乱序/重复时间戳,会让折线回跳画出横穿乱线
    const byT = new Map();
    for (const p of qt) {
      if (p == null || p.c == null || !Number.isFinite(p.c)) continue;
      byT.set(toEpoch(p.d), p.c); // 同一时间戳保留最后一条
    }
    const points = [...byT.entries()].sort((a, b) => a[0] - b[0]).map(([t, c]) => ({ t, c }));
    if (points.length < 2) throw new Error("no data");
    const body = JSON.stringify({ code, period, points });
    cache[key] = { at: Date.now(), body };
    res.status(200).send(body);
  } catch (e) {
    if (hit) return res.status(200).send(hit.body); // 过期缓存兜底
    res.status(502).send(JSON.stringify({ error: String(e.message || e) }));
  }
};
