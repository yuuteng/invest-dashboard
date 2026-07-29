// 本地测试服务:静态文件 + /api/*(模拟 Vercel 路由)
// 用法: node scripts/dev_server.js  → http://localhost:8899
const http = require("http");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const quotes = require(path.join(ROOT, "api/quotes.js"));
const history = require(path.join(ROOT, "api/history.js"));

const MIME = { ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8", ".js": "text/javascript" };

http.createServer(async (req, res) => {
  const route = req.url.startsWith("/api/quotes") ? quotes : req.url.startsWith("/api/history") ? history : null;
  if (route) {
    const shim = {
      setHeader: (k, v) => res.setHeader(k, v),
      status(c) { res.statusCode = c; return this; },
      send: (b) => res.end(b),
      json(o) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); },
    };
    try { await route(req, shim); } catch (e) { res.statusCode = 500; res.end(String(e)); }
    return;
  }
  const file = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  fs.readFile(path.join(ROOT, file), (err, data) => {
    if (err) { res.statusCode = 404; return res.end("404"); }
    res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
    res.end(data);
  });
}).listen(8899, () => console.log("dev server on http://localhost:8899"));
