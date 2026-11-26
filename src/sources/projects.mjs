import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { cleanCell } from '../domain/plan-parser.mjs';
import { oneLine, str, truncate } from '../domain/tools.mjs';

const PLAN_PATH_RE = /(?:^|[\\/])(?:docs|documentation|doc)[\\/].*\.md$/i;

export function createProjectSource() {
  const rootCache = new Map();

  function rootFor(cwd) {
    const key = cwd.toLowerCase();
    let r = rootCache.get(key);
    if (r) return r;
    let dir = path.resolve(cwd), root = null, mainRoot = null;
    for (let i = 0; i < 40; i++) {
      const git = path.join(dir, '.git');
      let st = null;
      try { st = fs.statSync(git); } catch {}
      if (st) {
        root = dir; mainRoot = dir;
        if (st.isFile()) {
          const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(git, 'utf8'));
          const wt = m && m[1].trim().split(/[\\/]\.git[\\/]worktrees[\\/]/);
          if (wt && wt.length > 1) mainRoot = path.resolve(dir, wt[0]);
        }
        break;
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    root ??= path.resolve(cwd);
    mainRoot ??= root;
    r = { root, mainRoot, project: path.basename(mainRoot) || mainRoot };
    rootCache.set(key, r);
    return r;
  }
  /**
   * The key of a plan file an agent read or wrote, `<project>|<path from the project root>` lower-cased with forward
   * slashes, or null outside a docs folder. Either slash and any case give the same key, and a file in a worktree gets
   * the main repository's project (rootFor), so it belongs to the main repository's plan.
   */
  function planFileKey(file, cwd) {
    file = str(file);
    if (!file || !PLAN_PATH_RE.test(file)) return null;
    if (!path.isAbsolute(file)) { if (!cwd) return null; file = path.resolve(cwd, file); }
    const abs = path.resolve(file);
    const r = rootFor(path.dirname(abs));
    const rel = path.relative(r.root, abs).replace(/\\/g, '/');
    return /^(?:docs|documentation|doc)\//i.test(rel) ? `${r.project}|${rel}`.toLowerCase() : null;
  }

  return { rootFor, planFileKey };
}

// The project's headline (the first section of docs/status.md) and the CLAUDE.md Workflow and Git lines (STANDARD §17).
export async function projectInfo(root) {
  const read = async f => { try { return await fsp.readFile(path.join(root, f), 'utf8'); } catch { return null; } };
  const status = await read('docs/status.md');
  const claude = await read('CLAUDE.md');
  let headline = null;
  if (status) {
    const m = /^##\s+The project in one paragraph\s*$([\s\S]*?)(?=^#{1,2}\s|(?![\s\S]))/im.exec(status);
    headline = m ? truncate(oneLine(cleanCell(m[1])), 300) || null : null;
  }
  const git = claude && (/^\*\*Git:\*\*\s*(you commit|agents commit per item)/im.exec(claude) || [])[1];
  return { headline, standard: !!claude && /^\*\*Workflow:\*\*.*standard/im.test(claude), git: git ? git.toLowerCase() : null };
}

export function projectsView(roots) {
  const out = new Map();
  for (const r of roots) {
    const prev = out.get(r.project);
    if (prev && (prev.headline || !r.info?.headline)) continue;
    out.set(r.project, { project: r.project, root: r.root, headline: r.info?.headline ?? null, standard: r.info?.standard ?? false, git: r.info?.git ?? null });
  }
  return [...out.values()].sort((a, b) => a.project.localeCompare(b.project));
}
