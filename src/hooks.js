// Intake from coding agents that don't speak Switchboard: Claude Code hooks and Codex notify.
import { basename } from 'node:path';
import { slug, truncate } from './util.js';

const RISKY = /\b(rm|rmdir|del|drop|truncate|shred|mkfs|dd|push|deploy|publish|release|chmod|chown|kill)\b|reset\s+--hard|--force|curl[^|]*\|\s*(ba)?sh/i;

/** Does an agent's final message end by asking you something? */
export function endsWithQuestion(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/\?[\s*_`)"'’”]*$/.test(t)) return true;
  const last = t.split(/\n\s*\n/).pop().slice(-500);
  return /\?/.test(last) || /\b(should I|shall I|do you want|would you like|want me to|which (one|option|approach)|please (confirm|choose|decide)|your call)\b/i.test(last);
}

/** The question itself, for the one-line title. */
export function lastQuestion(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const line = lines.findLast((l) => l.includes('?')) || lines.at(-1) || '';
  const asked = line.match(/[^.!?]*\?/g);
  const q = asked?.at(-1)?.trim() || line.split(/(?<=[.!?])\s+/).at(-1) || line;
  return q.replace(/^[*_`#>\-\d.)\s]+/, '').replace(/[*_`]+$/, '');
}

/**
 * A finished turn becomes something you can reply to: a question (pings you, like a
 * decision) if the agent ended by asking something, otherwise an update. Either way
 * metadata.reply says how to resume that exact session with your answer.
 */
function finishedTurn({ agent, project, message, via, session, cwd, name }) {
  const msg = String(message || 'turn complete');
  const reply = session ? { via, session, cwd: cwd || null } : null;
  const base = {
    agent,
    detail: { full: message || null },
    thread: session ? `${via}:${session}` : null,
    // A newer turn from the same session replaces the older question or update.
    collapse_key: session ? `${via}-turn:${session}` : null,
    metadata: reply ? { reply } : null,
  };
  if (reply && endsWithQuestion(msg)) {
    return {
      ...base,
      kind: 'input',
      question: truncate(`${project}: ${lastQuestion(msg)}`, 300),
      input: { type: 'text', placeholder: `Reply to ${name}…` },
      urgency: 'normal',
      tags: [via, 'question'],
    };
  }
  return { ...base, kind: 'inform', question: `Finished in ${project}: ${truncate(msg.replace(/\s+/g, ' '), 160)}`, urgency: 'normal', tags: [via, 'done'] };
}

function claudeAgent(p) {
  const project = p.cwd ? basename(p.cwd) : 'session';
  return { id: `claude-code-${slug(project)}`, name: `Claude Code · ${project}`, instance: p.session_id || null };
}

/** Turn a PermissionRequest payload into an ask. */
export function permissionAsk(p) {
  const tool = p.tool_name || 'tool';
  const input = p.tool_input || {};
  let question;
  let fingerprint;
  let reversible = null;
  if (tool === 'Bash') {
    question = `Run \`${truncate(input.command || '', 140)}\`?`;
    fingerprint = `Bash:${input.command || ''}`;
    reversible = RISKY.test(input.command || '') ? false : null;
  } else if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const file = input.file_path || input.notebook_path || '';
    const rel = p.cwd && file.startsWith(p.cwd) ? file.slice(p.cwd.length).replace(/^[\\/]/, '') : file;
    question = `${tool === 'Write' ? 'Write' : 'Edit'} ${truncate(rel, 140)}?`;
    fingerprint = `${tool}:${file}`;
    reversible = true;
  } else if (tool === 'WebFetch') {
    let host = input.url || '';
    try { host = new URL(input.url).hostname; } catch { /* keep raw */ }
    question = `Fetch ${truncate(input.url || host, 140)}?`;
    fingerprint = `WebFetch:${host}`;
  } else if (tool.startsWith('mcp__')) {
    const [, server, ...rest] = tool.split('__');
    question = `Use ${rest.join('__')} on ${server}?`;
    fingerprint = tool;
  } else {
    question = `Use ${tool}?`;
    fingerprint = tool;
  }
  return {
    agent: claudeAgent(p),
    kind: 'decision',
    question,
    options: [{ id: 'allow', label: 'Allow', style: 'primary' }, { id: 'deny', label: 'Deny', style: 'danger' }],
    urgency: 'normal',
    reversible,
    detail: { line: input.description ? truncate(input.description, 200) : null, full: JSON.stringify(input, null, 2) },
    fingerprint,
    thread: p.session_id ? `claude:${p.session_id}` : null,
    tags: ['claude-code', 'permission'],
  };
}

export function permissionOutput(view) {
  if (!view.final || view.status === 'cancelled' || view.status === 'expired') return null;
  const opt = view.answer?.option;
  if (opt === 'allow') return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
  const message = view.status === 'dismissed'
    ? 'The human dismissed this request via Switchboard. Do not retry it; continue another way or ask with more context.'
    : view.answer?.by?.startsWith('rule:')
      ? 'Denied by one of the human\'s Switchboard rules.'
      : view.answer?.text
        ? `The human denied this via Switchboard, and said: "${view.answer.text}". Do what they asked instead.`
        : 'The human denied this via Switchboard.';
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } } };
}

/** Notification / Stop payloads become FYIs. Returns null when there's nothing worth sending. */
export function claudeInform(p) {
  const agent = claudeAgent(p);
  const project = p.cwd ? basename(p.cwd) : 'session';
  if (p.hook_event_name === 'Stop') {
    if (p.stop_hook_active) return null;
    return finishedTurn({ agent, project, message: p.last_assistant_message, via: 'claude-code', session: p.session_id, cwd: p.cwd, name: 'Claude' });
  }
  if (p.hook_event_name === 'Notification') {
    // Permission prompts arrive through PermissionRequest; idle prompts duplicate Stop.
    if (['permission_prompt', 'idle_prompt', 'auth_success'].includes(p.notification_type)) return null;
    return {
      agent,
      kind: 'inform',
      question: truncate(`${project}: ${p.message || p.title || 'Claude Code needs you'}`, 300),
      urgency: 'normal',
      thread: p.session_id ? `claude:${p.session_id}` : null,
      collapse_key: p.session_id ? `claude-note:${p.session_id}` : null,
      tags: ['claude-code', p.notification_type || 'notification'],
    };
  }
  return null;
}

/** Runs one Claude Code hook invocation. Returns the object to print on stdout, or null. */
export async function runClaudeHook(payload, { client, waitSeconds = 600, signal, onCreated } = {}) {
  if (payload.hook_event_name === 'PermissionRequest') {
    const created = await client.submit(permissionAsk(payload));
    if (created.final) return permissionOutput(created);
    onCreated?.(created.id);
    const view = await client.wait(created.id, { timeoutMs: waitSeconds * 1000, signal });
    if (!view.final) {
      await client.cancel(created.id, 'nobody answered in Switchboard; fell back to the terminal prompt').catch(() => {});
      return null;
    }
    return permissionOutput(view);
  }
  const inform = claudeInform(payload);
  if (inform) await client.submit(inform);
  return null;
}

/** Codex `notify` program: receives one JSON argument per completed turn. */
export function codexInform(p) {
  if (p?.type !== 'agent-turn-complete') return null;
  const project = p.cwd ? basename(p.cwd) : 'codex';
  const session = p['thread-id'] || null;
  return finishedTurn({
    agent: { id: `codex-${slug(project)}`, name: `Codex · ${project}`, instance: session },
    project,
    message: p['last-assistant-message'],
    via: 'codex',
    session,
    cwd: p.cwd,
    name: 'Codex',
  });
}
