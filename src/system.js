// How Switchboard is installed on this computer: whether it starts at login, which
// agent CLIs are on the PATH, and the checks behind `switchboard doctor`.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BIN = fileURLToPath(new URL('../bin/switchboard.js', import.meta.url));
export const PACKAGE = '@nkomianos/switchboard';
export const INSTALL_COMMAND = 'npm install -g github:nkomianos/switchboard';

const found = new Map();
/** Full path of a command on the PATH, or null. Cached for a minute, so installing one shows up. */
export function findCommand(name) {
  const hit = found.get(name);
  if (hit && Date.now() - hit.at < 60_000) return hit.path;
  let path = null;
  try {
    const r = process.platform === 'win32'
      ? spawnSync('where.exe', [name], { encoding: 'utf8', windowsHide: true, timeout: 3000 })
      : spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8', timeout: 3000 });
    if (r.status === 0) path = r.stdout.split(/\r?\n/).find(Boolean)?.trim() || null;
  } catch { /* not found */ }
  found.set(name, { path, at: Date.now() });
  return path;
}

/**
 * Is this copy somewhere that disappears? `npx` runs packages from a cache that npm
 * clears, and agent configs and autostart point at this file, so they would break.
 */
export function installInfo(bin = BIN) {
  const p = bin.toLowerCase();
  const npx = p.includes(`${sep}_npx${sep}`.toLowerCase()) || p.includes('/_npx/');
  const temp = p.startsWith(tmpdir().toLowerCase());
  return { bin, ephemeral: npx || temp, reason: npx ? 'npx' : temp ? 'temp' : null };
}

// ------------------------------------------------------------------ autostart

function autostartTarget(homeArg) {
  const home = homeArg || homedir();
  if (process.platform === 'win32') {
    const appdata = homeArg ? join(home, 'AppData', 'Roaming') : process.env.APPDATA || join(home, 'AppData', 'Roaming');
    return { kind: 'startup-folder', file: join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Switchboard.vbs') };
  }
  if (process.platform === 'darwin') return { kind: 'launch-agent', file: join(home, 'Library', 'LaunchAgents', 'co.switchboard.daemon.plist') };
  return { kind: 'xdg-autostart', file: join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'autostart', 'switchboard.desktop') };
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function autostartFile(kind, { node, bin, env }) {
  if (kind === 'startup-folder') {
    // Window style 0: no console window. VBScript doubles quotes inside strings.
    const q = (s) => `""${s}""`;
    const sets = Object.entries(env).map(([k, v]) => `sh.Environment("Process")("${k}") = "${String(v).replace(/"/g, '""')}"\r\n`).join('');
    return `' Starts Switchboard when you sign in. Remove with: switchboard autostart off\r\nSet sh = CreateObject("WScript.Shell")\r\n${sets}sh.Run "${q(node)} ${q(bin)} start --background-child", 0, False\r\n`;
  }
  if (kind === 'launch-agent') {
    const envXml = Object.keys(env).length
      ? `  <key>EnvironmentVariables</key>\n  <dict>\n${Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n')}\n  </dict>\n`
      : '';
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>co.switchboard.daemon</string>
  <key>ProgramArguments</key>
  <array><string>${xml(node)}</string><string>${xml(bin)}</string><string>start</string><string>--background-child</string></array>
${envXml}  <key>RunAtLoad</key><true/>
</dict>
</plist>
`;
  }
  const envPrefix = Object.keys(env).length ? `env ${Object.entries(env).map(([k, v]) => `${k}="${v}"`).join(' ')} ` : '';
  return `[Desktop Entry]
Type=Application
Name=Switchboard
Comment=The attention router for your AI agents
Exec=${envPrefix}"${node}" "${bin}" start --background-child
NoDisplay=true
X-GNOME-Autostart-enabled=true
`;
}

export function autostartStatus({ home } = {}) {
  const t = autostartTarget(home);
  return { enabled: existsSync(t.file), file: t.file, kind: t.kind };
}

/** Start Switchboard when you sign in (or stop doing that). */
export function setAutostart(on, { home, node = process.execPath, bin = BIN, switchboardHome = process.env.SWITCHBOARD_HOME } = {}) {
  const t = autostartTarget(home);
  if (!on) {
    rmSync(t.file, { force: true });
    return { ...autostartStatus({ home }), message: 'Switchboard no longer starts when you sign in.' };
  }
  if (installInfo(bin).ephemeral) {
    throw Object.assign(new Error(`This copy of Switchboard runs from a temporary folder, so it can't start at login. Install it first: ${INSTALL_COMMAND}`), { status: 409 });
  }
  mkdirSync(dirname(t.file), { recursive: true });
  writeFileSync(t.file, autostartFile(t.kind, { node, bin, env: switchboardHome ? { SWITCHBOARD_HOME: switchboardHome } : {} }));
  return { ...autostartStatus({ home }), message: 'Switchboard will start in the background when you sign in.' };
}

// --------------------------------------------------------------------- doctor

/** Can this computer show desktop notifications? */
export function desktopNotifier() {
  if (process.platform === 'win32') {
    const ok = !!findCommand('powershell.exe');
    return { ok, how: 'Windows notifications', fix: ok ? null : 'PowerShell is missing, which Windows notifications need.' };
  }
  if (process.platform === 'darwin') return { ok: true, how: 'macOS Notification Center', fix: null };
  const ok = !!findCommand('notify-send');
  return { ok, how: 'notify-send', fix: ok ? null : 'Install libnotify (e.g. sudo apt install libnotify-bin), or use your phone instead.' };
}

/** The agent CLIs Switchboard uses to send your replies back. */
export function agentClis() {
  return {
    claude: { found: !!findCommand('claude'), install: 'npm install -g @anthropic-ai/claude-code' },
    codex: { found: !!findCommand('codex'), install: 'npm install -g @openai/codex' },
  };
}

/**
 * Everything `switchboard doctor` checks. Each check: {name, status: ok|warn|fail|info, detail, fix?}.
 * `daemon` is the /v1/health response (or null), `config` the daemon's /v1/config (or null).
 */
export function doctorChecks({ daemon, daemonUrl, config, integrations = [], home } = {}) {
  const checks = [];
  const add = (name, status, detail, fix) => checks.push({ name, status, detail, ...(fix ? { fix } : {}) });

  const major = Number(process.versions.node.split('.')[0]);
  add('Node.js', major >= 20 ? 'ok' : 'fail', `v${process.versions.node}`, major >= 20 ? null : 'Switchboard needs Node 20 or newer: https://nodejs.org');

  const inst = installInfo();
  add('Install', inst.ephemeral ? 'warn' : 'ok', inst.ephemeral ? 'running from a temporary npx folder' : inst.bin,
    inst.ephemeral ? `Fine for a try-out. To connect agents for good: ${INSTALL_COMMAND}` : null);

  add('Daemon', daemon ? 'ok' : 'fail', daemon ? `running at ${daemonUrl} (v${daemon.version})` : `not running at ${daemonUrl}`, daemon ? null : 'switchboard start');

  const auto = autostartStatus({ home });
  add('Start at login', auto.enabled ? 'ok' : 'info', auto.enabled ? 'on' : 'off', auto.enabled ? null : 'switchboard autostart on');

  const dn = desktopNotifier();
  const desktopOn = config?.config?.desktop !== false;
  add('Desktop notifications', !desktopOn ? 'info' : dn.ok ? 'ok' : 'warn', !desktopOn ? 'turned off in Settings' : dn.ok ? dn.how : 'not available', desktopOn ? dn.fix : null);

  const phone = config ? (config.telegram?.paired ? 'Telegram' : config.config?.ntfy?.topic ? 'ntfy' : null) : undefined;
  if (phone !== undefined) add('Phone', phone ? 'ok' : 'info', phone || 'not set up', phone ? null : 'Inbox → Connect → Your phone');

  const connected = integrations.filter((i) => i.connected);
  const waiting = integrations.filter((i) => i.detected && !i.connected);
  add('Agents', connected.length ? 'ok' : waiting.length ? 'warn' : 'info',
    connected.length ? `connected: ${connected.map((i) => i.name).join(', ')}` : waiting.length ? 'none connected yet' : 'no supported agents found on this computer',
    waiting.length ? `switchboard connect   (found: ${waiting.map((i) => i.name).join(', ')})` : null);

  const clis = agentClis();
  if (integrations.find((i) => i.id === 'claude-code')?.connected) {
    add('Reply to Claude Code', clis.claude.found ? 'ok' : 'info', clis.claude.found ? 'claude CLI found' : 'needs the claude CLI (questions still reach you; you answer in Claude)', clis.claude.found ? null : clis.claude.install);
  }
  if (integrations.find((i) => i.id === 'codex')?.connected) {
    add('Reply to Codex', clis.codex.found ? 'ok' : 'warn', clis.codex.found ? 'codex CLI found' : 'codex CLI not on PATH', clis.codex.found ? null : clis.codex.install);
  }
  return checks;
}
