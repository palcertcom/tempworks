#!/usr/bin/env node
// Local equivalent of the production Apache vhost (public/.htaccess):
//   * /api/*      -> reverse-proxied to the NestJS backend
//   * /uploads/*  -> reverse-proxied to the backend (legacy local files)
//   * anything else -> static file from the built SPA, falling back to index.html
//
// Usage: node webproxy.mjs <port> <spaDistDir> <backendOrigin>
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';

const [port, dist, backend] = process.argv.slice(2);
if (!port || !dist || !backend) {
  console.error('usage: webproxy.mjs <port> <spaDistDir> <backendOrigin>');
  process.exit(1);
}
const target = new URL(backend);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json',
};

function proxy(req, res) {
  const up = http.request({
    hostname: target.hostname, port: target.port, path: req.url, method: req.method,
    headers: { ...req.headers, host: `${target.hostname}:${target.port}`, 'x-forwarded-for': req.socket.remoteAddress },
  }, (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); });
  up.on('error', (e) => { res.writeHead(502, { 'content-type': 'text/plain' }); res.end(`backend unavailable: ${e.message}`); });
  req.pipe(up);
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = normalize(join(dist, urlPath));
  if (!file.startsWith(normalize(dist))) { res.writeHead(403); return res.end(); }
  try { if (!statSync(file).isFile()) throw new Error('dir'); }
  catch { file = join(dist, 'index.html'); } // SPA fallback
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

http.createServer((req, res) => {
  if (req.url.startsWith('/api/') || req.url.startsWith('/uploads/')) return proxy(req, res);
  return serveStatic(req, res);
}).listen(Number(port), '127.0.0.1', () => {
  console.log(`web front on http://127.0.0.1:${port}  (static ${dist}, /api -> ${backend})`);
});
