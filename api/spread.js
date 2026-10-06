// /api/spread — 主权利差(10 年期国债收益率差,单位 bps)
// 返回: { data: { [pair]: {...} }, t }
//   bps        = 当前利差(盘中实时)
//   liveSrc    = "bourso" | "ideal"(Bourso 某条腿滞留时改用 ideal 当日值)
//   closes     = 最近 10 个已收盘交易日 [{d: 天数纪元, bps}],旧 → 新,供"连续 N 日收盘 ≥X"判断
//   closeSrc   = "ideal" | "bourso"(ideal 抓不到时退回 Bourso,前端标"备源")
//   conflict   = {d, ideal, bourso} 两源同一日收盘相差 > CONFLICT_BPS 时给出
//   staleLegs  = [code] Bourso 实时值盘中长时间等于昨收的腿
//
// 主备关系(2026-10-06 定):
//   收盘值 → 主 ideal-investisseur(静态 HTML 日表,按日期给齐法/德两腿),备 Bourso
//   实时值 → 主 Bourso,某腿滞留时用 ideal 当日行
//   BTP-Bund 只展示不触发操作,只走 Bourso
//
// Bourso 已知坑(2026-09/10 实测):法债日线会漏点(9/28、10/2),漏点后末两根日期标签错一天;
//   法债实时值偶尔整天卡在昨收(10/06)。备源路径的处理:每条腿丢末两根、
//   昨收用页面「clôture veille」、更早收盘按日期配对,缺则跳过。
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const PAIRS = {
  "OAT-Bund": {
    legs: ["2xFRABM10A", "2xDEUBM10A"], // Bourso /bourse/taux/cours/{code}/
    ideal: "https://www.ideal-investisseur.fr/en/markets/oat-bund-spread.html",
  },
  "BTP-Bund": { legs: ["2xITABM10A", "2xDEUBM10A"] },
};
const CLOSES_KEEP = 10;
const CONFLICT_BPS = 10;
const TTL = 300; // 利差是日内慢变量,5 分钟一刷足够

let cacheAt = 0;
let cacheBody = null;

async function getText(url, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA, "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8", ...headers } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

const num = s => parseFloat(String(s).replace(/[\s  %]/g, "").replace(",", "."));
const bp = (x, y) => Math.round((x - y) * 1000) / 10;
const dayOf = ms => Math.floor(ms / 86400000);

function paris(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris", weekday: "short", hour: "2-digit", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const g = t => parts.find(p => p.type === t).value;
  return { wd: g("weekday"), hr: +g("hour"), today: dayOf(Date.UTC(+g("year"), +g("month") - 1, +g("day"))) };
}
// 巴黎时间工作日 08:00–18:00 视为盘中:当天数据不算收盘
function inSession(p = paris()) {
  return !["Sat", "Sun"].includes(p.wd) && p.hr >= 8 && p.hr < 18;
}

// ── 主源:ideal-investisseur 日表 ────────────────────────────────────
// 表格行形如 "Oct 6, 2026  4.72 %  3.45 %  127.4 bps"(静态 HTML,无需渲染 JS)
async function idealRows(url) {
  const html = await getText(url);
  const text = html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const re = /([A-Z][a-z]{2}) (\d{1,2}), (\d{4}) ([\d.]+) % ([\d.]+) % ([\d.]+) bps/g;
  const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const byDay = new Map();
  for (const m of text.matchAll(re)) {
    if (!(m[1] in MON)) continue;
    byDay.set(dayOf(Date.UTC(+m[3], MON[m[1]], +m[2])), { a: +m[4], b: +m[5], bps: +m[6] });
  }
  const rows = [...byDay.entries()].sort((x, y) => x[0] - y[0]).map(([d, r]) => ({ d, ...r }));
  if (rows.length < 3) throw new Error("ideal table parse failed");
  return rows;
}

// ── 备源 / 实时:Boursorama ──────────────────────────────────────────
// 实时 + 昨收必须在 data-ist="{code}" 块内取(页头行情条会先出现别的标的)
async function liveYield(code) {
  const html = await getText(`https://www.boursorama.com/bourse/taux/cours/${code}/`);
  const i = html.indexOf(`data-ist="${code}"`);
  if (i < 0) throw new Error("ist block not found " + code);
  const m = html.slice(i, i + 12000).match(/data-ist-last[^>]*>([^<]+)</);
  const pv = html.replace(/<[^>]+>/g, " ").match(/cl[ôo]ture veille\s+([\d,.]+)/i);
  const last = m && num(m[1]);
  const prev = pv && num(pv[1]);
  if (!Number.isFinite(last) || !Number.isFinite(prev)) throw new Error("yield parse failed " + code);
  return { code, last, prev };
}

async function dailyYields(code) {
  const body = await getText(
    `https://www.boursorama.com/bourse/action/graph/ws/GetTicksEOD?symbol=${code}&length=30&period=0&guid=`,
    { "X-Requested-With": "XMLHttpRequest" }
  );
  const qt = JSON.parse(body)?.d?.QuoteTab;
  if (!Array.isArray(qt) || qt.length < 5) throw new Error("no history " + code);
  return qt.filter(p => p && Number.isFinite(p.c)).map(p => ({ d: p.d, c: p.c }));
}

async function boursoSide([a, b], p) {
  const [la, lb, ha, hb] = await Promise.all([liveYield(a), liveYield(b), dailyYields(a), dailyYields(b)]);
  const mapA = new Map(ha.slice(0, -2).map(x => [x.d, x.c]));
  const closes = hb.slice(0, -2).filter(x => mapA.has(x.d)).map(x => ({ d: x.d, bps: bp(mapA.get(x.d), x.c) }));
  const prevDay = hb[hb.length - 2].d;
  closes.push({ d: prevDay, bps: bp(la.prev, lb.prev) });
  if (!inSession(p)) closes.push({ d: hb[hb.length - 1].d, bps: bp(la.last, lb.last) });
  // 滞留:工作日开盘 3 小时后(含收盘后)实时值仍与昨收完全相同——收益率报价精确到千分位,
  // 正常交易日几乎不可能一整天纹丝不动。周末比的是周五 vs 周四,不判
  const weekday = !["Sat", "Sun"].includes(p.wd);
  const staleLegs = weekday && p.hr >= 11 ? [la, lb].filter(l => l.last === l.prev).map(l => l.code) : [];
  return { live: bp(la.last, lb.last), legs: { a: la.last, b: lb.last }, prev: { d: prevDay, bps: bp(la.prev, lb.prev) }, closes, staleLegs };
}

async function onePair(cfg) {
  const p = paris();
  const [bo, id] = await Promise.allSettled([boursoSide(cfg.legs, p), cfg.ideal ? idealRows(cfg.ideal) : Promise.reject(new Error("no ideal"))]);
  const B = bo.status === "fulfilled" ? bo.value : null;
  const I = id.status === "fulfilled" ? id.value : null;
  if (!B && !I) throw new Error("both sources failed");

  // 收盘:主 ideal(盘中剔除当天那行),备 Bourso
  let closes, closeSrc;
  if (I) {
    closes = I.filter(r => !(inSession(p) && r.d === p.today)).map(r => ({ d: r.d, bps: r.bps }));
    closeSrc = "ideal";
  } else {
    closes = B.closes;
    closeSrc = "bourso";
  }

  // 实时:主 Bourso;某腿滞留或 Bourso 挂了 → ideal 最新一行
  const idealLast = I && I[I.length - 1];
  let bps, legs, liveSrc;
  if (B && !B.staleLegs.length) {
    ({ live: bps, legs } = B);
    liveSrc = "bourso";
  } else if (idealLast) {
    bps = idealLast.bps;
    legs = { a: idealLast.a, b: idealLast.b };
    liveSrc = "ideal";
  } else {
    ({ live: bps, legs } = B);
    liveSrc = "bourso";
  }

  // 两源交叉:Bourso 昨收(clôture veille,最可靠的一个点)vs ideal 上一个交易日
  let conflict = null;
  if (B && I) {
    const idPrev = [...I].reverse().find(r => r.d < p.today);
    if (idPrev && Math.abs(idPrev.bps - B.prev.bps) > CONFLICT_BPS) conflict = { d: idPrev.d, ideal: idPrev.bps, bourso: B.prev.bps };
  }

  return {
    bps, legs, liveSrc,
    closes: closes.slice(-CLOSES_KEEP), closeSrc,
    conflict,
    staleLegs: B ? B.staleLegs : [],
    asOf: Math.floor(Date.now() / 1000),
  };
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", `s-maxage=${TTL}, stale-while-revalidate=${TTL * 3}`);
  if (cacheBody && Date.now() - cacheAt < TTL * 1000) return res.status(200).send(cacheBody);
  const data = {};
  await Promise.all(
    Object.entries(PAIRS).map(async ([name, cfg]) => {
      try {
        data[name] = await onePair(cfg);
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
