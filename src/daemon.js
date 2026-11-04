// Wires the router, persistence, surfaces and the HTTP server into one process.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Budgets } from './budget.js';
import { EDITABLE_KEYS, VERSION, ensureHome, getToken, loadConfig, readJSON, saveUserConfig, writeJSON } from './config.js';
import { Ledger } from './ledger.js';
import { Ntfy, compose, desktopNotify } from './notify.js';
import { Router } from './router.js';
import { Rules } from './rules.js';
import { DoormanClient } from './client.js';
import { SCRIPT, runDemo } from './demo.js';
import { createServer } from './server.js';
import { HumanState } from './state.js';
import { randomToken } from './util.js';

// The exact command to run this copy of doorman, for copy-paste setup instructions in the inbox.
const BIN = fileURLToPath(new URL('../bin/doorman.js', import.meta.url));
const CLI = `node "${BIN}"`;

export async function startDaemon({ home, port, overrides = {}, log = (m) => console.error(`[doorman] ${m}`), tickMs = 250, quiet = false } = {}) {
  const p = ensureHome(home);
  const config = loadConfig(p.home, overrides);
  if (port != null) config.port = port;
  const token = getToken(p.home);
  const clock = Date.now;

  const ledger = new Ledger(p.ledger);
  const budgets = new Budgets(config.budget, clock);
  const state = new HumanState(config, clock);
  const rules = new Rules(readJSON(p.rules, []), clock);
  const router = new Router({ config, clock, ledger, budgets, state, rules });

  const saved = readJSON(p.state, null);
  if (saved) {
    budgets.load(saved.budgets);
    state.load(saved.human);
    router.load(saved.router);
  }

  // Persistence: debounce snapshots so a burst of asks is one write.
  let saveTimer = null;
  const saveNow = () => {
    saveTimer = null;
    try {
      // ntfySecret signs phone action buttons; keeping it means old buttons still work after a restart.
      writeJSON(p.state, { version: VERSION, saved_at: Date.now(), ntfySecret, budgets: budgets.toJSON(), human: state.toJSON(), router: router.toJSON() });
      writeJSON(p.rules, rules.toJSON());
    } catch (err) {
      log(`could not save state: ${err.message}`);
    }
  };
  const save = () => { if (!saveTimer) saveTimer = setTimeout(saveNow, 300); };
  for (const ev of ['ask', 'update', 'state', 'rules', 'agents']) router.on(ev, save);

  // Phone push.
  let ntfy = null;
  const ntfySecret = saved?.ntfySecret || randomToken();
  const startNtfy = () => {
    ntfy?.close();
    ntfy = null;
    if (!config.ntfy?.topic) return;
    ntfy = new Ntfy(config.ntfy, {
      secret: ntfySecret,
      log,
      onAnswer: (askId, option) => {
        try { router.answer(askId, { option, surface: 'phone' }); } catch (err) { log(`phone answer ignored: ${err.message}`); }
      },
    });
    ntfy.subscribe();
  };
  startNtfy();

  const baseUrl = () => `http://127.0.0.1:${config.port}`;
  const iconPath = join(p.home, 'doorman.png');
  router.on('interrupt', (n) => {
    const c = compose(n, baseUrl());
    n.composed = { title: c.title, body: c.body };
    if (!quiet) log(`interrupt → ${c.title}: ${c.body.replace(/\n/g, ' | ')}`);
    if (config.desktop && n.surfaces.includes('desktop')) {
      desktopNotify(c, { icon: iconPath }).then((r) => { if (!r.ok) log(`desktop notification failed: ${r.error}`); });
    }
    if (ntfy && (ntfy.shouldSend(n.state) || !n.surfaces.includes('desktop'))) {
      ntfy.publish(n, c).catch((err) => log(err.message));
    }
  });

  const getConfig = () => {
    const out = {};
    for (const k of EDITABLE_KEYS) out[k] = config[k] ?? null;
    if (out.ntfy) out.ntfy = { ...out.ntfy, token: out.ntfy.token ? '••••' : null, replyTopic: out.ntfy.replyTopic || `${out.ntfy.topic}-reply` };
    return { config: out, home: p.home, port: config.port, version: VERSION, cli: CLI };
  };
  const updateConfig = async (patch) => {
    if (patch.ntfy?.token === '••••') patch.ntfy.token = config.ntfy?.token ?? null;
    for (const k of EDITABLE_KEYS) if (k in patch) config[k] = patch[k];
    Object.assign(router.config, config);
    state.config = config;
    saveUserConfig(p.home, patch);
    if ('ntfy' in patch) startNtfy();
    if ('calendar' in patch) await state.refreshCalendar();
    router.tick();
    return getConfig();
  };
  const notifyTest = async () => {
    const c = { title: 'Doorman test', body: 'If you can see this, interruptions reach you here.', url: `${baseUrl()}/`, single: null, urgency: 'normal' };
    const sent = [];
    const errors = {};
    if (config.desktop) {
      const r = await desktopNotify(c, { icon: iconPath });
      if (r.ok) sent.push('desktop'); else errors.desktop = r.error;
    }
    if (ntfy) {
      try {
        await ntfy.publish({ asks: [], digest: [] }, c);
        sent.push('phone');
      } catch (err) { errors.phone = err.message; }
    }
    return { sent, errors, platform: process.platform };
  };

  let closing = null;
  const close = () => {
    if (closing) return closing;
    closing = new Promise((resolve) => {
      clearInterval(ticker);
      clearInterval(calTimer);
      ntfy?.close();
      if (saveTimer) clearTimeout(saveTimer);
      saveNow();
      try { rmSync(p.daemon, { force: true }); } catch { /* ignore */ }
      server.closeClients();
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    return closing;
  };

  // "Try it with sample agents" in the inbox runs the same script as `doorman demo`.
  let demoRunning = false;
  const startDemo = () => {
    if (demoRunning) return { started: false, reason: 'already running' };
    demoRunning = true;
    const client = new DoormanClient({ url: baseUrl(), token, autostart: false });
    runDemo({ client, log: () => {} })
      .catch((err) => log(`demo failed: ${err.message}`))
      .finally(() => { demoRunning = false; });
    return { started: true, asks: SCRIPT.length };
  };

  const server = createServer({ router, token, version: VERSION, getConfig, updateConfig, notifyTest, startDemo, onShutdown: () => close().then(() => process.exitCode ?? 0) });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', () => {
      config.port = server.address().port;
      resolve();
    });
  });

  await state.refreshCalendar();
  const ticker = setInterval(() => router.tick(), tickMs);
  const calTimer = setInterval(() => state.refreshCalendar(), config.calendar?.refreshMs ?? 5 * 60e3);
  ticker.unref?.();
  calTimer.unref?.();

  writeJSON(p.daemon, { pid: process.pid, port: config.port, url: baseUrl(), started_at: Date.now(), version: VERSION });
  saveNow();

  return { router, server, config, token, url: baseUrl(), home: p.home, close };
}
