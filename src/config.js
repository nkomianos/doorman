// Where Switchboard keeps its files, and the user's settings.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ROUTER_CONFIG } from './router.js';
import { randomToken } from './util.js';

export const VERSION = '0.1.0';

export const DEFAULT_CONFIG = {
  port: 7777,
  ...DEFAULT_ROUTER_CONFIG,
  desktop: true,
  // { server: "https://ntfy.sh", topic: "<secret>", token?: "...", redact: false, mirror: "always" | "away" }
  ntfy: null,
  // { token: "<bot token from @BotFather>", chatId, userId, mirror: "always" | "away", redact: false }
  telegram: null,
  // Opt-in: keyboard/mouse idle time and the name of the app in front. Never window titles.
  activity: { enabled: false, awayAfterMinutes: 10, meetings: true, editorFocus: false },
  // Show what Claude Code / Codex sessions are doing, read from their own logs on this machine.
  sessions: true,
  // Cloud agents (Grok, the Muse app…) reach /mcp through a tunnel with an agent key. Off by default.
  remote: { enabled: false, url: null },
  hookWaitSeconds: 600,
};

// Settings the inbox UI / PATCH /v1/config may change.
export const EDITABLE_KEYS = ['quietHours', 'calendar', 'digest', 'ntfy', 'telegram', 'activity', 'sessions', 'remote', 'desktop', 'bundleWindowMs', 'learnThreshold', 'hookWaitSeconds'];

export function switchboardHome() {
  if (process.env.SWITCHBOARD_HOME) return process.env.SWITCHBOARD_HOME;
  const home = join(homedir(), '.switchboard');
  // Switchboard used to be called Doorman: carry your inbox, rules, keys and token over once.
  const legacy = join(homedir(), '.doorman');
  if (!existsSync(home) && existsSync(legacy)) {
    try {
      renameSync(legacy, home);
      for (const old of ['doorman-url.vbs', 'doorman-icon-2.png', 'daemon.json']) rmSync(join(home, old), { force: true });
    } catch { /* in use: try again next start */ }
  }
  return home;
}

export function paths(home = switchboardHome()) {
  return {
    home,
    config: join(home, 'config.json'),
    rules: join(home, 'rules.json'),
    state: join(home, 'state.json'),
    ledger: join(home, 'ledger.jsonl'),
    token: join(home, 'token'),
    daemon: join(home, 'daemon.json'),
    keys: join(home, 'keys.json'),
    log: join(home, 'daemon.log'),
  };
}

export function ensureHome(home = switchboardHome()) {
  mkdirSync(home, { recursive: true });
  return paths(home);
}

export function readJSON(file, fallback) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
}

/** Atomic write: never leave a half-written file behind. */
export function writeJSON(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

export function loadConfig(home = switchboardHome(), overrides = {}) {
  const p = ensureHome(home);
  const user = readJSON(p.config, {});
  return { ...DEFAULT_CONFIG, ...user, ...overrides, budget: { ...DEFAULT_CONFIG.budget, ...user.budget, ...overrides.budget } };
}

export function saveUserConfig(home, patch) {
  const p = ensureHome(home);
  const user = readJSON(p.config, {});
  for (const k of EDITABLE_KEYS) if (k in patch) user[k] = patch[k];
  writeJSON(p.config, user);
  return user;
}

export function getToken(home = switchboardHome()) {
  const p = ensureHome(home);
  if (existsSync(p.token)) return readFileSync(p.token, 'utf8').trim();
  const token = randomToken();
  writeFileSync(p.token, token, { mode: 0o600 });
  return token;
}
