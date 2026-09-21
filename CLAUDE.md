# CLAUDE.md — invest-dashboard 协作说明

个人投研看盘页。生产地址:**https://invest-dashboard-snowy.vercel.app/** 。托管 Vercel(Hobby),连接本仓库 `main` 分支,**git push 即自动部署,URL 不变**。

## 这个项目是什么

把 Obsidian 库里投研报告的结论(买入/离场价位带)和实时行情放在一页:价格自动落带着色——🟢 偏低可入场 / 🔵 合理 / 🟡 偏高 / 🔴 信号离场;每行可展开 Boursorama 同款走势图(1J/5J/1M/3M/6M/1A/5A/10A)。

姊妹项目:[etf-ai-analyst](https://github.com/yuuteng/etf-ai-analyst)(ETF 尽调框架);个股研究由 ai-berkshire skills 产出(报告在 Obsidian 库 `Investment/Reports/`)。

## 文件地图

| 文件 | 作用 |
|------|------|
| `index.html` | 全部 UI(单文件):15s 轮询报价、价位带标尺、可展开 SVG 走势图 |
| 持仓(无文件) | 数量 + 成本均价存**浏览器 localStorage** `positions.v1`,页面「持仓总览」面板算浮动/今日盈亏。**不进仓库**(红线);备份走面板「导出 JSON」 |
| `bands.json` | **数据核心**:标的池 + 价位带 + 观察哨 + 报告名。json 即数据库,git 即版本史 |
| `api/quotes.js` | 报价代理:Bourso 主源(解析 `data-ist-last`/`data-ist-variation` 首个匹配)→ 失败 Yahoo v8 chart 补位 → 再失败返回上次值标 stale;s-maxage=15 |
| `api/history.js` | 历史序列代理:全部走 `GetTicksEOD`(length≤5 返回分钟线,其余日线);**必须带 `X-Requested-With: XMLHttpRequest` 头,否则返回空数组** |
| `api/indicators.js` | 日线技术指标:52周最高收盘 / MA200 / RSI(14) Wilder,`GetTicksEOD length=365` → 失败 Yahoo `range=1y` 补位;s-maxage=3600。回撤52W/乖离MA200 由前端用实时价折算;图上 MA200 点线由前端取 `period=10A` 滚动计算(仅 1M 及以上窗口,偏离窗口价域 ±15% 的段不画不定标,避免压扁价格线) |
| `favicon.svg` / `favicon-32.png` / `apple-touch-icon.png` | 站点图标(蓝底白折线) |
| `scripts/dev_server.js` | 本地测试:`node scripts/dev_server.js` → localhost:8899,模拟 Vercel 路由 |

## 维护规约(重要)

1. **报告更新 → 同步价位带**:每当库里出新研究报告/增量复检,更新 `bands.json` 对应标的的 `green/strong/yellow/axis/watch/report`,改 `updated` 日期,commit + push。字段可为 `null`(页面显示"带未定,仅价格")。
2. **财报日提醒**:个股有 `earnings` 字段(下次财报日 `YYYY-MM-DD`)。页面角标:>14 天灰、≤14 天黄、当日/已过红("财报已出·待复检")。**每次 `/earnings-review` 复检后必须把 `earnings` 更新为下一季日期**,否则角标一直红。ETF/指数不填。
3. **新增标的**:在 `bands.json.instruments` 加一条(必填 `code`=Bourso 代码、`yahoo`=备源代码、`name/short/group/currency`)。Bourso 代码在 boursorama.com 搜索标的后取 URL 中的代码(巴黎股 `1rPXXX`、意大利 `1gXXX`、trackers `1rTXXX`)。
4. **信号离场**:某标的触发减仓信号时,把 `alert` 字段写成一句话(如 `"指引下修"`),页面变 🔴;解除填回 `null`。
5. **视觉系统已定稿**(工程数据表风格,与 Obsidian 库投资卡片同族,双主题 token),不重做设计;改样式先看 `:root` token。
6. Bourso 改版导致解析断裂:先查 `api/quotes.js` 的正则锚点(`c-instrument--last" data-ist-last>`),再查 `api/history.js` 两个接口返回结构。

## 技术备忘

- 数据时效:Bourso 巴黎股实时,米兰等按其页面时效;Yahoo 补位为 15 分钟延迟(页面有角标)
- ETF/指数的 `/cours/{code}/` 是 301 跳转,Node fetch 自动跟随(curl 测试要加 `-L`)
- 分钟线时间格式 `yyMMdd` + **当日分钟数**(后 4 位是 minutes-since-midnight,不是 HHmm:2607290540 = 2026-07-29 09:00 开盘,后 4 位 1055 = 17:35 收盘竞价);日线 `d` = 天数纪元(×86400000 = epoch ms)
- Vercel Hobby 限额宽裕:s-maxage CDN 缓存挡掉大部分函数调用
- 本地验证流程:`node scripts/dev_server.js` → 浏览器/Playwright 打 localhost:8899;测函数单独跑 `node -e "require('./api/quotes.js')(...)"`

## 红线

- 不写入任何持仓金额/个人信息(公有仓库)
- 研究/学习用途,非投资建议(页脚声明保留)
