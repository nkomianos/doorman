// HTTP API + live event stream + the inbox UI. Binds to loopback only.
import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { answerView } from './spec.js';
import { parseDuration, parseWhen } from './util.js';

const UI_DIR = new URL('../ui/', import.meta.url);
const STATIC = {
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const MAX_BODY = 1 << 20;
const MAX_WAIT_MS = 60000;

const httpError = (status, message) => Object.assign(new Error(message), { status });

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw httpError(413, 'body too large');
    chunks.push(c);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'body is not valid JSON');
  }
}

function hostOk(req) {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  return LOCAL_HOSTS.has(host);
}

/** The presented credential: a bearer header, or ?key= for connectors that can only take a URL. */
function given(req, url) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('key') || url.searchParams.get('token') || '';
}

/** Who is calling: the owner (inbox, CLI), an agent holding an agent key, or nobody. */
function whoIs(req, url, token, keys) {
  const presented = given(req, url);
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  if (a.length === b.length && timingSafeEqual(a, b)) return { role: 'owner' };
  const key = keys?.check(presented);
  return key ? { role: 'agent', key } : null;
}

// What an agent key may do: ask, wait for and withdraw its own asks, read coarse state.
const AGENT_ROUTES = [
  ['GET', /^\/v1\/state$/],
  ['POST', /^\/v1\/asks$/],
  ['GET', /^\/v1\/asks\/[\w-]+$/],
  ['GET', /^\/v1\/asks\/[\w-]+\/wait$/],
  ['DELETE', /^\/v1\/asks\/[\w-]+$/],
];

export function createServer({ router, token, version, getConfig, updateConfig, notifyTest, onShutdown, startDemo, keys = null, extraRoutes = [], remote = () => false, mcpHttp = null }) {
  const clients = new Set();
  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };
  router.on('ask', (a) => broadcast('ask', a));
  router.on('update', (a) => broadcast('update', a));
  router.on('state', (s) => broadcast('state', s));
  router.on('rules', () => broadcast('rules', {}));
  router.on('agents', () => broadcast('agents', {}));
  router.on('interrupt', (n) => broadcast('interrupt', { id: n.id, kind: n.kind, asks: n.asks.map((a) => a.id), digest: n.digest.map((a) => a.id), composed: n.composed }));
  const heartbeat = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);
  heartbeat.unref();

  // Agents only see asks made with their own key; the owner sees everything.
  const ownAsk = (q, id) => {
    const ask = router.get(id);
    if (!ask || (q.who.role === 'agent' && ask.key_id !== q.who.key.id)) throw httpError(404, `no ask ${id}`);
    return ask;
  };

  const routes = [
    ['GET', /^\/v1\/state$/, (q) => (q.url.searchParams.get('detail') && q.who.role === 'owner' ? { ...router.state.current(), calendar: router.state.calendarStatus() } : router.state.coarse())],
    ['POST', /^\/v1\/state$/, async (q) => {
      const b = await q.body();
      const until = b.for ? Date.now() + (parseDuration(b.for) ?? 0) : parseWhen(b.until);
      router.setState(b.mode, until || null, b.note || null);
      return { ...router.state.current(), calendar: router.state.calendarStatus() };
    }],
    ['POST', /^\/v1\/asks$/, async (q) => {
      const b = await q.body();
      if (q.who.role === 'agent') {
        // A key speaks for exactly one agent, so it can't borrow another agent's budget or rules.
        const k = q.who.key;
        const name = (typeof b.agent === 'object' && b.agent?.name) || k.name;
        b.agent = { id: k.agent_id, name, instance: typeof b.agent === 'object' ? b.agent?.instance : undefined };
      }
      const ask = router.submit(b);
      if (q.who.role === 'agent') ask.key_id = q.who.key.id;
      const waitMs = Math.min(parseDuration(q.url.searchParams.get('wait')) ?? 0, MAX_WAIT_MS);
      if (waitMs > 0) await router.wait(ask.id, waitMs);
      return [201, { ...answerView(ask), ask }];
    }],
    ['GET', /^\/v1\/asks$/, (q) => {
      const p = q.url.searchParams;
      return { asks: router.list({ status: p.get('status') || 'open', kind: p.get('kind'), limit: Number(p.get('limit')) || 200 }), counts: router.counts() };
    }],
    ['GET', /^\/v1\/asks\/([\w-]+)$/, (q, id) => {
      const ask = ownAsk(q, id);
      return q.who.role === 'owner' ? { ...answerView(ask), ask } : answerView(ask);
    }],
    ['GET', /^\/v1\/asks\/([\w-]+)\/wait$/, async (q, id) => {
      ownAsk(q, id);
      const ms = Math.min(parseDuration(q.url.searchParams.get('timeout') || '25s') ?? 25000, MAX_WAIT_MS);
      const ask = await router.wait(id, ms);
      return answerView(ask);
    }],
    ['POST', /^\/v1\/asks\/([\w-]+)\/answer$/, async (q, id) => {
      const b = await q.body();
      return answerView(router.answer(id, { option: b.option, text: b.text, values: b.values, always: !!b.always, surface: b.surface || 'api' }));
    }],
    ['POST', /^\/v1\/asks\/([\w-]+)\/dismiss$/, async (q, id) => answerView(router.dismiss(id, { surface: (await q.body()).surface || 'api' }))],
    ['POST', /^\/v1\/asks\/([\w-]+)\/ack$/, async (q, id) => answerView(router.ack(id, { surface: (await q.body()).surface || 'api' }))],
    ['POST', /^\/v1\/asks\/([\w-]+)\/snooze$/, async (q, id) => {
      const b = await q.body();
      const ms = parseDuration(b.for || '1h');
      if (!ms) throw httpError(400, 'for must be a duration like "30m"');
      return answerView(router.snooze(id, ms, { surface: b.surface || 'api' }));
    }],
    ['POST', /^\/v1\/asks\/([\w-]+)\/unsnooze$/, async (q, id) => answerView(router.unsnooze(id, { surface: (await q.body()).surface || 'api' }))],
    ['DELETE', /^\/v1\/asks\/([\w-]+)$/, (q, id) => { ownAsk(q, id); return answerView(router.cancel(id, q.url.searchParams.get('reason'))); }],
    ['GET', /^\/v1\/keys$/, () => ({ keys: keys?.list() ?? [] })],
    ['POST', /^\/v1\/keys$/, async (q) => [201, keys.create(await q.body())]],
    ['DELETE', /^\/v1\/keys\/([\w-]+)$/, (q, id) => keys.revoke(id)],
    ...extraRoutes,
    ['POST', /^\/v1\/digest$/, () => ({ delivered: !!router.deliverDigest() })],
    ['GET', /^\/v1\/agents$/, () => ({ agents: router.budgets.list() })],
    ['POST', /^\/v1\/agents\/([^/]+)\/mute$/, async (q, id) => {
      const b = await q.body();
      router.setMuted(decodeURIComponent(id), b.muted !== false);
      return router.budgets.view(decodeURIComponent(id));
    }],
    ['POST', /^\/v1\/agents\/([^/]+)\/reset$/, (q, id) => {
      router.budgets.reset(decodeURIComponent(id));
      router.emit('agents');
      return router.budgets.view(decodeURIComponent(id));
    }],
    ['GET', /^\/v1\/rules$/, () => ({ rules: router.rules.list, suggestions: [...router.suggestions.values()] })],
    ['POST', /^\/v1\/rules$/, async (q) => [201, router.addRule(await q.body(), 'user')]],
    ['DELETE', /^\/v1\/rules\/([\w-]+)$/, (q, id) => router.removeRule(id)],
    ['POST', /^\/v1\/suggestions\/([\w-]+)\/accept$/, (q, id) => router.acceptSuggestion(id)],
    ['POST', /^\/v1\/suggestions\/([\w-]+)\/decline$/, (q, id) => router.declineSuggestion(id)],
    ['GET', /^\/v1\/ledger$/, (q) => ({ entries: router.ledger.tail(Number(q.url.searchParams.get('limit')) || 100, q.url.searchParams.get('type')) })],
    ['GET', /^\/v1\/ledger\/verify$/, () => router.ledger.verify()],
    ['GET', /^\/v1\/stats$/, () => ({ stats: router.stats, counts: router.counts() })],
    ['GET', /^\/v1\/config$/, () => getConfig()],
    ['PATCH', /^\/v1\/config$/, async (q) => updateConfig(await q.body())],
    ['POST', /^\/v1\/notify-test$/, async () => notifyTest()],
    ['POST', /^\/v1\/demo$/, () => {
      if (!startDemo) throw httpError(501, 'demo not available');
      return [202, startDemo()];
    }],
    ['POST', /^\/v1\/shutdown$/, () => {
      setTimeout(onShutdown, 50);
      return { ok: true };
    }],
  ];

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      // DNS-rebinding guard: the inbox and the owner token only ever answer on loopback names.
      // With remote access on (for cloud agents behind a tunnel), other hosts may reach
      // /mcp and the agent routes, and only with an agent key (checked below).
      const local = hostOk(req);
      if (!local && !(remote() && (url.pathname === '/mcp' || url.pathname.startsWith('/v1/')))) throw httpError(421, 'doorman only answers on localhost');

      if (req.method === 'GET' && url.pathname === '/v1/health') return send(res, 200, { ok: true, name: 'doorman', version });

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = (await readFile(new URL('index.html', UI_DIR), 'utf8')).replace('__DOORMAN_TOKEN__', token).replace('__DOORMAN_VERSION__', version);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
        return res.end(html);
      }
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
        return res.end(await readFile(new URL(file, UI_DIR)));
      }

      const who = whoIs(req, url, token, keys);
      if (!who) throw httpError(401, 'missing or bad token (use ~/.doorman/token, or an agent key from the inbox)');
      if (!local && who.role !== 'agent') throw httpError(403, 'from outside this computer, only agent keys are accepted');

      // MCP over HTTP (Streamable HTTP, stateless): for agents that can't launch a local
      // process, like Grok or other cloud agents reaching Doorman through a tunnel.
      if (url.pathname === '/mcp') {
        if (!mcpHttp) throw httpError(501, 'MCP over HTTP is not available');
        return mcpHttp(req, res, who, given(req, url));
      }

      if (who.role === 'agent' && !AGENT_ROUTES.some(([m, re]) => m === req.method && re.test(url.pathname))) {
        throw httpError(403, 'agent keys can only ask, wait for their own answers, and read your status');
      }

      if (req.method === 'GET' && url.pathname === '/v1/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`event: hello\ndata: ${JSON.stringify({ version })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }

      for (const [method, re, handler] of routes) {
        if (req.method !== method) continue;
        const m = re.exec(url.pathname);
        if (!m) continue;
        const out = await handler({ req, url, who, body: () => readBody(req) }, ...m.slice(1));
        return Array.isArray(out) ? send(res, out[0], out[1]) : send(res, 200, out);
      }
      throw httpError(404, `no route ${req.method} ${url.pathname}`);
    } catch (err) {
      const status = err.status || 500;
      send(res, status, { error: err.message, ...(err.errors ? { errors: err.errors } : {}) });
    }
  });

  server.broadcast = broadcast;
  server.closeClients = () => {
    clearInterval(heartbeat);
    for (const res of clients) res.end();
    clients.clear();
  };
  return server;
}
