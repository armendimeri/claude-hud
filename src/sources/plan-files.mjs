import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { projectInfo } from './projects.mjs';

const PLAN_POLL_MS = 10_000;             // recover missed file events and documentation folders created later
const PLAN_TOP_DIRS = ['docs', 'Documentation', 'doc'];
const PLAN_FILE_RE = /^(?:.*[-_])?(?:status|plan)\.md$|^(?:handoff|rollout)\.md$/i;
export const PLAN_SKIP_DIRS = new Set(['_template', 'node_modules', 'bin', 'obj', 'handoff', 'handoffs', 'archive', 'archives', '.git']);

export function createPlanFiles({ lifetime, parseCandidate, onScan, onDrop }) {
  const roots = new Map();

  function ensureRoot(root, project) {
    const key = root.toLowerCase();
    if (roots.has(key)) return;
    const rec = { root, project, watchers: new Map(), timer: null, scanning: false, scanAgain: false, lastScanAt: 0 };
    roots.set(key, rec);
    scanRoot(key);
  }
  function watchPlanDirs(key, rec) {
    for (const top of PLAN_TOP_DIRS) {
      const dir = path.join(rec.root, top);
      if (rec.watchers.has(dir) || !fs.existsSync(dir)) continue;
      try {
        const w = lifetime.watch(dir, { recursive: true }, (e, f) => { if (e === 'rename' || !f || /\.md$/i.test(f)) scheduleRootScan(key); });
        if (!w) return;
        w.on('error', () => { w.close(); rec.watchers.delete(dir); });
        rec.watchers.set(dir, w);
      } catch {}
    }
  }
  function scheduleRootScan(key) {
    const rec = roots.get(key);
    if (!rec || rec.timer) return;
    rec.timer = lifetime.timeout(() => { rec.timer = null; scanRoot(key); }, 400);
  }
  function dropRoot(key) {
    const rec = roots.get(key);
    if (!rec) return;
    for (const w of rec.watchers.values()) try { w.close(); } catch {}
    lifetime.clearTimer(rec.timer);
    roots.delete(key);
    onDrop(key);
  }
  const scanRoot = lifetime.task(async function (key) {
    const rec = roots.get(key);
    if (!rec) return;
    if (rec.scanning) { rec.scanAgain = true; return; }
    rec.scanning = true;
    try {
      watchPlanDirs(key, rec);
      await readRootPlans(key, rec);
    } finally {
      rec.lastScanAt = Date.now();
      rec.scanning = false;
      if (rec.scanAgain && roots.get(key) === rec) { rec.scanAgain = false; scheduleRootScan(key); }
    }
  });
  async function readRootPlans(key, rec) {
    const files = [];
    const walk = async (dir, depth) => {
      if (lifetime.signal.aborted) return;
      let ents;
      try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      const smallPlans = depth === 1 && path.basename(dir).toLowerCase() === 'plans';
      for (const e of ents) {
        if (e.isDirectory()) { if (depth < 4 && !PLAN_SKIP_DIRS.has(e.name.toLowerCase()) && !e.name.startsWith('.')) await walk(path.join(dir, e.name), depth + 1); }
        else if (PLAN_FILE_RE.test(e.name) || (smallPlans && /\.md$/i.test(e.name))) files.push(path.join(dir, e.name));
      }
    };
    for (const top of PLAN_TOP_DIRS) await walk(path.join(rec.root, top), 0);
    const info = await projectInfo(rec.root);
    const root = { root: rec.root, project: rec.project };
    const candidates = [];
    for (const f of files) {
      if (lifetime.signal.aborted) return;
      let st, text, planText = null;
      try { st = await fsp.stat(f); text = await fsp.readFile(f, 'utf8'); } catch { continue; }
      if (/status\.md$/i.test(f)) { try { planText = await fsp.readFile(path.join(path.dirname(f), 'PLAN.md'), 'utf8'); } catch {} }
      const candidate = parseCandidate({ file: f, mtime: st.mtimeMs, text, planText }, root);
      if (candidate) candidates.push(candidate);
    }
    if (lifetime.signal.aborted || roots.get(key) !== rec) return;
    rec.info = info;
    onScan(key, root, candidates);
  }

  function poll(projects, now) {
    for (const [key, rec] of roots) {
      if (!projects.has(rec.project)) dropRoot(key);
      else if (now - rec.lastScanAt >= PLAN_POLL_MS) void scanRoot(key);
    }
  }

  return { ensureRoot, poll, roots: () => roots.values() };
}
