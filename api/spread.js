// /api/spread — 主权利差(10 年期国债收益率差,单位 bps),数据全走 Boursorama
// 返回: { data: { [pair]: { bps, legs: {a, b}, closes: [{d, bps}], asOf } }, t }
//   bps    = 当前(盘中实时)利差
//   closes = 最近 10 个已收盘交易日的利差,旧 → 新(不含盘中那根),供"连续 N 日收盘 >X"判断
// 数据坑(2026-09-30 实测):Bourso 法债日线会漏点(缺 9/28),漏点之后的末两根日期标签错一天。
//   处理:每条腿的日线都丢掉末两根(实时 + 昨收),昨收改用页面上精确的「clôture veille」;
//   更早的收盘按日期配对,某天任一条腿缺数据就跳过,宁缺不错配。
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// 腿:Bourso 10 年期基准收益率代码(/bourse/taux/cours/{code}/)
const PAIRS = {
  "OAT-Bund": ["2xFRABM10A", "2xDEUBM10A"],
  "BTP-Bund": ["2xITABM10A", "2xDEUBM10A"],
};
const CLOSES_KEEP = 10;
const TTL = 300; // 利差是日内慢变量,5 分钟一刷足够

let cacheAt = 0;
let cacheBody = null;

async function getText(url, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA, "Accept-Language": "fr-FR,fr;q=0.9", ...headers } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

const num = s => parseFloat(String(s).replace(/[\s  %]/g, "").replace(",", "."));

// 实时收益率 + 昨收:必须在 data-ist="{code}" 块内取值(页头行情条会先出现别的标的)
async function liveYield(code) {
  const html = await getText(`https://www.boursorama.com/bourse/taux/cours/${code}/`);
  const i = html.indexOf(`data-ist="${code}"`);
  if (i < 0) throw new Error("ist block not found " + code);
  const m = html.slice(i, i + 12000).match(/data-ist-last[^>]*>([^<]+)</);
  const pv = html.replace(/<[^>]+>/g, " ").match(/cl[ôo]ture veille\s+([\d,.]+)/i);
  const last = m && num(m[1]);
  const prev = pv && num(pv[1]);
  if (!Number.isFinite(last) || !Number.isFinite(prev)) throw new Error("yield parse failed " + code);
  return { last, prev };
}

// 日线收盘序列(旧 → 新),末点在交易时段内是盘中值
async function dailyYields(code) {
  const body = await getText(
    `https://www.boursorama.com/bourse/action/graph/ws/GetTicksEOD?symbol=${code}&length=30&period=0&guid=`,
    { "X-Requested-With": "XMLHttpRequest" }
  );
  const qt = JSON.parse(body)?.d?.QuoteTab;
  if (!Array.isArray(qt) || qt.length < 5) throw new Error("no history " + code);
  return qt.filter(p => p && Number.isFinite(p.c)).map(p => ({ d: p.d, c: p.c }));
}

// 巴黎时间工作日 08:00–18:00 视为"盘中":日线末点是实时值,不算收盘
function inSession(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", weekday: "short", hour: "2-digit", hour12: false }).formatToParts(now);
  const wd = parts.find(p => p.type === "weekday").value;
  const hr = +parts.find(p => p.type === "hour").value;
  return !["Sat", "Sun"].includes(wd) && hr >= 8 && hr < 18;
}

async function onePair([a, b]) {
  const [la, lb, ha, hb] = await Promise.all([liveYield(a), liveYield(b), dailyYields(a), dailyYields(b)]);
  const bp = (x, y) => Math.round((x - y) * 1000) / 10;
  // 更早的收盘:丢末两根后按日期配对
  const mapA = new Map(ha.slice(0, -2).map(p => [p.d, p.c]));
  const closes = hb.slice(0, -2).filter(p => mapA.has(p.d)).map(p => ({ d: p.d, bps: bp(mapA.get(p.d), p.c) }));
  // 昨收:页面精确值,日期取德债腿的倒数第二根(德债标签实测正确)
  closes.push({ d: hb[hb.length - 2].d, bps: bp(la.prev, lb.prev) });
  // 收盘后:今天这根也算收盘
  if (!inSession()) closes.push({ d: hb[hb.length - 1].d, bps: bp(la.last, lb.last) });
  return {
    bps: bp(la.last, lb.last),
    legs: { a: la.last, b: lb.last },
    closes: closes.slice(-CLOSES_KEEP),
    asOf: Math.floor(Date.now() / 1000),
  };
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", `s-maxage=${TTL}, stale-while-revalidate=${TTL * 3}`);
  if (cacheBody && Date.now() - cacheAt < TTL * 1000) return res.status(200).send(cacheBody);
  const data = {};
  await Promise.all(
    Object.entries(PAIRS).map(async ([name, legs]) => {
      try {
        data[name] = await onePair(legs);
      } catch (e) {
        const prev = cacheBody && JSON.parse(cacheBody).data[name];
        if (prev) data[name] = { ...prev, stale: true }; // 上次成功值兜底
      }
    })
  );
  if (!Object.keys(data).length) return res.status(502).send(JSON.stringify({ error: "all spreads failed" }));
  cacheBody = JSON.stringify({ data, t: Math.floor(Date.now() / 1000) });
  cacheAt = Date.now();
  res.status(200).send(cacheBody);
};
