// Where Doorman keeps its files, and the user's settings.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
  hookWaitSeconds: 600,
};

// Settings the inbox UI / PATCH /v1/config may change.
export const EDITABLE_KEYS = ['quietHours', 'calendar', 'digest', 'ntfy', 'desktop', 'bundleWindowMs', 'learnThreshold', 'hookWaitSeconds'];

export function doormanHome() {
  return process.env.DOORMAN_HOME || join(homedir(), '.doorman');
}

export function paths(home = doormanHome()) {
  return {
    home,
    config: join(home, 'config.json'),
    rules: join(home, 'rules.json'),
    state: join(home, 'state.json'),
    ledger: join(home, 'ledger.jsonl'),
    token: join(home, 'token'),
    daemon: join(home, 'daemon.json'),
    log: join(home, 'daemon.log'),
  };
}

export function ensureHome(home = doormanHome()) {
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

export function loadConfig(home = doormanHome(), overrides = {}) {
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

export function getToken(home = doormanHome()) {
  const p = ensureHome(home);
  if (existsSync(p.token)) return readFileSync(p.token, 'utf8').trim();
  const token = randomToken();
  writeFileSync(p.token, token, { mode: 0o600 });
  return token;
}
