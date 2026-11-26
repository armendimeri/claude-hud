import http from 'node:http';
import { ASSET_PREFIX, readPublicAsset } from './assets.mjs';
import { BASE_HEADERS, PAGE_HEADERS, hostAllowed, readJsonBody, writeAllowed } from './security.mjs';
import { createSse } from './sse.mjs';

const EVENT_BODY_MAX = 256 << 10;
const USAGE_BODY_MAX = 16 << 10;

function send(res, code, body, headers = {}) {
  if (res.destroyed) return;
  res.writeHead(code, { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

function sendJson(res, obj) {
  send(res, 200, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8' });
}

/**
 * @param {object} options
 * @param {{ host: string, port: number, hostname: string, lan: boolean }} options.config
 * @param {import('../contract/snapshot.mjs').HudSource} options.source
 * @param {{ ingestHook(value: unknown): Promise<[number, string]>, reportUsage?(value: unknown): Promise<[number, string]> }} options.writer
 */
export function createHttpServer({ config, source, writer }) {
  const stream = createSse(source);
  const server = http.createServer(handle);
  let starting;
  let closing;

  async function handle(req, res) {
    try {
      const port = req.socket.localPort;
      if (!hostAllowed(req.headers.host || '', { port, hostname: config.hostname, lan: config.lan })) {
        return send(res, 403, 'Forbidden\n');
      }
      const read = req.method === 'GET' || req.method === 'HEAD';
      // Match asset paths before URL parsing can normalize dot segments or backslashes.
      const target = req.url.split('?', 1)[0];
      if (read && target.startsWith(ASSET_PREFIX)) {
        const asset = await readPublicAsset(target);
        if (!asset) return send(res, 404, 'Not found\n');
        return send(res, 200, asset.body, { 'content-type': asset.contentType, 'content-length': asset.body.length });
      }
      const route = new URL(req.url, 'http://h').pathname;
      if (read) {
        if (route === '/') return send(res, 200, pageHtml(), PAGE_HEADERS);
        if (route === '/design') return send(res, 200, designHtml(), PAGE_HEADERS);
        if (route === '/api/state') return sendJson(res, source.readSnapshot());
        if (route === '/api/health') {
          const { uptime, totals, version } = source.readSnapshot();
          return sendJson(res, { ok: true, uptime, sessions: totals.sessions, version });
        }
        if (route === '/api/stream') return stream.open(req, res);
      }
      const hook = route === '/event';
      const write = hook ? writer.ingestHook : route === '/usage' ? writer.reportUsage : undefined;
      if (req.method !== 'POST' || !write) return send(res, 404, 'Not found\n');
      if (!writeAllowed(req.socket.remoteAddress, req.headers.origin, port)) return send(res, 403, 'Forbidden\n');
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return send(res, 415, 'Use application/json\n');
      const body = await readJsonBody(req, hook ? EVENT_BODY_MAX : USAGE_BODY_MAX);
      if (!body) return;
      if (body.code === 413) {
        res.writeHead(413, { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
        return res.end(body.message, () => req.destroy());
      }
      if (body.code) return send(res, body.code, body.message);
      const [code, message] = await write(body.value);
      return send(res, code, message ? message + '\n' : '');
    } catch (error) {
      console.error('request failed:', error);
      if (!res.headersSent) send(res, 500, 'Error\n');
      else res.destroy();
    }
  }

  function start() {
    if (closing) return Promise.reject(new Error('HUD HTTP server is closed'));
    return starting ??= new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        resolve(server.address());
      });
    });
  }

  function close() {
    return closing ??= closeServer();
  }

  async function closeServer() {
    await starting?.catch(() => {});
    stream.close();
    await new Promise((resolve, reject) => {
      server.close(error => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      });
      server.closeAllConnections();
    });
  }

  return { start, close };
}


// =====================================================================================================================
// The HUD page and the component gallery (PLAN §6, docs/DESIGN.md)
// Both pages load the same stylesheet and client components from src/web.

const HUD_FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
  + '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=JetBrains+Mono:wght@400;600&family=Orbitron:wght@500;700&family=Rajdhani:wght@600;700&display=swap">';

function hudPage(kind) {
  const module = kind === 'design' ? 'design.mjs' : 'entry.mjs';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark">
<title>${kind === 'design' ? 'Claude HUD · design system' : 'Claude HUD'}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='13' fill='%2304070d' stroke='%2329e6ff' stroke-width='2' stroke-dasharray='14 6'/%3E%3Ccircle cx='16' cy='16' r='5' fill='%2329e6ff'/%3E%3C/svg%3E">
${HUD_FONTS}
<link rel="stylesheet" href="${ASSET_PREFIX}styles/hud.css">
<script type="module" blocking="render" src="${ASSET_PREFIX}${module}"></script>
</head><body${kind === 'design' ? ' class="gallery"' : ''}>
</body></html>`;
}
let pageHtmlCache = null, designHtmlCache = null;
const pageHtml = () => pageHtmlCache ??= hudPage('page');
const designHtml = () => designHtmlCache ??= hudPage('design');
