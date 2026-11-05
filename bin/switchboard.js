#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, openSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SwitchboardClient } from '../src/client.js';
import { VERSION, switchboardHome, ensureHome, loadConfig, paths } from '../src/config.js';
import { Ledger } from '../src/ledger.js';
import { fmtDuration } from '../src/util.js';

const BIN = fileURLToPath(import.meta.url);

const HELP = `switchboard ${VERSION}: the attention layer for your AI agents

Daemon
  switchboard start [--port 7777] [--detach]   Run the router (inbox at http://127.0.0.1:7777)
  switchboard stop                             Stop a running daemon
  switchboard status                           Your state, what's waiting, agent budgets
  switchboard open                             Open the inbox in your browser

You
  switchboard focus <available|focus|dnd|away|auto> [--for 90m]
  switchboard digest                           Deliver the digest now
  switchboard rules [list | add ... | rm <id>]
  switchboard ledger [tail [-n 20] | verify | export]

Agents
  switchboard ask "Question?" -o Yes -o No [--urgency high] [--deadline 10m] [--default No]
                                           Blocks, prints the answer (scriptable)
  switchboard review <file|url> [--title "…"]  Ask for a review; exit 0 approved, 1 changes requested
  switchboard notify "Message" [--urgency low]
  switchboard mcp                              MCP server: ask_human, notify_human, get_human_state
  switchboard proxy [--name x] [--gate "delete_*"] -- <mcp server command...>
                                           Route a server's elicitations + gate its tools
  switchboard hook claude-code                 Claude Code hook (PermissionRequest, Notification, Stop)
  switchboard hook codex '<json>'              Codex notify program
  switchboard setup [agent] [--write|--remove]   Claude Code, Codex, Cursor, Claude Desktop, OpenClaw, Hermes, Muse Code
  switchboard tunnel                           Let cloud agents (Grok, the Muse app) reach you via /mcp
  switchboard demo [--speed 1]                 Three agents need you at once

Env: SWITCHBOARD_HOME (default ~/.switchboard), SWITCHBOARD_URL, SWITCHBOARD_AGENT, SWITCHBOARD_AGENT_NAME`;

function parseArgs(argv, aliases = {}) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '--') { out.rest = argv.slice(i + 1); break; }
    if (a.startsWith('-') && a.length > 1 && Number.isNaN(Number(a))) {
      let val;
      if (a.includes('=')) [a, val] = [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)];
      let key = a.replace(/^--?/, '');
      key = aliases[key] || key;
      if (val === undefined) {
        const next = argv[i + 1];
        val = next !== undefined && !next.startsWith('--') ? (i++, next) : true;
      }
      if (key in out.flags) out.flags[key] = [].concat(out.flags[key], val);
      else out.flags[key] = val;
    } else out._.push(a);
  }
  return out;
}
const list = (v) => (v == null ? [] : [].concat(v));
const die = (msg, code = 1) => { console.error(`switchboard: ${msg}`); process.exit(code); };

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
}

async function cmdStart(args) {
  const port = args.flags.port ? Number(args.flags.port) : undefined;
  const client = new SwitchboardClient({ autostart: false, url: port ? `http://127.0.0.1:${port}` : undefined });
  if (await client.health()) {
    if (!args.flags['background-child']) console.log(`switchboard is already running at ${client.url}`);
    return;
  }
  const p = ensureHome();
  if (args.flags.detach) {
    const out = openSync(p.log, 'a');
    const child = spawn(process.execPath, [BIN, 'start', '--background-child', ...(port ? ['--port', String(port)] : [])], { detached: true, stdio: ['ignore', out, out], windowsHide: true });
    child.unref();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const c = new SwitchboardClient({ autostart: false });
      if (await c.health()) { console.log(`switchboard running in the background at ${c.url}  (logs: ${p.log})`); return; }
    }
    die(`daemon did not start; see ${p.log}`);
  }
  const { startDaemon } = await import('../src/daemon.js');
  const bg = !!args.flags['background-child'];
  const log = bg ? (m) => { try { appendFileSync(p.log, `${new Date().toISOString()} ${m}\n`); } catch { /* ignore */ } } : (m) => console.error(`[switchboard] ${m}`);
  let d;
  try {
    d = await startDaemon({ port, log });
  } catch (err) {
    if (err.code === 'EADDRINUSE') die(`port ${port ?? loadConfig().port} is in use (another switchboard? try: switchboard status)`);
    throw err;
  }
  const shutdown = () => d.close().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  if (!bg) {
    console.log(`\n  switchboard ${VERSION} is on the line.\n\n  Inbox   ${d.url}/\n  Home    ${d.home}\n  State   ${d.router.state.current().label}\n\n  Try:    switchboard demo        (in another terminal)\n          switchboard setup claude-code\n`);
    if (args.flags.open) openBrowser(`${d.url}/`);
  }
}

async function cmdStatus() {
  const c = new SwitchboardClient({ autostart: false });
  if (!(await c.health())) return die('not running. Start it with: switchboard start', 1);
  const st = await c.request('GET', '/v1/state?detail=1');
  const { counts, stats } = await c.request('GET', '/v1/stats');
  const { agents } = await c.request('GET', '/v1/agents');
  console.log(`switchboard at ${c.url}`);
  console.log(`  You:      ${st.label}${st.until ? ` until ${new Date(st.until).toLocaleTimeString()}` : ''} (${st.source})`);
  console.log(`  Waiting:  ${counts.needs_you} need you, ${counts.fyi} FYI, ${counts.held} held, ${counts.digest} for digest`);
  console.log(`  Totals:   ${stats.asks} asks → ${stats.notifications} interruptions (${stats.digests} digests), ${stats.auto} auto-answered`);
  if (agents.length) {
    console.log('  Agents:');
    for (const a of agents.slice(0, 12)) {
      console.log(`    ${a.name.padEnd(30)} budget ${a.tokens.toFixed(1)}/${a.capacity}/hr  credibility ${Math.round(a.credibility * 100)}%${a.muted ? '  MUTED' : ''}`);
    }
  }
}

async function cmdAsk(args) {
  const question = args._.join(' ');
  if (!question) die('usage: switchboard ask "Question?" -o Yes -o No');
  const options = list(args.flags.option);
  const input = {
    question,
    agent: args.flags.agent ? String(args.flags.agent) : process.env.SWITCHBOARD_AGENT ? undefined : { id: 'cli', name: 'Terminal' },
    urgency: args.flags.urgency,
    deadline: args.flags.deadline,
    default: args.flags.default,
    reversible: args.flags.irreversible ? false : undefined,
    delay_cost: args.flags['delay-cost'],
    detail: args.flags.detail ? String(args.flags.detail) : undefined,
    thread: args.flags.thread,
  };
  if (options.length) input.options = options.map(String);
  else input.input = { type: 'text' };
  const c = new SwitchboardClient();
  const timeoutMs = args.flags.timeout ? Number(String(args.flags.timeout).replace(/s$/, '')) * 1000 : Infinity;
  const v = await c.ask(input, { timeoutMs });
  if (args.flags.json) console.log(JSON.stringify(v, null, 2));
  else console.log(v.answer?.label ?? v.answer?.text ?? v.status);
  process.exit({ answered: 0, auto: 0, defaulted: 0, dismissed: 1 }[v.status] ?? 2);
}

/** switchboard review <file|url> [--title "…"]: blocks until approved (exit 0) or changes are requested (exit 1). */
async function cmdReview(args) {
  const target = args._[0];
  if (!target) die('usage: switchboard review <file or url> [--title "Review the plan?"] [--deadline 2h]');
  const isUrl = /^https?:\/\//i.test(target);
  const path = isUrl ? null : resolve(target);
  if (path && !existsSync(path)) die(`no such file: ${target}`);
  const c = new SwitchboardClient();
  const v = await c.ask({
    agent: args.flags.agent ? String(args.flags.agent) : process.env.SWITCHBOARD_AGENT ? undefined : { id: 'cli', name: 'Terminal' },
    kind: 'review',
    question: args.flags.title ? String(args.flags.title) : `Review ${isUrl ? target : basename(path)}?`,
    detail: args.flags.detail ? String(args.flags.detail) : undefined,
    urgency: args.flags.urgency,
    deadline: args.flags.deadline,
    attachments: [isUrl ? { url: target } : { path }],
  }, { timeoutMs: args.flags.timeout ? Number(String(args.flags.timeout).replace(/s$/, '')) * 1000 : Infinity });
  if (args.flags.json) console.log(JSON.stringify(v, null, 2));
  else console.log(`${v.answer?.label ?? v.status}${v.answer?.text ? `: ${v.answer.text}` : ''}`);
  process.exit(v.answer?.option === 'approve' ? 0 : v.answer?.option === 'changes' ? 1 : 2);
}

async function cmdRules(args) {
  const c = new SwitchboardClient();
  const sub = args._[0] || 'list';
  if (sub === 'list') {
    const { rules, suggestions } = await c.request('GET', '/v1/rules');
    if (!rules.length) console.log('No rules yet.');
    for (const r of rules) console.log(`${r.id}  ${JSON.stringify(r.match)} → ${JSON.stringify(r.action)}  (${r.hits} hits, ${r.source})`);
    for (const s of suggestions) console.log(`suggestion ${s.id}: always "${s.label}" for ${s.agent.name}: ${s.fingerprint}`);
  } else if (sub === 'add') {
    const match = {};
    for (const k of ['agent', 'kind', 'urgency', 'fingerprint', 'question', 'thread', 'tag']) if (args.flags[k]) match[k] = String(args.flags[k]);
    const action = args.flags.answer ? { answer: String(args.flags.answer) } : { route: String(args.flags.route || '') };
    const r = await c.request('POST', '/v1/rules', { match, action, note: args.flags.note });
    console.log(`added ${r.id}`);
  } else if (sub === 'rm') {
    await c.request('DELETE', `/v1/rules/${args._[1]}`);
    console.log('removed');
  } else die('usage: switchboard rules [list | add --agent X --fingerprint "Bash:npm test*" --answer allow | rm <id>]');
}

function cmdLedger(args) {
  const p = paths(switchboardHome());
  const sub = args._[0] || 'tail';
  if (sub === 'verify') {
    const r = Ledger.verifyFile(p.ledger);
    console.log(r.ok ? `ledger OK: ${r.count} entries, head ${r.head.slice(0, 16)}…` : `LEDGER BROKEN at entry ${r.broken_at}: ${r.reason}`);
    process.exit(r.ok ? 0 : 3);
  }
  if (!existsSync(p.ledger)) return console.log('ledger is empty');
  const lines = readFileSync(p.ledger, 'utf8').split('\n').filter(Boolean);
  if (sub === 'export') return process.stdout.write(`${lines.join('\n')}\n`);
  const n = Number(args.flags.n || 20);
  for (const l of lines.slice(-n)) {
    const e = JSON.parse(l);
    const d = e.data || {};
    const what = d.question ? `${d.agent?.name ?? d.agent}: ${d.question}` : d.status ? `${d.id} → ${d.status}${d.answer?.option ? ` (${d.answer.option} by ${d.answer.by})` : ''}` : JSON.stringify(d).slice(0, 100);
    console.log(`#${e.seq} ${e.ts} ${e.type.padEnd(18)} ${what}`);
  }
}

async function cmdHook(args) {
  const which = args._[0];
  const { runClaudeHook, codexInform } = await import('../src/hooks.js');
  const c = new SwitchboardClient();
  if (which === 'codex') {
    const raw = args._[1] || args.rest?.[0];
    try {
      const inform = codexInform(JSON.parse(raw));
      if (inform) await c.submit(inform);
    } catch (err) { console.error(`switchboard hook codex: ${err.message}`); }
    return;
  }
  if (which !== 'claude-code') die('usage: switchboard hook <claude-code|codex>');
  // Hooks must never break the agent: any failure means "no opinion".
  let pending = null;
  const cancel = () => {
    const done = () => process.exit(0);
    if (pending) c.cancel(pending, 'hook was stopped').finally(done);
    else done();
  };
  process.on('SIGTERM', cancel);
  process.on('SIGINT', cancel);
  try {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    const payload = JSON.parse(raw);
    const wait = Number(process.env.SWITCHBOARD_HOOK_WAIT) || loadConfig().hookWaitSeconds || 600;
    const out = await runClaudeHook(payload, { client: c, waitSeconds: wait, onCreated: (id) => { pending = id; } });
    pending = null;
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (err) {
    console.error(`switchboard: ${err.message}`);
  }
  // Let the process end on its own: process.exit() while the stdin pipe is
  // closing trips a libuv assertion on Windows.
  process.removeListener('SIGTERM', cancel);
  process.removeListener('SIGINT', cancel);
  process.stdin.destroy();
  process.exitCode = 0;
}

async function cmdSetup(args) {
  const { listIntegrations, setIntegration } = await import('../src/integrations.js');
  const opts = { hookWaitSeconds: loadConfig().hookWaitSeconds || 600 };
  const all = listIntegrations(opts);
  const which = args._[0];
  if (!which) {
    console.log('Agents on this computer:\n');
    for (const i of all) console.log(`  ${i.connected ? '●' : i.detected ? '○' : '·'} ${i.name.padEnd(15)} ${i.connected ? 'connected' : i.detected ? 'installed, not connected' : 'not found'}   switchboard setup ${i.id} --write`);
    console.log('\nOr open the inbox: Connect → one click per agent.');
    return;
  }
  const i = all.find((x) => x.id === which);
  if (!i) die(`usage: switchboard setup <${all.map((x) => x.id).join('|')}> [--write | --remove]`);
  if (args.flags.write || args.flags.remove) {
    console.log(setIntegration(which, !args.flags.remove, opts).message);
  } else {
    console.log(`Add to ${i.file} (or run: switchboard setup ${which} --write):\n`);
    console.log(i.snippet);
  }
  if (which === 'claude-code') {
    console.log('\nOptional: give Claude an ask_human tool for questions mid-task:\n');
    console.log(`   claude mcp add switchboard -- node "${BIN}" mcp\n`);
    console.log('Gate risky tools on any MCP server by wrapping it:\n');
    console.log(`   claude mcp add github -- node "${BIN}" proxy --name github --gate "create_*|delete_*|merge_*" -- npx -y @modelcontextprotocol/server-github\n`);
  }
}

/**
 * Let cloud agents (Grok, the Muse app…) reach you: a free Cloudflare quick tunnel to
 * this daemon. Only /mcp and the agent routes answer through it, and only with an
 * agent key; the inbox and your owner token stay local. Ctrl-C turns it off again.
 */
async function cmdTunnel() {
  const c = new SwitchboardClient();
  if (!(await c.ensure())) die('could not reach or start the switchboard daemon');
  const port = new URL(c.url).port || '7777';
  const proc = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  proc.on('error', () => die([
    'cloudflared is not installed. It makes a free, temporary public URL for Switchboard:',
    '  Windows:  winget install --id Cloudflare.cloudflared',
    '  macOS:    brew install cloudflared',
    '  Linux:    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
    'Or use any tunnel (e.g. ngrok http 7777) and turn on "Cloud agents" on the Connect page.',
  ].join('\n')));
  let url = null;
  const onData = async (d) => {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(d));
    if (!m || url) return;
    url = m[0];
    await c.request('PATCH', '/v1/config', { remote: { enabled: true, url } });
    console.log(`\n  Cloud agents can now reach Switchboard.\n\n  MCP URL:  ${url}/mcp?key=<agent key>\n\n  1. Create an agent key in the inbox: Connect → Any other agent.\n  2. In Grok: grok.com/connectors → New connector → Custom → paste the MCP URL with your key.\n\n  Only agent keys work through this URL. Press Ctrl-C to close it; remote access turns off.\n  (Quick-tunnel URLs change each time, so update the connector if you restart.)\n`);
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  const stop = async () => {
    await c.request('PATCH', '/v1/config', { remote: { enabled: false, url: null } }).catch(() => {});
    proc.kill();
    process.exitCode = 0;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  proc.on('exit', () => { if (url) console.log('Tunnel closed.'); });
}

/** switchboard://answer?... from a Windows notification button. */
async function cmdUrl(args) {
  const { parseActionUrl } = await import('../src/winproto.js');
  const action = parseActionUrl(args._[0] || '');
  if (!action) return;
  const c = new SwitchboardClient({ autostart: false });
  try {
    await c.request('POST', '/v1/actions/answer', { ...action, surface: 'desktop' });
  } catch (err) {
    appendFileSync(paths().log, `${new Date().toISOString()} notification button: ${err.message}\n`);
  }
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const args = parseArgs(argv, { o: 'option', u: 'urgency', d: 'deadline', n: 'n', p: 'port' });
  switch (cmd) {
    case 'start': return cmdStart(args);
    case 'stop': {
      const c = new SwitchboardClient({ autostart: false });
      if (!(await c.health())) return console.log('switchboard is not running');
      await c.request('POST', '/v1/shutdown');
      return console.log('stopped');
    }
    case 'status': return cmdStatus();
    case 'open': {
      const c = new SwitchboardClient();
      await c.ensure();
      openBrowser(`${c.url}/`);
      return console.log(`${c.url}/`);
    }
    case 'focus':
    case 'state': {
      const c = new SwitchboardClient();
      const s = args._[0]
        ? await (await c.ensure(), c.request('POST', '/v1/state', { mode: args._[0], for: args.flags.for }))
        : (await c.ensure(), await c.request('GET', '/v1/state?detail=1'));
      return console.log(`${s.label}${s.until ? ` for ${fmtDuration(s.until - Date.now())}` : ''} (${s.source}); interrupts for ${s.interruptible_for}+`);
    }
    case 'digest': {
      const c = new SwitchboardClient();
      await c.ensure();
      const r = await c.request('POST', '/v1/digest');
      return console.log(r.delivered ? 'digest delivered' : 'digest is empty');
    }
    case 'ask': return cmdAsk(args);
    case 'review': return cmdReview(args);
    case 'notify': {
      const r = await new SwitchboardClient().notify(args._.join(' '), { agent: args.flags.agent ? String(args.flags.agent) : { id: 'cli', name: 'Terminal' }, urgency: args.flags.urgency || 'normal' });
      return console.log(`${r.id}: ${r.delivery?.mode} (${r.delivery?.reason})`);
    }
    case 'rules': return cmdRules(args);
    case 'ledger': return cmdLedger(args);
    case 'mcp': {
      const { runMcpServer } = await import('../src/mcp-server.js');
      return runMcpServer();
    }
    case 'proxy': {
      if (!args.rest?.length) die('usage: switchboard proxy [--name x] [--gate "pattern"] -- <command> [args...]');
      const { runProxy } = await import('../src/proxy.js');
      const child = runProxy({
        command: args.rest[0],
        args: args.rest.slice(1),
        name: args.flags.name ? String(args.flags.name) : undefined,
        gates: list(args.flags.gate).flatMap((g) => String(g).split(',')).filter(Boolean),
        routeElicitation: !args.flags['no-elicitation'],
        gateTimeout: args.flags['gate-timeout'] || '10m',
      });
      child.on('exit', (code) => {
        process.exitCode = code ?? 0;
        process.stdin.destroy();
      });
      return;
    }
    case 'hook': return cmdHook(args);
    case 'setup': return cmdSetup(args);
    case 'url': return cmdUrl(args);
    case 'tunnel': return cmdTunnel();
    case 'demo': {
      const { runDemo } = await import('../src/demo.js');
      return runDemo({ speed: Number(args.flags.speed) || 1 });
    }
    case '-v':
    case '--version':
    case 'version': return console.log(VERSION);
    case undefined:
    case 'help':
    case '-h':
    case '--help': return console.log(HELP);
    default: die(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

main().catch((err) => die(err.message));
