// Replying to an agent's chat question from Switchboard: resume that exact session
// with your message, using the agent's own CLI. The agent's next turn comes back
// through its hooks like any other, so you see the result in your inbox.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export const RESUMERS = {
  // The session already ran in that folder, so don't make Codex re-ask whether it trusts it.
  codex: { name: 'Codex', cmd: 'codex', args: (session) => ['exec', 'resume', '--skip-git-repo-check', session, '-'], install: 'npm install -g @openai/codex' },
  'claude-code': { name: 'Claude Code', cmd: 'claude', args: (session) => ['-p', '--resume', session], install: 'npm install -g @anthropic-ai/claude-code' },
};

const SAFE_ID = /^[\w.:-]{1,200}$/;
const shq = (s) => `"${String(s).replace(/"/g, '\\"')}"`;

/** What to run by hand if Switchboard can't, for the copy button. */
export function manualCommand(reply, text) {
  const r = RESUMERS[reply?.via];
  if (!r) return null;
  const cd = reply.cwd ? `cd ${shq(reply.cwd)} && ` : '';
  return `${cd}${r.cmd} ${r.args(reply.session).filter((a) => a !== '-').join(' ')} ${shq(text)}`;
}

/**
 * Starts the agent with your message and resolves once it's clearly running
 * ({ok: true}) or clearly failed ({ok: false, error, command}). It doesn't wait for
 * the agent's whole turn.
 */
export function resumeSession(reply, text, { spawnImpl = spawn, settleMs = 2500, log = () => {}, onLateFailure = () => {} } = {}) {
  return new Promise((resolve) => {
    const r = RESUMERS[reply?.via];
    if (!r) return resolve({ ok: false, error: 'this message can’t be replied to from Switchboard' });
    if (!SAFE_ID.test(String(reply.session || ''))) return resolve({ ok: false, error: 'missing or odd session id' });
    const command = manualCommand(reply, text);
    const cwd = reply.cwd && existsSync(reply.cwd) ? reply.cwd : undefined;
    let child;
    let settled = false;
    let stderr = '';
    const done = (result) => { if (!settled) { settled = true; resolve({ name: r.name, command, ...result }); } };
    try {
      // On Windows the CLIs are .cmd shims, so they need a shell. Arguments are fixed and
      // the session id is validated above; your message only travels over stdin.
      // (Passing one command string rather than an args array keeps Node from warning.)
      const win = process.platform === 'win32';
      const args = r.args(reply.session);
      child = win
        ? spawnImpl([r.cmd, ...args].join(' '), [], { cwd, shell: true, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
        : spawnImpl(r.cmd, args, { cwd, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (err) {
      return done({ ok: false, error: err.message });
    }
    child.stderr?.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('error', (err) => done({ ok: false, error: err.code === 'ENOENT' ? `${r.name} CLI not found. Install it with: ${r.install}` : err.message }));
    child.on('exit', (code) => {
      if (code) {
        const why = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
        const missing = /not recognized|not found|No such file/i.test(why);
        const failure = { ok: false, error: missing ? `${r.name} CLI not found. Install it with: ${r.install}` : `${r.name} stopped: ${why || `exit code ${code}`}` };
        // Failing after we already said "sent" (network, login…) still gets reported.
        if (settled) onLateFailure({ name: r.name, command, ...failure });
        done(failure);
        log(`${r.name} reply failed (${code}): ${why}`);
      }
    });
    child.on('spawn', () => {
      child.stdin.on('error', () => {});
      child.stdin.end(text);
      // A missing CLI on Windows shows up as the shell exiting non-zero right away.
      setTimeout(() => done({ ok: true }), settleMs);
    });
  });
}
