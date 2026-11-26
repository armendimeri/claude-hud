export const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

export const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

// LAN viewers may use the machine's IP address or name. Refuse arbitrary names to guard against DNS rebinding.
export function hostAllowed(host, { port, hostname, lan = false }) {
  if (host === `127.0.0.1:${port}` || host === `localhost:${port}`) return true;
  if (!lan) return false;
  const match = /^(\[[0-9a-f:.]+\]|[^\s:/[\]]+)(?::(\d{1,5}))?$/i.exec(host);
  if (!match || Number(match[2] ?? 80) !== port) return false;
  const name = match[1].toLowerCase(), self = hostname.toLowerCase();
  return name === self || name === `${self}.local` || name.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(name);
}

export function writeAllowed(address, origin, port) {
  return typeof address === 'string' && /^(::1|(::ffff:)?127\.\d+\.\d+\.\d+)$/i.test(address)
    && (!origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`);
}

/** Parse a single bounded request body. Aborted requests have no response to send. */
export function readJsonBody(req, maxBytes) {
  return new Promise(resolve => {
    const chunks = [];
    let size = 0;
    function complete(result) {
      req.off('data', read);
      resolve(result);
    }
    function read(chunk) {
      size += chunk.length;
      if (size > maxBytes) {
        req.pause();
        complete({ code: 413, message: 'Too large\n' });
      } else chunks.push(chunk);
    }
    req.on('data', read);
    req.once('error', () => complete(null));
    req.once('close', () => complete(null));
    req.once('end', () => {
      try {
        complete({ value: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch {
        complete({ code: 400, message: 'Bad JSON\n' });
      }
    });
  });
}
