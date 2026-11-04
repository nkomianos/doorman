// End to end: a real daemon on a random port in a temp DOORMAN_HOME, driven the way agents use it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DoormanClient } from '../src/client.js';
import { startDaemon } from '../src/daemon.js';

const BIN = fileURLToPath(new URL('../bin/doorman.js', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/fake-mcp-server.js', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let d;
let c;
let env;

async function nextOpenAsk(pred = () => true, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const { asks } = await c.request('GET', '/v1/asks?status=open');
    const a = asks.find(pred);
    if (a) return a;
    await sleep(50);
  }
  throw new Error('no ask appeared');
}

before(async () => {
  const home = mkdtempSync(join(tmpdir(), 'doorman-e2e-'));
  d = await startDaemon({ home, port: 0, overrides: { desktop: false, bundleWindowMs: 150, digest: { times: [], onBreak: true } }, log: () => {}, quiet: true, tickMs: 50 });
  c = new DoormanClient({ url: d.url, token: d.token, home });
  env = { ...process.env, DOORMAN_HOME: home, DOORMAN_URL: d.url, DOORMAN_TOKEN: d.token };
});

after(async () => {
  await d.close();
});

describe('HTTP API', () => {
  test('health, auth and the DNS-rebinding guard', async () => {
    assert.equal((await (await fetch(`${d.url}/v1/health`)).json()).ok, true);
    assert.equal((await fetch(`${d.url}/v1/asks`)).status, 401);
    const status = await new Promise((resolve) => {
      const req = request(`${d.url}/v1/health`, { headers: { host: 'evil.example:80' } }, (res) => resolve(res.statusCode));
      req.end();
    });
    assert.equal(status, 421);
  });

  test('the inbox page is served with the token', async () => {
    const html = await (await fetch(`${d.url}/`)).text();
    assert.ok(html.includes(d.token));
    assert.ok(html.includes('<script src="/app.js"'));
    assert.equal((await fetch(`${d.url}/app.js`)).status, 200);
  });

  test('an agent asks, blocks, and gets the human\'s answer', async () => {
    const pending = c.ask({ agent: { id: 'deployer', name: 'Deployer' }, question: 'Deploy v2 to prod?', options: ['Deploy', 'Hold'], default: 'Hold', deadline: '5m' });
    const a = await nextOpenAsk((x) => x.agent.id === 'deployer');
    await c.request('POST', `/v1/asks/${a.id}/answer`, { option: 'deploy', surface: 'test' });
    const v = await pending;
    assert.equal(v.status, 'answered');
    assert.equal(v.answer.label, 'Deploy');
    assert.equal(v.answer.by, 'human');
  });

  test('snooze and unsnooze from the inbox', async () => {
    const r = await c.submit({ agent: { id: 'snoozer', name: 'Snoozer' }, question: 'Renew the domain?', options: ['Renew', 'Let it lapse'] });
    const s = await c.request('POST', `/v1/asks/${r.id}/snooze`, { for: '1h', surface: 'web' });
    assert.equal(s.delivery.mode, 'snoozed');
    const u = await c.request('POST', `/v1/asks/${r.id}/unsnooze`, { surface: 'web' });
    assert.notEqual(u.delivery.mode, 'snoozed');
    await c.request('POST', `/v1/asks/${r.id}/dismiss`, {});
  });

  test('the inbox can start the sample-agent demo', async () => {
    const r = await c.request('POST', '/v1/demo');
    assert.equal(r.started, true);
    assert.equal((await c.request('POST', '/v1/demo')).started, false, 'only one demo at a time');
    await nextOpenAsk((x) => x.question.startsWith('Refactor done'));
    await sleep(1200); // the demo waits out the bundle window before it finishes
    const { asks } = await c.request('GET', '/v1/asks?status=open');
    for (const a of asks.filter((x) => x.agent.id.startsWith('demo-'))) await c.request('DELETE', `/v1/asks/${a.id}`);
  });

  test('bad asks get every validation error back', async () => {
    await assert.rejects(c.submit({ options: ['x'] }), (err) => err.status === 400 && err.body.errors.length >= 2);
  });

  test('live events stream to the inbox', async () => {
    const ac = new AbortController();
    const res = await fetch(`${d.url}/v1/events?token=${d.token}`, { signal: ac.signal });
    const reader = res.body.getReader();
    let text = '';
    await c.submit({ agent: 'Streamer', question: 'Seen in the stream?' });
    const end = Date.now() + 3000;
    while (!text.includes('Seen in the stream?') && Date.now() < end) text += Buffer.from((await reader.read()).value).toString();
    ac.abort();
    assert.ok(text.includes('event: ask'));
  });

  test('human state is coarse for agents and settable', async () => {
    await c.request('POST', '/v1/state', { mode: 'focus', for: '10m' });
    const s = await c.state();
    assert.equal(s.mode, 'focus');
    assert.equal(s.interruptible_for, 'high');
    assert.deepEqual(Object.keys(s).sort(), ['interruptible_for', 'label', 'mode', 'until']);
    await c.request('POST', '/v1/state', { mode: 'auto' });
  });
});

describe('Claude Code hook', () => {
  test('PermissionRequest waits for the inbox and prints the decision', async () => {
    const child = spawn(process.execPath, [BIN, 'hook', 'claude-code'], { env });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'sess-1', cwd: '/work/api', tool_name: 'Bash', tool_input: { command: 'npm run migrate', description: 'Run migrations' } }));
    const a = await nextOpenAsk((x) => x.fingerprint === 'Bash:npm run migrate');
    assert.equal(a.agent.name, 'Claude Code · api');
    await c.request('POST', `/v1/asks/${a.id}/answer`, { option: 'allow' });
    const code = await new Promise((r) => child.on('exit', r));
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(out), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  });

  test('Stop events become FYIs', async () => {
    const child = spawn(process.execPath, [BIN, 'hook', 'claude-code'], { env });
    child.stdin.end(JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-2', cwd: '/work/web', last_assistant_message: 'Refactor complete, tests green.' }));
    assert.equal(await new Promise((r) => child.on('exit', r)), 0);
    const a = await nextOpenAsk((x) => x.kind === 'inform' && x.question.includes('Refactor complete'));
    assert.equal(a.agent.id, 'claude-code-web');
  });
});

describe('MCP', () => {
  test('ask_human and get_human_state tools', async () => {
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'], env }));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['ask_human', 'check_answer', 'get_human_state', 'notify_human']);
    const call = client.callTool({ name: 'ask_human', arguments: { question: 'Which region?', options: ['eu-west-1', 'us-east-1'], wait_seconds: 10 } });
    const a = await nextOpenAsk((x) => x.question === 'Which region?');
    assert.equal(a.agent.name, 'test-agent', 'agent identity comes from the MCP client');
    await c.request('POST', `/v1/asks/${a.id}/answer`, { option: 'us-east-1' });
    const res = JSON.parse((await call).content[0].text);
    assert.equal(res.answer.label, 'us-east-1');
    const st = JSON.parse((await client.callTool({ name: 'get_human_state', arguments: {} })).content[0].text);
    assert.ok(st.mode);
    await client.close();
  });

  test('proxy gates matching tools and routes elicitations, without touching the server', async () => {
    const client = new Client({ name: 'proxied-agent', version: '1.0.0' }); // note: no elicitation capability
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, 'proxy', '--name', 'fake', '--gate', 'delete_*', '--', process.execPath, FAKE], env }));

    const list = await client.callTool({ name: 'list_repos', arguments: {} });
    assert.equal(list.content[0].text, 'repo-a, repo-b', 'ungated tools pass straight through');

    const del = client.callTool({ name: 'delete_repo', arguments: { name: 'prod-db' } });
    const gate = await nextOpenAsk((x) => x.fingerprint === 'mcp:fake:delete_repo');
    assert.match(gate.question, /delete_repo/);
    assert.match(gate.detail.full, /prod-db/);
    await c.request('POST', `/v1/asks/${gate.id}/answer`, { option: 'deny' });
    const denied = await del;
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /blocked/);

    const conf = client.callTool({ name: 'confirm_plan', arguments: {} });
    const el = await nextOpenAsk((x) => x.question === 'Apply the migration plan to staging?');
    assert.deepEqual(el.options.map((o) => o.id), ['yes', 'no', 'decline']);
    await c.request('POST', `/v1/asks/${el.id}/answer`, { option: 'yes' });
    assert.equal((await conf).content[0].text, 'action=accept ok=true');
    await client.close();
  });
});

describe('phone push (ntfy)', () => {
  test('one-tap answers come back over the signed reply topic; forged ones are ignored', async () => {
    // Minimal ntfy: POST / publishes, GET /<topic>/json streams.
    const published = [];
    const subscribers = new Map();
    const mock = createServer((req, res) => {
      const m = /^\/([\w-]+)\/json/.exec(req.url);
      if (req.method === 'GET' && m) {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({ event: 'open' })}\n`);
        if (!subscribers.has(m[1])) subscribers.set(m[1], new Set());
        subscribers.get(m[1]).add(res);
        return;
      }
      let body = '';
      req.on('data', (b) => { body += b; });
      req.on('end', () => {
        if (req.url === '/') published.push(JSON.parse(body));
        else {
          const topic = req.url.slice(1);
          for (const s of subscribers.get(topic) || []) s.write(`${JSON.stringify({ id: String(Math.random()), event: 'message', topic, message: body })}\n`);
        }
        res.end('{}');
      });
    });
    await new Promise((r) => mock.listen(0, '127.0.0.1', r));
    const server = `http://127.0.0.1:${mock.address().port}`;
    try {
      await c.request('PATCH', '/v1/config', { ntfy: { server, topic: 'me-secret', mirror: 'always' } });
      for (let i = 0; i < 40 && !subscribers.get('me-secret-reply')?.size; i++) await sleep(50);
      assert.ok(subscribers.get('me-secret-reply')?.size, 'daemon subscribed to the reply topic');

      const created = await c.submit({ agent: { id: 'travel', name: 'Travel' }, question: 'Book the €212 flight?', options: ['Book', 'Skip'], urgency: 'high' });
      for (let i = 0; i < 40 && !published.length; i++) await sleep(50);
      const msg = published.find((p) => p.message.includes('€212'));
      assert.ok(msg, 'pushed to phone');
      assert.equal(msg.topic, 'me-secret');
      assert.deepEqual(msg.actions.map((a) => a.label), ['Book', 'Skip']);

      const forged = JSON.parse(msg.actions[0].body);
      forged.sig = 'f'.repeat(24);
      await fetch(`${server}/me-secret-reply`, { method: 'POST', body: JSON.stringify(forged) });
      await sleep(200);
      assert.equal((await c.request('GET', `/v1/asks/${created.id}`)).status, 'pending', 'bad signature ignored');

      const tap = msg.actions[0];
      await fetch(tap.url, { method: tap.method, body: tap.body });
      const v = await c.wait(created.id, { timeoutMs: 3000 });
      assert.equal(v.status, 'answered');
      assert.equal(v.answer.label, 'Book');
      assert.equal((await c.request('GET', `/v1/asks/${created.id}`)).ask.answer.surface, 'phone');
    } finally {
      await c.request('PATCH', '/v1/config', { ntfy: null });
      for (const set of subscribers.values()) for (const s of set) s.end();
      mock.closeAllConnections();
      mock.close();
    }
  });
});

describe('persistence', () => {
  test('the ledger verifies after all of the above', async () => {
    const v = await c.request('GET', '/v1/ledger/verify');
    assert.equal(v.ok, true);
    assert.ok(v.count > 20);
  });
});
