// Stream size: node tests/tools/stream-size.mjs [<base url> | --demo | --demo=dense] [--seconds=30]
// Connects to a HUD's /api/stream for the given time and prints, for each event type, how many arrived, their size
// and their rate. The first `state` of the connection (the full state) is counted apart from the later ones.
// With --demo or --demo=dense it starts its own demo HUD on a free port (tests/helpers.mjs) and stops it after.
// With a URL it only reads that HUD's stream; it never posts anything. Node built-ins only.
import { startHud } from '../helpers.mjs';

const args = process.argv.slice(2);
const opt = name => { const a = args.find(x => x === `--${name}` || x.startsWith(`--${name}=`)); return a === undefined ? undefined : a.includes('=') ? a.slice(a.indexOf('=') + 1) : true; };
const seconds = Number(opt('seconds') ?? 30);
const demo = opt('demo');
let base = args.find(a => !a.startsWith('--'));
if (!(seconds > 0) || (!base && demo === undefined)) {
  console.error('Usage: node tests/tools/stream-size.mjs (<base url> | --demo | --demo=dense) [--seconds=30]');
  process.exit(2);
}

let hud = null;
if (!base) { hud = await startHud({ demo: demo === 'dense' ? 'dense' : true }); base = hud.base; }
base = base.replace(/\/+$/, '');

const stats = new Map();   // name -> { n, bytes, max }
const count = (name, bytes) => { const s = stats.get(name) || { n: 0, bytes: 0, max: 0 }; s.n++; s.bytes += bytes; s.max = Math.max(s.max, bytes); stats.set(name, s); };
const ac = new AbortController();
const started = Date.now();
let firstState = true, buf = '';
try {
  const res = await fetch(base + '/api/stream', { signal: ac.signal });
  if (!res.ok) throw new Error(`${base}/api/stream answered ${res.status}`);
  const reader = res.body.getReader(), decoder = new TextDecoder();
  const timer = setTimeout(() => ac.abort(), seconds * 1000);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, cut + 2); buf = buf.slice(cut + 2);
        let event = 'message', data = false;
        for (const line of block.split('\n')) { if (line.startsWith('event: ')) event = line.slice(7); else if (line.startsWith('data: ')) data = true; }
        if (!data) continue;   // keep-alive comments and the retry line
        const bytes = Buffer.byteLength(block);
        if (event === 'state') { count(firstState ? 'state (first)' : 'state (later)', bytes); firstState = false; }
        else count(event, bytes);
      }
    }
  } catch (e) { if (e.name !== 'AbortError') throw e; }
  clearTimeout(timer);
} finally {
  if (hud) await hud.close();
}

const secs = (Date.now() - started) / 1000;
const kb = b => (b / 1024).toFixed(1);
console.log(`${base}/api/stream for ${secs.toFixed(1)} s${hud ? ` (own ${demo === 'dense' ? '--demo=dense' : '--demo'} HUD)` : ''}`);
console.log('event           count   avg KB   max KB  total KB   per s   KB/s');
let total = 0;
for (const [name, s] of [...stats].sort((a, b) => a[0].localeCompare(b[0]))) {
  total += s.bytes;
  console.log(`${name.padEnd(15)} ${String(s.n).padStart(5)} ${kb(s.bytes / s.n).padStart(8)} ${kb(s.max).padStart(8)} ${kb(s.bytes).padStart(9)} ${(s.n / secs).toFixed(2).padStart(7)} ${kb(s.bytes / secs).padStart(6)}`);
}
console.log(`all             ${String([...stats.values()].reduce((n, s) => n + s.n, 0)).padStart(5)} ${''.padStart(8)} ${''.padStart(8)} ${kb(total).padStart(9)} ${''.padStart(7)} ${kb(total / secs).padStart(6)}`);
