#!/usr/bin/env node
// The agent workflow kit: links workflow/ into ~/.claude so every project on this PC uses the same standard.
// Node built-ins only. Usage: node workflow/kit.mjs install [apple-design] | uninstall | status

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const WORKFLOW = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.CLAUDE_KIT_HOME || os.homedir();     // CLAUDE_KIT_HOME: a sandbox home, for testing only
const CLAUDE_DIR = path.join(HOME, '.claude');
const SKILLS_DIR = path.join(CLAUDE_DIR, 'skills');
const MEMORY = path.join(CLAUDE_DIR, 'CLAUDE.md');

const DEFAULT_SKILLS = ['workflow-plan', 'workflow-run', 'workflow-close'];
// A personal skill overrides a project skill of the same name, so these are linked only on request, once no project
// keeps its own copy (STANDARD §13).
const OPTIONAL_SKILLS = ['apple-design'];

// The block added to ~/.claude/CLAUDE.md. Its marker records what install found, so uninstall restores it byte for
// byte: `new` (there was no file), `nl` (it ended with a newline) or `nonl` (it didn't), plus `skills-dir` when the
// kit had to create ~/.claude/skills.
const MARK = '<!-- agent-workflow standard, added by claude-hud/workflow/kit.mjs';
const IMPORT = '@~/.claude/workflow/CLAUDE.user.md';
const END = '<!-- /agent-workflow standard -->';
const block = flags => `${MARK} (${flags.join(', ')}); remove with: node workflow/kit.mjs uninstall -->\n${IMPORT}\n${END}\n`;

function links(extra) {
  const list = [{ link: path.join(CLAUDE_DIR, 'workflow'), target: WORKFLOW }];
  for (const name of [...DEFAULT_SKILLS, ...extra]) list.push({ link: path.join(SKILLS_DIR, name), target: path.join(WORKFLOW, 'skills', name) });
  return list;
}
function norm(p) { return path.resolve(p.replace(/^\\\\\?\\/, '')).replace(/[\\/]+$/, '').toLowerCase(); }
function linkState({ link, target }) {
  let st;
  try { st = fs.lstatSync(link); } catch { return 'absent'; }
  if (!st.isSymbolicLink()) return 'conflict';
  return norm(fs.readlinkSync(link)) === norm(target) ? 'linked' : 'conflict';
}
function ours(link) {
  try { return fs.lstatSync(link).isSymbolicLink() && norm(fs.readlinkSync(link)).startsWith(norm(WORKFLOW)); } catch { return false; }
}
function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function backup(file) {
  const base = `${file}.workflow-backup-${stamp()}`;
  for (let n = 1; ; n++) {
    const to = n === 1 ? base : `${base}-${n}`;
    try { fs.copyFileSync(file, to, fs.constants.COPYFILE_EXCL); return to; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
}
function readMemory() { try { return fs.readFileSync(MEMORY, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
function findBlock(text) {
  const start = text.indexOf(MARK);
  if (start < 0) return null;
  const endAt = text.indexOf(END, start);
  if (endAt < 0) return null;
  let stop = endAt + END.length;
  if (text[stop] === '\n') stop++;
  const flags = ((/\(([^)]*)\)/.exec(text.slice(start, text.indexOf('\n', start))) || [])[1] || 'nl').split(/,\s*/);
  return { start, stop, how: flags.find(f => ['new', 'nl', 'nonl'].includes(f)) || 'nl', skillsDir: flags.includes('skills-dir') };
}

function install(args) {
  const unknown = args.filter(a => !OPTIONAL_SKILLS.includes(a));
  if (unknown.length) fail(`Unknown skill: ${unknown.join(', ')}. Optional skills: ${OPTIONAL_SKILLS.join(', ')}`);
  const list = links(args);
  for (const l of list) if (!fs.existsSync(l.target)) fail(`Missing in this repository: ${l.target}`);
  const conflicts = list.filter(l => linkState(l) === 'conflict');
  if (conflicts.length) fail(`Not installed. These exist already and were not made by this kit:\n${conflicts.map(c => `  ${c.link}`).join('\n')}\nMove them away or remove them, then run install again.`);

  const text = readMemory();
  const hasBlock = text != null && findBlock(text);
  const madeSkillsDir = !fs.existsSync(SKILLS_DIR);
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  const done = [];
  for (const l of list) if (linkState(l) === 'absent') { fs.symlinkSync(l.target, l.link, 'junction'); done.push(`linked  ${l.link}`); }

  if (!hasBlock) {
    const extra = madeSkillsDir ? ['skills-dir'] : [];
    if (text == null) {
      fs.writeFileSync(MEMORY, block(['new', ...extra]));
      done.push(`created ${MEMORY} (the import line only)`);
    } else {
      const b = backup(MEMORY);
      const endsNl = text === '' || text.endsWith('\n');
      fs.writeFileSync(MEMORY, text + (text === '' ? '' : endsNl ? '\n' : '\n\n') + block([endsNl ? 'nl' : 'nonl', ...extra]));
      done.push(`added   the import line to ${MEMORY} (backup: ${b})`);
    }
  }
  console.log(done.length ? done.join('\n') : 'Already installed: nothing changed.');
  if (done.length) console.log('New sessions load the shared rules. Open sessions see the skills within seconds (or after /reload-skills).');
}

function uninstall() {
  const done = [];
  const candidates = [path.join(CLAUDE_DIR, 'workflow'), ...[...DEFAULT_SKILLS, ...OPTIONAL_SKILLS].map(n => path.join(SKILLS_DIR, n))];
  for (const link of candidates) if (ours(link)) { fs.rmdirSync(link); done.push(`removed ${link}`); }   // removes the junction, never its target

  const text = readMemory();
  const found = text == null ? null : findBlock(text);
  if (found) {
    let before = text.slice(0, found.start);
    const after = text.slice(found.stop);
    if (found.how === 'nl' && before.endsWith('\n') && before.length) before = before.slice(0, -1);
    if (found.how === 'nonl' && before.endsWith('\n\n')) before = before.slice(0, -2);
    const rest = before + after;
    if (found.how === 'new' && rest === '') { fs.rmSync(MEMORY); done.push(`deleted ${MEMORY} (it held only the import line)`); }
    else { const b = backup(MEMORY); fs.writeFileSync(MEMORY, rest); done.push(`removed the import line from ${MEMORY} (backup: ${b})`); }
    if (found.skillsDir) {
      try { fs.rmdirSync(SKILLS_DIR); done.push(`removed ${SKILLS_DIR} (install had created it; it is empty again)`); } catch {}
    }
  }
  console.log(done.length ? done.join('\n') : 'Not installed: nothing changed.');
}

function status() {
  for (const l of links(OPTIONAL_SKILLS)) {
    const st = linkState(l);
    const optional = OPTIONAL_SKILLS.some(n => l.link.endsWith(n));
    console.log(`${st.padEnd(8)} ${l.link}${optional && st === 'absent' ? '   (optional)' : ''}`);
  }
  const text = readMemory();
  console.log(`${text != null && findBlock(text) ? 'linked' : 'absent'}   ${MEMORY}: ${IMPORT}`);
}

function fail(msg) { console.error(msg); process.exit(1); }

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'install') install(args);
else if (cmd === 'uninstall') uninstall();
else if (cmd === 'status' || !cmd) status();
else fail('Usage: node workflow/kit.mjs install [apple-design] | uninstall | status');
