// Usage: node tests/tools/stream-size.mjs (<base url> | --demo | --demo=dense | --baseline | --hooks) [--seconds=30]
// A URL is read-only. Demo and baseline modes start isolated HUDs. The baseline also samples Windows process counters.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pause, script, startHud, transcript } from '../helpers.mjs';
import { hookInput, seedContract, sessionId } from '../fixtures/contract/scenario.mjs';

const args = process.argv.slice(2);
const opt = name => {
  const arg = args.find(x => x === `--${name}` || x.startsWith(`--${name}=`));
  return arg?.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg !== undefined ? true : undefined;
};
const seconds = Number(opt('seconds') ?? 30);
const demo = opt('demo');
const baseline = args.includes('--baseline');
const hooks = args.includes('--hooks');
const url = args.find(a => !a.startsWith('--'));
if (!Number.isFinite(seconds) || seconds <= 0 || Number(Boolean(url)) + Number(demo !== undefined) + Number(baseline) + Number(hooks) !== 1 ||
    (baseline && (!Number.isSafeInteger(seconds) || seconds < 3 || process.platform !== 'win32'))) {
  console.error('Usage: node tests/tools/stream-size.mjs (<base url> | --demo | --demo=dense | --baseline | --hooks) [--seconds=30]');
  console.error('--baseline requires Windows and a whole number of seconds (at least 3)');
  process.exit(2);
}

async function measureStream(base) {
  const stats = new Map();
  const count = (name, bytes) => {
    const stat = stats.get(name) || { n: 0, bytes: 0, max: 0 };
    stat.n++;
    stat.bytes += bytes;
    stat.max = Math.max(stat.max, bytes);
    stats.set(name, stat);
  };
  const ac = new AbortController();
  const started = performance.now();
  let timer, firstState = true, buf = '';
  try {
    const res = await fetch(base.replace(/\/+$/, '') + '/api/stream', { signal: ac.signal });
    if (!res.ok) throw new Error(`${base}/api/stream answered ${res.status}`);
    const reader = res.body.getReader(), decoder = new TextDecoder();
    timer = setTimeout(() => ac.abort(), seconds * 1000);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, cut + 2);
        buf = buf.slice(cut + 2);
        if (!/^data: /m.test(block)) continue;
        const event = /^event: (.+)$/m.exec(block)?.[1] ?? 'message';
        if (event === 'state') {
          count(firstState ? 'state (first)' : 'state (later)', Buffer.byteLength(block));
          firstState = false;
        } else count(event, Buffer.byteLength(block));
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError' || !ac.signal.aborted) throw e;
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return { stats, elapsed: (performance.now() - started) / 1000 };
}

function reportStream({ stats, elapsed }, label) {
  console.log(`${label} for ${elapsed.toFixed(1)} s (typed SSE frames, including framing)`);
  console.log('event             count   avg B   max B  total B');
  let total = 0, frames = 0;
  for (const [name, stat] of [...stats].sort((a, b) => a[0].localeCompare(b[0]))) {
    total += stat.bytes;
    frames += stat.n;
    console.log(`${name.padEnd(17)} ${String(stat.n).padStart(5)} ${String(Math.round(stat.bytes / stat.n)).padStart(7)} ${String(stat.max).padStart(7)} ${String(stat.bytes).padStart(8)}`);
  }
  console.log(`all               ${String(frames).padStart(5)} ${''.padStart(15)} ${String(total).padStart(8)}`);
}

async function firstFullFrame(hud) {
  const start = performance.now();
  hud.launch();
  while (performance.now() - start < 15000) {
    let stream;
    try {
      stream = await hud.stream();
    } catch (error) {
      if (!['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET'].includes(error.cause?.code)) throw error;
      if (hud.child.exitCode !== null) throw new Error(`HUD exited during startup: ${hud.stderr()}`);
      await pause(10);
      continue;
    }
    try {
      const first = await stream.next(() => true, Math.max(1, 15000 - (performance.now() - start)));
      assert.equal(first.event, 'state');
      assert.equal(first.data.full, true);
      return performance.now() - start;
    } finally {
      stream.close();
    }
  }
  throw new Error(`No first full frame: ${hud.stderr()}`);
}

async function sampleWindowsProcess(pid) {
  const command = `
$watch = [Diagnostics.Stopwatch]::StartNew()
for ($i = 0; $i -le ${seconds}; $i++) {
  $wait = ($i * 1000) - $watch.ElapsedMilliseconds
  if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
  $target = Get-Process -Id ${pid} -ErrorAction Stop
  $cpu = $target.TotalProcessorTime.TotalSeconds.ToString([Globalization.CultureInfo]::InvariantCulture)
  [Console]::WriteLine("$($watch.ElapsedMilliseconds) $cpu $($target.PeakWorkingSet64)")
}`;
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true });
  const samples = stdout.trim().split(/\r?\n/).map(row => row.split(' ').map(Number));
  assert.equal(samples.length, seconds + 1);
  assert.ok(samples.every(row => row.length === 3 && row.every(Number.isFinite) && row[2] > 0));
  const [start, startCpu] = samples[0];
  const [end, endCpu] = samples.at(-1);
  return { peakRss: Math.max(...samples.map(row => row[2])), meanCpu: (endCpu - startCpu) / ((end - start) / 1000) * 100, count: samples.length };
}

const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];

async function measureHooks(hud) {
  let received = 0;
  const receiver = http.createServer((req, res) => {
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/event') { received++; res.writeHead(204).end(); }
      else res.writeHead(404).end();
    });
    req.resume();
  });
  receiver.listen(hud.port, '127.0.0.1');
  await once(receiver, 'listening');
  const input = JSON.stringify(hookInput);
  const commands = [
    { label: 'node -e ""', args: ['-e', ''], samples: [] },
    { label: 'node hud.mjs hook', args: [script, 'hook'], samples: [] },
    { label: 'node hud-hook.mjs', args: [fileURLToPath(new URL('../../hud-hook.mjs', import.meta.url))], samples: [] },
  ];
  try {
    for (let i = 0; i < 30; i++) {
      for (let offset = 0; offset < commands.length; offset++) {
        const command = commands[(offset + i) % commands.length];
        const start = performance.now();
        const child = hud.spawnCli(command.args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let output = '';
        for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
        child.stdin.on('error', error => { if (error.code !== 'EPIPE') throw error; });
        child.stdin.end(input);
        const [code] = await once(child, 'close');
        command.samples.push(performance.now() - start);
        assert.equal(code, 0);
        assert.equal(output, '');
      }
    }
    assert.equal(received, 60, 'both hook commands delivered all synthetic posts');
    console.log(`Hook startup through exit: 30 interleaved runs per command, ${received} posts to a loopback 204 receiver`);
    for (const command of commands) console.log(`  ${command.label} p95: ${percentile(command.samples, 0.95).toFixed(2)} ms`);
    const overhead = percentile(commands[2].samples, 0.95) - percentile(commands[0].samples, 0.95);
    console.log(`  standalone overhead vs bare Node: ${overhead.toFixed(2)} ms (15 ms budget)`);
    return overhead;
  } finally {
    await new Promise(resolve => receiver.close(resolve));
  }
}

async function replay(hud) {
  for (let i = 1; i < seconds; i += 2) {
    await pause(i === 1 ? 1000 : 2000);
    const at = Date.now();
    await transcript(hud, sessionId, [{
      type: 'assistant', sessionId, timestamp: new Date(at).toISOString(),
      message: { id: `contract-replay-${i}`, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 2 } },
    }]);
    const hook_event_name = i % 4 === 1 ? 'UserPromptSubmit' : 'Stop';
    assert.equal(await hud.post({ ...hookInput, cwd: hud.dir, hook_event_name, hud_at: at }), 204);
  }
}

async function measureBaseline(hud) {
  console.log(`Node ${process.version}, ${process.platform}/${process.arch}, ${os.cpus()[0].model}`);
  console.log('Synthetic live workload: 16 Claude and 8 Codex sessions, 256 transcript records per session plus Codex metadata, one board, one SSE subscriber');
  await measureHooks(hud);
  await seedContract(hud, { claude: 16, codex: 8, turns: 256 });
  const startup = [];
  for (let i = 0; i < 7; i++) {
    startup.push(await firstFullFrame(hud));
    if (i < 6) await hud.stop();
  }
  console.log(`Cold process launch to first full SSE frame: median ${percentile(startup, 0.5).toFixed(2)} ms (7 runs: ${startup.map(ms => ms.toFixed(2)).join(', ')})`);
  await hud.until(s => s.sessions.filter(x => x.agent === 'claude' && x.tokens.output === 512).length === 16 &&
    s.sessions.filter(x => x.agent === 'codex' && x.tokens.output === 256).length === 8 && s.plans.length === 1);
  console.log(`Sampling every 1000 ms for ${seconds} s; appending a Claude turn and posting a hook every 2 s`);
  const results = await Promise.allSettled([measureStream(hud.base), sampleWindowsProcess(hud.child.pid), replay(hud)]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  const [stream, resources] = results.map(result => result.value);
  assert.ok(stream.stats.get('state (later)')?.n > 0, 'replay should produce steady-state frames');
  reportStream(stream, 'Synthetic live SSE');
  console.log(`Peak HUD RSS: ${resources.peakRss} bytes (${(resources.peakRss / 2 ** 20).toFixed(2)} MiB, process lifetime high-water mark)`);
  console.log(`Mean HUD CPU: ${resources.meanCpu.toFixed(3)}% of one logical core (${resources.count} samples; CPU seconds / elapsed wall seconds)`);
}

if (url) {
  reportStream(await measureStream(url), `${url}/api/stream`);
} else {
  const hud = await startHud({ demo: demo === 'dense' ? 'dense' : demo !== undefined, start: false });
  try {
    if (baseline) await measureBaseline(hud);
    else if (hooks) process.exitCode = (await measureHooks(hud)) > 15 ? 1 : 0;
    else {
      await hud.restart();
      reportStream(await measureStream(hud.base), `Isolated ${demo === 'dense' ? 'dense demo' : 'demo'} SSE`);
    }
  } finally {
    await hud.close();
  }
}
