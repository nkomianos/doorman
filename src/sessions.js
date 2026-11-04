// "What are my agents doing right now?" Read-only and zero-setup: we look at the
// session logs Claude Code and Codex already write, only the tail of recently
// touched files, and keep the result on this machine.
import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { truncate } from './util.js';

const TAIL_BYTES = 256 * 1024;
const MAX_AGE_MS = 12 * 3600e3;

function tailLines(file, bytes = TAIL_BYTES) {
  const size = statSync(file).size;
  const len = Math.min(size, bytes);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, 'r');
  try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
  const lines = buf.toString('utf8').split('\n');
  if (size > len) lines.shift(); // first line is probably cut in half
  const out = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* partial line */ }
  }
  return out;
}

function headLines(file, bytes = 384 * 1024) {
  const fd = openSync(file, 'r');
  const buf = Buffer.alloc(bytes);
  let n;
  try { n = readSync(fd, buf, 0, bytes, 0); } finally { closeSync(fd); }
  const out = [];
  for (const l of buf.subarray(0, n).toString('utf8').split(String.fromCharCode(10)).slice(0, -1)) {
    try { out.push(JSON.parse(l)); } catch { /* skip */ }
  }
  return out;
}

function recentFiles(dir, depth, now, pattern = /\.jsonl$/) {
  const out = [];
  const walk = (d, level) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory() && level < depth) walk(p, level + 1);
      else if (e.isFile() && pattern.test(e.name)) {
        try {
          const st = statSync(p);
          if (now - st.mtimeMs < MAX_AGE_MS) out.push({ file: p, mtime: st.mtimeMs });
        } catch { /* gone */ }
      }
    }
  };
  if (existsSync(dir)) walk(dir, 0);
  return out;
}

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => ['text', 'input_text'].includes(c.type)).map((c) => c.text).join(' ');
  return '';
};
const project = (cwd) => (cwd ? basename(cwd.replace(/[\\/]+$/, '')) : null);

/** Status from the last meaningful entry plus how long the file has been quiet. */
function claudeStatus(last, quietMs) {
  if (!last) return { status: 'idle', detail: 'No activity yet' };
  if (last.type === 'assistant') {
    const stop = last.message?.stop_reason;
    const tools = (last.message?.content || []).filter((c) => c.type === 'tool_use');
    if (stop === 'tool_use' || tools.length) {
      const tool = tools.at(-1)?.name;
      // A tool call with no result for a while usually means a permission prompt.
      if (quietMs > 45e3) return { status: 'waiting', detail: tool ? `Probably waiting for you to approve ${tool}` : 'Probably waiting for approval' };
      return { status: 'working', detail: tool ? `Running ${tool}` : 'Working' };
    }
    if (stop === 'end_turn' || stop === 'stop_sequence') return { status: quietMs < 6 * 3600e3 ? 'done' : 'idle', detail: 'Finished its turn, waiting for your next message' };
    return { status: quietMs < 90e3 ? 'working' : 'idle', detail: quietMs < 90e3 ? 'Thinking' : 'Quiet' };
  }
  if (last.type === 'user') return { status: quietMs < 5 * 60e3 ? 'working' : 'idle', detail: quietMs < 5 * 60e3 ? 'Thinking' : 'Quiet' };
  return { status: 'idle', detail: 'Quiet' };
}

export function claudeSessions({ home = homedir(), now = Date.now() } = {}) {
  const files = recentFiles(join(home, '.claude', 'projects'), 1, now).sort((a, b) => b.mtime - a.mtime).slice(0, 12);
  return files.map(({ file, mtime }) => {
    const entries = tailLines(file);
    let title = null;
    let cwd = null;
    let branch = null;
    let prompt = null;
    let last = null;
    for (const e of entries) {
      if (e.type === 'custom-title' && e.customTitle) title = e.customTitle;
      else if (e.type === 'agent-name' && e.agentName && !title) title = e.agentName;
      else if (e.type === 'summary' && e.summary && !title) title = e.summary;
      if (e.cwd) cwd = e.cwd;
      if (e.gitBranch) branch = e.gitBranch;
      if (e.type === 'user' || e.type === 'assistant') {
        if (e.isSidechain) continue;
        last = e;
        if (e.type === 'user' && typeof e.message?.content === 'string') prompt = e.message.content;
        else if (e.type === 'user' && Array.isArray(e.message?.content) && e.message.content.some((c) => c.type === 'text')) prompt = textOf(e.message.content);
      }
    }
    const quietMs = now - mtime;
    const s = claudeStatus(last, quietMs);
    return {
      id: `claude:${basename(file, '.jsonl')}`,
      agent: 'Claude Code',
      title: truncate(title || prompt || 'Untitled session', 90),
      project: project(cwd),
      cwd,
      branch: branch && branch !== 'HEAD' ? branch : null,
      status: s.status,
      detail: s.detail,
      last_activity: mtime,
    };
  });
}

export function codexSessions({ home = homedir(), now = Date.now() } = {}) {
  const files = recentFiles(join(home, '.codex', 'sessions'), 3, now).sort((a, b) => b.mtime - a.mtime).slice(0, 8);
  return files.map(({ file, mtime }) => {
    const entries = [...headLines(file), ...tailLines(file, 128 * 1024)];
    let cwd = null;
    let prompt = null;
    let lastType = null;
    for (const e of entries) {
      const p = e.payload || {};
      if (p.cwd) cwd = p.cwd;
      if (e.type === 'response_item' && p.role === 'user') {
        const t = textOf(p.content).trim();
        if (t && !t.startsWith('<')) prompt = t;
      }
      if (e.type === 'event_msg') lastType = p.type;
    }
    const quietMs = now - mtime;
    const done = lastType === 'task_complete' || lastType === 'agent_message';
    const status = quietMs < 60e3 && !done ? 'working' : done && quietMs < 6 * 3600e3 ? 'done' : 'idle';
    return {
      id: `codex:${basename(file, '.jsonl')}`,
      agent: 'Codex',
      title: truncate(prompt || (cwd ? project(cwd).replace(/[-_]+/g, ' ') : 'Codex session'), 90),
      project: project(cwd),
      cwd,
      branch: null,
      status,
      detail: status === 'working' ? 'Working' : status === 'done' ? 'Finished its turn' : 'Quiet',
      last_activity: mtime,
    };
  });
}

export function agentSessions(opts = {}) {
  const out = [];
  for (const fn of [claudeSessions, codexSessions]) {
    try { out.push(...fn(opts)); } catch { /* a source we can't read is just skipped */ }
  }
  const rank = { waiting: 0, working: 1, done: 2, idle: 3 };
  return out.sort((a, b) => rank[a.status] - rank[b.status] || b.last_activity - a.last_activity);
}
