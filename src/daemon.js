// Wires the router, persistence, surfaces and the HTTP server into one process.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Budgets } from './budget.js';
import { EDITABLE_KEYS, VERSION, ensureHome, getToken, loadConfig, readJSON, saveUserConfig, writeJSON } from './config.js';
import { Ledger } from './ledger.js';
import { randomInt } from 'node:crypto';
import { ActivitySensor } from './activity.js';
import { Ntfy, compose, desktopNotify, signAction, verifyAction } from './notify.js';
import { Router } from './router.js';
import { Rules } from './rules.js';
import { DoormanClient } from './client.js';
import { SCRIPT, runDemo } from './demo.js';
import { expandEvents, parseIcs } from './ics.js';
import { listIntegrations, setIntegration } from './integrations.js';
import { AgentKeys } from './keys.js';
import { createServer } from './server.js';
import { agentSessions } from './sessions.js';
import { answerView, findOption } from './spec.js';
import { HumanState, MODES, fetchIcs } from './state.js';
import { Telegram } from './telegram.js';
import { fmtDuration, parseDuration, randomToken } from './util.js';
import { actionUrl, registerProtocol } from './winproto.js';

const httpError = (status, message) => Object.assign(new Error(message), { status });

/** One line on how an ask was settled, for phone messages that get updated afterwards. */
function outcomeLine(a) {
  const label = a.answer?.option ? findOption(a, a.answer.option)?.label ?? a.answer.option : null;
  const where = { web: 'in the inbox', telegram: 'here', phone: 'on your phone', desktop: 'from a notification', cli: 'in the terminal' }[a.answer?.surface] || '';
  switch (a.status) {
    case 'answered': return `✅ ${label ? `“${label}”` : 'Answered'} ${where}`.trim();
    case 'auto': return `✨ “${label}” by your rule`;
    case 'defaulted': return `⏱ No answer in time, “${label}” applied`;
    case 'dismissed': return `✖ Dismissed${label ? `, “${label}” applied` : ''}`;
    case 'expired': return '⏱ Expired';
    case 'cancelled': return '↩ Withdrawn by the agent';
    default: return null;
  }
}

// The exact command to run this copy of doorman, for copy-paste setup instructions in the inbox.
const BIN = fileURLToPath(new URL('../bin/doorman.js', import.meta.url));
const CLI = `node "${BIN}"`;
// Where agents keep their config and logs (your home folder). Overridable for demos and tests.
const AGENT_HOME = () => process.env.DOORMAN_AGENT_HOME || undefined;

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

  // Telegram: your own bot, paired to your chat with a one-time code.
  let telegram = null;
  let pairCode = null;
  const startTelegram = () => {
    telegram?.close();
    telegram = null;
    if (!config.telegram?.token) return;
    if (!config.telegram.chatId) pairCode = String(randomInt(100000, 1000000));
    telegram = new Telegram(config.telegram, {
      log,
      pairCode: () => pairCode,
      onPaired: ({ chatId, userId, username }) => {
        config.telegram = { ...config.telegram, chatId, userId, username: username || null };
        saveUserConfig(p.home, { telegram: config.telegram });
        pairCode = null;
        router.ledger.append('phone.paired', { channel: 'telegram' });
        server.broadcast('config', {});
      },
      onAnswer: (askId, idx) => {
        const a = router.get(askId);
        const opt = a?.options?.[idx];
        if (!opt) return { toast: 'That request is gone' };
        try {
          router.answer(askId, { option: opt.id, surface: 'telegram' });
          return { toast: `Sent “${opt.label}”` };
        } catch (err) { return { toast: err.status === 409 ? 'Already settled' : err.message }; }
      },
      onText: (askId, text) => {
        try { router.answer(askId, { text, surface: 'telegram' }); } catch (err) { telegram.send(err.message).catch(() => {}); }
      },
      onCommand: async (cmd, arg) => {
        const modes = { available: 'available', focus: 'focus', dnd: 'dnd', away: 'away', auto: 'auto' };
        if (modes[cmd]) {
          const ms = parseDuration(arg || '');
          router.setState(modes[cmd], ms ? Date.now() + ms : null, null);
          const s = router.state.current();
          return `Status: <b>${MODES[s.mode].label}</b>${s.until ? ` for ${fmtDuration(s.until - Date.now())}` : ''}`;
        }
        if (cmd === 'inbox') {
          const open = router.list({ status: 'open' }).filter((a) => a.kind !== 'inform' && a.status === 'pending').slice(0, 5);
          if (!open.length) return 'Nothing needs you right now.';
          for (const a of open) await telegram.sendAsk(a);
          return null;
        }
        if (cmd === 'status') {
          const s = router.state.current();
          const n = router.list({ status: 'open' }).filter((a) => a.kind !== 'inform' && a.status === 'pending').length;
          return `<b>${MODES[s.mode].label}</b>${s.until ? ` for ${fmtDuration(s.until - Date.now())}` : ''}\n${n ? `${n} decision${n === 1 ? '' : 's'} waiting. Send /inbox to see them.` : 'Nothing needs you right now.'}`;
        }
        return 'Commands: /status, /inbox, /available, /focus 1h, /dnd 30m, /away, /auto';
      },
    });
    telegram.start();
  };
  startTelegram();

  // Opt-in activity sensing: idle time + front app category feed the human state.
  const sensor = new ActivitySensor({ log });
  sensor.on('sample', () => { state.activity = sensor.snapshot(); });
  const startSensor = () => {
    sensor.stop();
    state.activity = null;
    if (config.activity?.enabled) sensor.start();
  };
  startSensor();

  const baseUrl = () => `http://127.0.0.1:${config.port}`;
  const iconPath = join(p.home, 'doorman-icon-2.png'); // bump the name when the icon design changes
  // Answer buttons on Windows notifications, via a per-user doorman:// handler.
  let protocolReady = false;
  if (process.platform === 'win32' && !config.noProtocol) {
    registerProtocol(p.home).then((ok) => {
      protocolReady = ok;
      if (!ok) log('could not register doorman:// links, so notification buttons are off');
    });
  }
  const desktopActions = (c) => {
    const a = c.single;
    if (!protocolReady || !a || a.kind !== 'decision' || a.options.length > 4) return [];
    return a.options.map((o) => ({ label: o.label, url: actionUrl(a.id, o.id, signAction(ntfySecret, a.id, o.id)) }));
  };

  router.on('interrupt', (n) => {
    const c = compose(n, baseUrl());
    n.composed = { title: c.title, body: c.body };
    if (!quiet) log(`interrupt → ${c.title}: ${c.body.replace(/\n/g, ' | ')}`);
    if (config.desktop && n.surfaces.includes('desktop')) {
      desktopNotify(c, { icon: iconPath, actions: desktopActions(c) }).then((r) => { if (!r.ok) log(`desktop notification failed: ${r.error}`); });
    }
    if (ntfy && (ntfy.shouldSend(n.state) || !n.surfaces.includes('desktop'))) {
      ntfy.publish(n, c).catch((err) => log(err.message));
    }
    if (telegram && (telegram.shouldSend(n.state) || !n.surfaces.includes('desktop'))) {
      telegram.deliver(n).catch((err) => log(err.message));
    }
  });
  // Once something is settled anywhere, update the phone message so it doesn't linger.
  router.on('update', (a) => {
    if (telegram && !['pending', 'unread'].includes(a.status)) {
      const line = outcomeLine(a);
      if (line) telegram.resolved(a, line).catch(() => {});
    }
  });

  const getConfig = () => {
    const out = {};
    for (const k of EDITABLE_KEYS) out[k] = config[k] ?? null;
    if (out.ntfy) out.ntfy = { ...out.ntfy, token: out.ntfy.token ? '••••' : null, replyTopic: out.ntfy.replyTopic || `${out.ntfy.topic}-reply` };
    if (out.telegram) out.telegram = { mirror: out.telegram.mirror || 'always', redact: !!out.telegram.redact, token: out.telegram.token ? '••••' : null, username: out.telegram.username || null, paired: !!out.telegram.chatId };
    return { config: out, home: p.home, port: config.port, version: VERSION, cli: CLI, telegram: telegram?.status() ?? null, activity_supported: sensor.supported };
  };
  const updateConfig = async (patch) => {
    if (patch.ntfy?.token === '••••') patch.ntfy.token = config.ntfy?.token ?? null;
    if (patch.telegram) {
      // The UI never sees the bot token or chat id; keep them unless a new token is pasted.
      const prev = config.telegram || {};
      const sameBot = !patch.telegram.token || patch.telegram.token === '••••' || patch.telegram.token === prev.token;
      patch.telegram = {
        token: sameBot ? prev.token : patch.telegram.token.trim(),
        chatId: sameBot ? prev.chatId : undefined,
        userId: sameBot ? prev.userId : undefined,
        username: sameBot ? prev.username : undefined,
        mirror: patch.telegram.mirror || prev.mirror || 'always',
        redact: patch.telegram.redact ?? prev.redact ?? false,
      };
      if (!patch.telegram.token) patch.telegram = null;
    }
    const restartTelegram = 'telegram' in patch && (patch.telegram?.token !== config.telegram?.token || !patch.telegram);
    for (const k of EDITABLE_KEYS) if (k in patch) config[k] = patch[k];
    Object.assign(router.config, config);
    state.config = config;
    saveUserConfig(p.home, patch);
    if ('ntfy' in patch) startNtfy();
    if (restartTelegram) startTelegram();
    else if (telegram && patch.telegram) Object.assign(telegram.cfg, { mirror: patch.telegram.mirror, redact: patch.telegram.redact });
    if ('activity' in patch) startSensor();
    if ('calendar' in patch) await state.refreshCalendar();
    router.tick();
    if (telegram && restartTelegram) await new Promise((r) => setTimeout(r, 800)); // let getMe report a bad token
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
        sent.push('ntfy');
      } catch (err) { errors.ntfy = err.message; }
    }
    if (telegram?.paired) {
      try {
        await telegram.send('🔔 <b>Doorman test</b>\nIf you can see this, Doorman can reach your phone.');
        sent.push('Telegram');
      } catch (err) { errors.telegram = err.message; }
    }
    return { sent, errors, platform: process.platform };
  };

  // Routes the inbox uses for setup, the "Now" view and signed notification buttons.
  const keys = new AgentKeys(p.keys);
  const integrationOpts = () => ({ hookWaitSeconds: config.hookWaitSeconds, home: AGENT_HOME() });
  const extraRoutes = [
    ['GET', /^\/v1\/integrations$/, () => ({ integrations: listIntegrations(integrationOpts()) })],
    ['POST', /^\/v1\/integrations\/([\w-]+)$/, async (q, id) => {
      const on = (await q.body()).connected !== false;
      const r = setIntegration(id, on, integrationOpts());
      router.ledger.append('integration.changed', { id, connected: on });
      return r;
    }],
    ['GET', /^\/v1\/now$/, () => ({
      state: router.state.current(),
      activity_enabled: !!config.activity?.enabled,
      sessions_enabled: config.sessions !== false,
      sessions: config.sessions === false ? [] : agentSessions({ home: AGENT_HOME() }),
      upcoming: state.upcoming(3),
    })],
    ['GET', /^\/v1\/calendar$/, () => ({ status: state.calendarStatus(), upcoming: state.upcoming(8) })],
    ['POST', /^\/v1\/calendar\/preview$/, async (q) => {
      const b = await q.body();
      if (!b.ics) throw httpError(400, 'paste a calendar link first');
      let text;
      try { text = await fetchIcs(b.ics); } catch (err) { throw httpError(400, `Couldn't read that calendar: ${err.message}`); }
      const now = Date.now();
      const events = expandEvents(parseIcs(text), now, now + 7 * 864e5).filter((e) => e.busy && e.end > now);
      return { ok: true, count: events.length, events: events.slice(0, 6).map((e) => ({ start: e.start, end: e.end, summary: e.summary })) };
    }],
    ['GET', /^\/v1\/telegram$/, () => telegram?.status() ?? { configured: false }],
    ['POST', /^\/v1\/actions\/answer$/, async (q) => {
      const b = await q.body();
      if (!verifyAction(ntfySecret, b.ask, b.option, b.sig)) throw httpError(403, 'bad signature');
      const a = router.answer(b.ask, { option: b.option, surface: b.surface || 'desktop' });
      return answerView(a);
    }],
  ];

  let closing = null;
  const close = () => {
    if (closing) return closing;
    closing = new Promise((resolve) => {
      clearInterval(ticker);
      clearInterval(calTimer);
      ntfy?.close();
      telegram?.close();
      sensor.stop();
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

  const server = createServer({ router, token, version: VERSION, getConfig, updateConfig, notifyTest, startDemo, keys, extraRoutes, onShutdown: () => close().then(() => process.exitCode ?? 0) });

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
