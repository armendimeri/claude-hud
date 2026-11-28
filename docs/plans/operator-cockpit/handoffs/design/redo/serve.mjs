// P2-01 look study: a tiny loopback server for the prototype.
//
//   node docs/plans/operator-cockpit/handoffs/design/redo/serve.mjs [--port=7791] [--target=http://127.0.0.1:7790]
//
// - Serves the repository read-only, but only the two folders the prototype needs: this redo folder and src/web/
//   (the vendored three.js and the unchanged layout/projection modules). Dotfiles and anything else are refused.
// - Proxies GET /api/state to a running HUD, because the HUD sends no CORS headers and a page on another port cannot
//   read it directly. The page may name another HUD with ?target=; only loopback HUDs are allowed.
// - Binds 127.0.0.1 only. It never starts, stops or writes to a HUD.
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../../../..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const b = a.replace(/^--/, ''), i = b.indexOf('='); return i < 0 ? [b, true] : [b.slice(0, i), b.slice(i + 1)]; }));
const port = Number(args.port || 7791);
const defaultTarget = String(args.target || 'http://127.0.0.1:7790');
const ALLOWED = ['docs/plans/operator-cockpit/handoffs/design/redo/', 'src/web/'];
const PAGE = '/docs/plans/operator-cockpit/handoffs/design/redo/index.html';
const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

const loopback = url => { try { const u = new URL(url); return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname); } catch { return false; } };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  if (url.pathname === '/' || url.pathname === '/redo') { res.writeHead(302, { Location: PAGE + url.search }).end(); return; }
  if (url.pathname === '/api/state') {
    const target = url.searchParams.get('target') || defaultTarget;
    if (!loopback(target)) { res.writeHead(400, { 'Content-Type': 'text/plain' }).end('target must be a loopback http URL'); return; }
    try {
      const upstream = await fetch(new URL('/api/state', target), { signal: AbortSignal.timeout(4000) });
      const body = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store', 'X-Proxied-From': new URL(target).host }).end(body);
    } catch (error) {
      res.writeHead(502, { 'Content-Type': 'text/plain' }).end('HUD not answering at ' + target + ': ' + (error.cause?.code || error.message));
    }
    return;
  }
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(repo, rel);
  const inside = path.relative(repo, file).split(path.sep).join('/');
  const ok = !inside.startsWith('..') && !path.isAbsolute(inside) && !inside.split('/').some(p => p.startsWith('.'))
    && ALLOWED.some(prefix => inside.startsWith(prefix)) && existsSync(file) && statSync(file).isFile();
  if (!ok) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`look study: http://127.0.0.1:${port}${PAGE}`);
  console.log(`live data:  http://127.0.0.1:${port}${PAGE}?api=${defaultTarget}`);
});
