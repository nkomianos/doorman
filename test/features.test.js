// Setup integrations, session discovery, pattern learning, agent keys, Telegram and activity.
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { categorize } from '../src/activity.js';
import { SwitchboardClient } from '../src/client.js';
import { startDaemon } from '../src/daemon.js';
import { listIntegrations, setIntegration } from '../src/integrations.js';
import { Router } from '../src/router.js';
import { agentSessions } from '../src/sessions.js';
import { HumanState } from '../src/state.js';
import { Telegram } from '../src/telegram.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (name) => mkdtempSync(join(tmpdir(), `switchboard-${name}-`));

describe('one-click integrations', () => {
  test('connect and disconnect Claude Code without touching other settings', () => {
    const home = tmp('int');
    mkdirSync(join(home, '.claude'));
    const file = join(home, '.claude', 'settings.json');
    writeFileSync(file, JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
    assert.equal(listIntegrations({ home }).find((i) => i.id === 'claude-code').connected, false);
    setIntegration('claude-code', true, { home });
    const on = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(on.theme, 'dark');
    assert.equal(on.hooks.Stop.length, 2, 'your own Stop hook is kept');
    assert.ok(on.hooks.PermissionRequest[0].hooks[0].command.includes('hook claude-code'));
    assert.ok(existsSync(`${file}.switchboard-bak`));
    setIntegration('claude-code', true, { home }); // idempotent
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).hooks.Stop.length, 2);
    setIntegration('claude-code', false, { home });
    const off = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(off.hooks, { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] });
  });

  test('Codex: notify goes above the first table; an existing notify is left alone', () => {
    const home = tmp('codex');
    mkdirSync(join(home, '.codex'));
    const file = join(home, '.codex', 'config.toml');
    writeFileSync(file, 'model = "gpt"\n\n[profiles.fast]\nmodel = "mini"\n');
    setIntegration('codex', true, { home });
    const text = readFileSync(file, 'utf8');
    assert.ok(text.indexOf('notify =') < text.indexOf('[profiles.fast]'));
    assert.ok(text.includes('[mcp_servers.switchboard]'));
    assert.equal(listIntegrations({ home }).find((i) => i.id === 'codex').connected, true);
    setIntegration('codex', false, { home });
    assert.ok(!readFileSync(file, 'utf8').includes('switchboard'));

    // Like Codex's own computer-use plugin: an existing notify program gets chained, then restored.
    const original = 'notify = [ "C:\\\\Tools\\\\codex-computer-use.exe", "turn-ended" ]';
    writeFileSync(file, `model = "gpt"\n${original}\n\n[features]\nx = true\n`);
    const r = setIntegration('codex', true, { home });
    assert.match(r.message, /keeps working/);
    const chained = /^notify = (.*)$/m.exec(readFileSync(file, 'utf8'))[1];
    const list = JSON.parse(chained);
    assert.deepEqual(list.slice(2, 5), ['hook', 'codex', '--']);
    assert.deepEqual(list.slice(5), ['C:\\Tools\\codex-computer-use.exe', 'turn-ended']);
    setIntegration('codex', true, { home }); // connecting twice doesn't chain twice
    assert.equal(JSON.parse(/^notify = (.*)$/m.exec(readFileSync(file, 'utf8'))[1]).filter((x) => x === '--').length, 1);
    setIntegration('codex', false, { home });
    assert.deepEqual(JSON.parse(/^notify = (.*)$/m.exec(readFileSync(file, 'utf8'))[1]), ['C:\\Tools\\codex-computer-use.exe', 'turn-ended']);
  });

  test('OpenClaw and Muse Code: servers go where each one reads them', () => {
    const home = tmp('claws');
    mkdirSync(join(home, '.openclaw'));
    writeFileSync(join(home, '.openclaw', 'openclaw.json'), JSON.stringify({ agents: { default: 'main' }, mcp: { servers: { files: { command: 'npx' } } } }));
    setIntegration('openclaw', true, { home });
    const oc = JSON.parse(readFileSync(join(home, '.openclaw', 'openclaw.json'), 'utf8'));
    assert.equal(oc.agents.default, 'main');
    assert.ok(oc.mcp.servers.files && oc.mcp.servers.switchboard.args.includes('mcp'));
    setIntegration('openclaw', false, { home });
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(home, '.openclaw', 'openclaw.json'), 'utf8')).mcp.servers), ['files']);

    mkdirSync(join(home, '.config', 'muse'), { recursive: true });
    setIntegration('muse-code', true, { home });
    const muse = JSON.parse(readFileSync(join(home, '.config', 'muse', 'settings.json'), 'utf8'));
    assert.equal(muse.schema_version, 1);
    assert.equal(muse.mcp_servers.switchboard.mode, 'optional');
  });

  test('Hermes: adds and removes only its own YAML block, matching your indentation', () => {
    const home = tmp('hermes');
    mkdirSync(join(home, '.hermes'));
    const file = join(home, '.hermes', 'config.yaml');
    const original = 'model: hermes-4\nmcp_servers:\n    github:\n        command: "npx"\n        args: ["-y", "@modelcontextprotocol/server-github"]\nmemory:\n    enabled: true\n';
    writeFileSync(file, original);
    setIntegration('hermes', true, { home });
    const text = readFileSync(file, 'utf8');
    assert.match(text, /mcp_servers:\n {4}switchboard:\n {8}command: "node"/);
    assert.ok(text.includes('    github:') && text.includes('memory:'));
    assert.equal(listIntegrations({ home }).find((i) => i.id === 'hermes').connected, true);
    setIntegration('hermes', false, { home });
    assert.equal(readFileSync(file, 'utf8'), original);

    writeFileSync(file, 'model: hermes-4\n');
    setIntegration('hermes', true, { home });
    assert.match(readFileSync(file, 'utf8'), /^model: hermes-4\n\nmcp_servers:\n {2}switchboard:/);
  });

  test('a broken JSON config is refused, not overwritten', () => {
    const home = tmp('cursor');
    mkdirSync(join(home, '.cursor'));
    writeFileSync(join(home, '.cursor', 'mcp.json'), '{ not json');
    assert.throws(() => setIntegration('cursor', true, { home }), /isn't valid JSON/);
    assert.equal(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'), '{ not json');
  });
});

describe('agent sessions', () => {
  test('reads titles, projects and status from Claude Code logs', () => {
    const home = tmp('sess');
    const dir = join(home, '.claude', 'projects', 'C--code-api');
    mkdirSync(dir, { recursive: true });
    const lines = [
      { type: 'user', cwd: '/code/api', gitBranch: 'feat/x', message: { role: 'user', content: 'Fix the flaky login test' } },
      { type: 'assistant', cwd: '/code/api', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] } },
      { type: 'custom-title', customTitle: 'Flaky login test' },
    ];
    writeFileSync(join(dir, 's1.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const [s] = agentSessions({ home });
    assert.equal(s.title, 'Flaky login test');
    assert.equal(s.project, 'api');
    assert.equal(s.branch, 'feat/x');
    assert.equal(s.status, 'working');
    const later = agentSessions({ home, now: Date.now() + 120e3 })[0];
    assert.equal(later.status, 'waiting', 'a tool call with no result for a while is probably a permission prompt');
  });
});

describe('smarter learning', () => {
  const decision = (fp, over = {}) => ({ agent: { id: 'coder', name: 'Coder' }, question: `Run ${fp}?`, options: ['Allow', 'Deny'], fingerprint: fp, ...over });

  test('the same answer to similar requests suggests one rule for the pattern', () => {
    const r = new Router({ config: { bundleWindowMs: 0, digest: { times: [] } } });
    for (const fp of ['Bash:git status', 'Bash:git diff', 'Bash:git log -5']) r.answer(r.submit(decision(fp)).id, { option: 'allow' });
    const [s] = r.suggestions.values();
    assert.equal(s.fingerprint, 'Bash:git *');
    assert.equal(s.glob, true);
    r.acceptSuggestion(s.id);
    assert.equal(r.submit(decision('Bash:git branch -a')).status, 'auto');
  });

  test('mixed answers or irreversible actions never generalise', () => {
    const r = new Router({ config: { bundleWindowMs: 0, digest: { times: [] } } });
    r.answer(r.submit(decision('Bash:rm a')).id, { option: 'allow' });
    r.answer(r.submit(decision('Bash:rm b')).id, { option: 'deny' });
    r.answer(r.submit(decision('Bash:rm c')).id, { option: 'allow' });
    r.answer(r.submit(decision('Bash:rm d')).id, { option: 'allow' });
    assert.equal(r.suggestions.size, 0);
    const r2 = new Router({ config: { bundleWindowMs: 0, digest: { times: [] } } });
    for (const fp of ['Bash:push a', 'Bash:push b', 'Bash:push c']) r2.answer(r2.submit(decision(fp, { reversible: false })).id, { option: 'allow' });
    assert.equal(r2.suggestions.size, 0);
  });

  test('updates you keep marking not useful: suggest the digest', () => {
    const r = new Router({ config: { bundleWindowMs: 0, digest: { times: [] } } });
    for (let i = 0; i < 3; i++) r.dismiss(r.submit({ agent: { id: 'mailer', name: 'Mailer' }, question: `Archived ${i} newsletters` }).id);
    const [s] = r.suggestions.values();
    assert.equal(s.kind, 'route');
    r.acceptSuggestion(s.id);
    assert.equal(r.submit({ agent: { id: 'mailer', name: 'Mailer' }, question: 'Archived 9 more', urgency: 'high' }).delivery.mode, 'digest');
  });
});

describe('activity sensing', () => {
  test('front app categories', () => {
    assert.equal(categorize('Zoom.exe'), 'meeting');
    assert.equal(categorize('ms-teams'), 'meeting');
    assert.equal(categorize('Code'), 'editor');
    assert.equal(categorize('WindowsTerminal'), 'editor');
    assert.equal(categorize('chrome'), 'other');
    assert.equal(categorize(null), 'unknown');
  });

  test('idle means away, a call means focus, and only when you opted in', () => {
    const cfg = { activity: { enabled: true, awayAfterMinutes: 10, meetings: true } };
    const s = new HumanState(cfg);
    s.activity = { idle_ms: 11 * 60000, app: 'Chrome', category: 'other', at: Date.now() };
    assert.equal(s.current().mode, 'away');
    s.activity = { idle_ms: 1000, app: 'Zoom', category: 'meeting', at: Date.now() };
    assert.equal(s.current().mode, 'focus');
    assert.equal(s.coarse().mode, 'focus');
    assert.equal(s.coarse().activity, undefined, 'agents never see which app');
    cfg.activity.enabled = false;
    assert.equal(s.current().mode, 'available');
  });
});

describe('agent keys (live daemon)', () => {
  let d;
  let owner;
  before(async () => {
    d = await startDaemon({ home: tmp('feat'), port: 0, overrides: { desktop: false, noProtocol: true, bundleWindowMs: 100, digest: { times: [], onBreak: true } }, log: () => {}, quiet: true, tickMs: 50 });
    owner = new SwitchboardClient({ url: d.url, token: d.token });
  });
  after(() => d.close());

  test('an agent key can ask and wait, but not answer, read the inbox, or pose as another agent', async () => {
    const k = await owner.request('POST', '/v1/keys', { name: 'Nightly backup' });
    assert.match(k.key, /^sbk_/);
    const agent = new SwitchboardClient({ url: d.url, token: k.key });
    const r = await agent.submit({ agent: { id: 'claude-code-prod', name: 'Totally Claude' }, question: 'Upload 12 GB?', options: ['Upload', 'Skip'] });
    const full = (await owner.request('GET', `/v1/asks/${r.id}`)).ask;
    assert.equal(full.agent.id, k.agent_id, 'attributed to the key, not the claimed id');
    await assert.rejects(agent.request('POST', `/v1/asks/${r.id}/answer`, { option: 'upload' }), (e) => e.status === 403);
    await assert.rejects(agent.request('GET', '/v1/asks?status=open'), (e) => e.status === 403);
    const other = await owner.submit({ agent: 'someone', question: 'Private?', options: ['Yes', 'No'] });
    await assert.rejects(agent.request('GET', `/v1/asks/${other.id}`), (e) => e.status === 404);
    assert.equal((await agent.request('GET', '/v1/state')).mode, 'available');
    await owner.request('DELETE', `/v1/keys/${k.id}`);
    await assert.rejects(agent.request('GET', '/v1/state'), (e) => e.status === 401);
  });

  test('MCP over HTTP: an agent key gets the tools, and its asks are attributed to it', async () => {
    const k = await owner.request('POST', '/v1/keys', { name: 'Grok' });
    const mcp = new Client({ name: 'grok-test', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${d.url}/mcp?key=${k.key}`)));
    try {
      const { tools } = await mcp.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), ['ask_human', 'check_answer', 'get_human_state', 'notify_human', 'request_review']);
      const r = await mcp.callTool({ name: 'ask_human', arguments: { question: 'Post the thread on X?', options: ['Post', 'Hold'], default: 'Hold', deadline: '1h', wait_seconds: 0 } });
      const view = JSON.parse(r.content[0].text);
      assert.equal(view.status, 'pending');
      assert.equal((await owner.request('GET', `/v1/asks/${view.id}`)).ask.agent.id, k.agent_id);
    } finally {
      await mcp.close();
    }
    await assert.rejects(fetch(`${d.url}/mcp`, { method: 'POST' }).then((res) => { if (!res.ok) throw Object.assign(new Error('x'), { status: res.status }); }), (e) => e.status === 401);
  });

  test('through a tunnel: off by default, then agent keys only, never the inbox or owner token', async () => {
    const k = await owner.request('POST', '/v1/keys', { name: 'Cloud agent' });
    const viaTunnel = (path, auth) => new Promise((resolve) => {
      const req = httpRequest(`${d.url}${path}`, { headers: { host: 'abc-def.trycloudflare.com', ...(auth ? { authorization: `Bearer ${auth}` } : {}) } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.end();
    });
    assert.equal(await viaTunnel('/v1/state', k.key), 421, 'remote access is off by default');
    await owner.request('PATCH', '/v1/config', { remote: { enabled: true, url: 'https://abc-def.trycloudflare.com' } });
    assert.equal(await viaTunnel('/v1/state', k.key), 200);
    assert.equal(await viaTunnel('/v1/state', d.token), 403, 'the owner token never works from outside');
    assert.equal(await viaTunnel('/', null), 421, 'the inbox never answers outside');
    assert.equal(await viaTunnel('/v1/asks', k.key), 403, 'keys still only reach agent routes');
    await owner.request('PATCH', '/v1/config', { remote: { enabled: false, url: null } });
  });

  test('notification buttons need a valid signature', async () => {
    const a = await owner.submit({ agent: 'deployer', question: 'Ship it?', options: ['Ship', 'Wait'] });
    await assert.rejects(owner.request('POST', '/v1/actions/answer', { ask: a.id, option: 'ship', sig: 'f'.repeat(24) }), (e) => e.status === 403);
    assert.equal((await owner.request('GET', `/v1/asks/${a.id}`)).status, 'pending');
  });

});

describe('Telegram bot', () => {
  test('pairing, buttons, answers and strangers', async () => {
    const sent = [];
    const edits = [];
    const updates = [];
    const api = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        const method = req.url.split('/').pop();
        const b = body ? JSON.parse(body) : {};
        const ok = (result) => res.end(JSON.stringify({ ok: true, result }));
        if (method === 'getMe') return ok({ id: 1, username: 'switchboard_test_bot' });
        if (method === 'getUpdates') {
          for (let i = 0; i < 20 && !updates.length; i++) await sleep(25);
          return ok(updates.splice(0));
        }
        if (method === 'sendMessage') { sent.push(b); return ok({ message_id: sent.length }); }
        if (method === 'editMessageText') edits.push(b);
        return ok(true);
      });
    });
    await new Promise((r) => api.listen(0, '127.0.0.1', r));
    const answers = [];
    let paired = null;
    const tg = new Telegram({ token: 'x', apiBase: `http://127.0.0.1:${api.address().port}` }, {
      pairCode: () => '424242',
      onPaired: (p) => { paired = p; },
      onAnswer: (askId, idx) => { answers.push([askId, idx]); return { toast: 'Sent' }; },
      onCommand: async () => 'pong',
    });
    try {
      await tg.start();
      assert.equal(tg.me.username, 'switchboard_test_bot');
      updates.push({ update_id: 1, message: { chat: { id: 99, type: 'private' }, from: { id: 7 }, text: '/start 000000' } });
      await sleep(150);
      assert.equal(paired, null, 'wrong code');
      updates.push({ update_id: 2, message: { chat: { id: 99, type: 'private' }, from: { id: 7, username: 'me' }, text: '/start 424242' } });
      await sleep(150);
      assert.equal(paired.chatId, 99);

      await tg.sendAsk({ id: 'ask_1', agent: { name: 'Travel' }, urgency: 'high', kind: 'decision', question: 'Book it?', options: [{ id: 'book', label: 'Book' }, { id: 'skip', label: 'Skip' }], detail: {} });
      const msg = sent.at(-1);
      assert.deepEqual(msg.reply_markup.inline_keyboard[0].map((b) => b.text), ['Book', 'Skip']);
      updates.push({ update_id: 3, callback_query: { id: 'q1', from: { id: 8 }, message: { chat: { id: 1234 } }, data: 'a|ask_1|0' } });
      updates.push({ update_id: 4, callback_query: { id: 'q2', from: { id: 7 }, message: { chat: { id: 99 } }, data: 'a|ask_1|0' } });
      await sleep(200);
      assert.deepEqual(answers, [['ask_1', 0]], 'only the paired chat can answer');
      await tg.resolved({ id: 'ask_1', agent: { name: 'Travel' }, kind: 'decision', question: 'Book it?', options: [], detail: {} }, '✅ “Book”');
      assert.equal(edits.length, 1);
    } finally {
      tg.close();
      api.close();
      api.closeAllConnections?.();
    }
  });
});

describe('reviews, notes and replies', () => {
  test('a review is a decision with Approve / Request changes and attachments', async () => {
    const { normalizeAsk } = await import('../src/spec.js');
    const a = normalizeAsk({ agent: 'writer', kind: 'review', question: 'Review the launch post?', attachments: ['docs/post.md', 'https://github.com/x/y/pull/1', { content: '+ added\n- removed', format: 'diff', title: 'Changes' }] });
    assert.equal(a.kind, 'decision');
    assert.equal(a.review, true);
    assert.deepEqual(a.options.map((o) => o.id), ['approve', 'changes']);
    assert.deepEqual(a.attachments.map((x) => x.format), ['markdown', null, 'diff']);
    assert.equal(a.attachments[0].title, 'post.md');
    assert.throws(() => normalizeAsk({ agent: 'w', kind: 'review', question: 'x?', attachments: [{ title: 'nothing' }] }), /needs a path, url or content/);
  });

  test('reviews are never offered as automatic rules', () => {
    const r = new Router({ config: { bundleWindowMs: 0, digest: { times: [] } } });
    for (let i = 0; i < 4; i++) r.answer(r.submit({ agent: 'writer', kind: 'review', question: 'Review the post?', attachments: [{ content: 'hi' }] }).id, { option: 'approve' });
    assert.equal(r.suggestions.size, 0);
  });

  test('a note travels with the answer, and a Claude Code denial passes it on', async () => {
    const { answerView } = await import('../src/spec.js');
    const { permissionOutput } = await import('../src/hooks.js');
    const r = new Router({ config: { bundleWindowMs: 0, digest: { times: [] } } });
    const a = r.submit({ agent: 'coder', question: 'Run migrations on prod?', options: ['Allow', 'Deny'] });
    r.answer(a.id, { option: 'deny', text: 'Use staging first' });
    const v = answerView(a);
    assert.equal(v.answer.text, 'Use staging first');
    assert.match(permissionOutput(v).hookSpecificOutput.decision.message, /Use staging first/);
  });

  test('resuming a session: message on stdin, a clear error when the CLI is missing', async () => {
    const { EventEmitter } = await import('node:events');
    const { resumeSession, manualCommand } = await import('../src/resume.js');
    const fake = (behaviour) => (cmd, args) => {
      const child = new EventEmitter();
      child.stdin = { written: '', on() {}, end(t) { this.written = t; } };
      child.stderr = new EventEmitter();
      child.args = [cmd, ...args];
      setTimeout(() => {
        child.emit('spawn');
        if (behaviour === 'missing') { child.stderr.emit('data', "'codex' is not recognized as an internal or external command"); child.emit('exit', 1); }
      }, 5);
      fake.last = child;
      return child;
    };
    const ok = await resumeSession({ via: 'codex', session: 'abc-123', cwd: null }, 'Yes, open the PR', { spawnImpl: fake('ok'), settleMs: 30 });
    assert.equal(ok.ok, true);
    assert.deepEqual(fake.last.args.join(' ').split(' '), ['codex','exec', 'resume', '--skip-git-repo-check', 'abc-123', '-']);
    assert.equal(fake.last.stdin.written, 'Yes, open the PR');
    const bad = await resumeSession({ via: 'codex', session: 'abc-123' }, 'hi', { spawnImpl: fake('missing'), settleMs: 200 });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /Codex CLI not found/);
    assert.match(manualCommand({ via: 'claude-code', session: 's1', cwd: '/code/api' }, 'go'), /^cd "\/code\/api" && claude -p --resume s1 "go"$/);
    assert.equal((await resumeSession({ via: 'codex', session: 'x; rm -rf /' }, 'hi')).ok, false, 'odd session ids are refused');
  });
});

describe('reviews and replies (live daemon)', () => {
  let d;
  let owner;
  before(async () => {
    d = await startDaemon({ home: tmp('review'), port: 0, overrides: { desktop: false, noProtocol: true, bundleWindowMs: 100, digest: { times: [], onBreak: true } }, log: () => {}, quiet: true, tickMs: 50 });
    owner = new SwitchboardClient({ url: d.url, token: d.token });
  });
  after(() => d.close());

  test('attachments preview for the owner; agent keys cannot attach local files', async () => {
    const file = join(tmp('doc'), 'plan.md');
    writeFileSync(file, '# Plan\n\n- step one\n');
    const a = await owner.submit({ agent: 'planner', kind: 'review', question: 'Review the plan?', attachments: [{ path: file }, { content: 'inline **doc**' }] });
    const p0 = await owner.request('GET', `/v1/asks/${a.id}/attachments/0`);
    assert.equal(p0.content, '# Plan\n\n- step one\n');
    assert.equal(p0.format, 'markdown');
    assert.equal((await owner.request('GET', `/v1/asks/${a.id}/attachments/1`)).content, 'inline **doc**');
    const k = await owner.request('POST', '/v1/keys', { name: 'Cloud writer' });
    const agent = new SwitchboardClient({ url: d.url, token: k.key });
    await assert.rejects(agent.submit({ kind: 'review', question: 'Read this?', attachments: [{ path: 'C:/Users/me/.ssh/id_rsa' }] }), (e) => e.status === 400);
    assert.equal((await agent.submit({ kind: 'review', question: 'Read this?', attachments: [{ content: 'fine' }] })).status, 'pending');
  });

  test('replying to an agent message tries to resume that session and records the outcome', async () => {
    const a = await owner.submit({ agent: { id: 'claude-code-api', name: 'Claude Code · api' }, kind: 'inform', question: 'Finished in api: done', metadata: { reply: { via: 'claude-code', session: 'no-such-session', cwd: null } } });
    const r = await owner.request('POST', `/v1/asks/${a.id}/reply`, { text: 'Thanks, now add tests' });
    assert.ok(['sent', 'failed'].includes(r.state));
    if (r.state === 'failed') assert.ok(r.command.includes('--resume no-such-session'));
    const after = (await owner.request('GET', `/v1/asks/${a.id}`)).ask;
    assert.equal(after.status, 'read');
    assert.equal(after.reply_result.state, r.state);
    await assert.rejects(owner.request('POST', `/v1/asks/${a.id}/reply`, { text: '' }), (e) => e.status === 400);
  });
});
