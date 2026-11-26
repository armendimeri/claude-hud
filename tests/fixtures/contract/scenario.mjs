import fs from 'node:fs/promises';
import path from 'node:path';
import { board, registry, transcript } from '../../helpers.mjs';

export const sessionId = 'contract-claude-1';
export const hookInput = { session_id: sessionId, hook_event_name: 'UserPromptSubmit', prompt: 'Synthetic contract prompt' };

export const boardText = state => `# Contract fixture

## Board

| ID | Item | Agent | Depends on | Model / effort | State | Since | Handoff | Notes |
|---|---|---|---|---|---|---|---|---|
| P1 | First item | first | — | — | ${state} | | | |
`;

export async function seedContract(hud, { claude = 1, codex = 0, turns = 1 } = {}) {
  const now = Date.now();
  await board(hud, 'contract-plan', boardText('todo'));
  for (let i = 1; i <= claude; i++) {
    const id = `contract-claude-${i}`;
    // The harness is a known live PID. Filenames and session IDs are synthetic.
    await registry(hud, id, { pid: process.pid, file: `${92000 + i}.json`, startedAt: now - 30_000, statusUpdatedAt: now - 30_000 });
    const lines = Array.from({ length: turns }, (_, j) => ({
      type: 'assistant', sessionId: id, timestamp: new Date(now - 10_000 + j).toISOString(),
      message: { id: `${id}-message-${j}`, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 2 } },
    }));
    await transcript(hud, id, lines);
  }
  if (!codex) return;
  const folder = path.join(hud.codex, 'sessions');
  await fs.mkdir(folder, { recursive: true });
  const timestamp = new Date(now - 10_000).toISOString();
  for (let i = 1; i <= codex; i++) {
    const id = `contract-codex-${i}`;
    const records = [
      { type: 'session_meta', payload: { id, cwd: hud.dir, timestamp, source: 'cli', model_provider: 'openai' } },
      { type: 'turn_context', payload: { model: 'gpt-test-codex', cwd: hud.dir } },
      { type: 'event_msg', payload: { type: 'task_started' } },
      ...Array.from({ length: turns }, (_, j) => ({ type: 'event_msg', payload: {
        type: 'token_count', info: { total_token_usage: { input_tokens: j + 1, output_tokens: j + 1 }, model_context_window: 10000 },
      } })),
    ];
    await fs.writeFile(path.join(folder, `rollout-${id}.jsonl`), records.map(record => JSON.stringify({ timestamp, ...record }) + '\n').join(''));
  }
}
