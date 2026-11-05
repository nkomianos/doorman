// Client SDK: how agents (and the CLI, hooks, MCP server and proxy) talk to the daemon.
//
//   import { askHuman } from '@nkomianos/switchboard/client';
//   const { answer } = await askHuman({ question: 'Deploy?', options: ['Deploy', 'Wait'], default: 'Wait', deadline: '15m' });
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { switchboardHome, getToken, paths, readJSON } from './config.js';

const BIN = fileURLToPath(new URL('../bin/switchboard.js', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SwitchboardError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class SwitchboardClient {
  constructor({ url, token, home, agent, autostart = true } = {}) {
    this.home = home || switchboardHome();
    const daemon = readJSON(paths(this.home).daemon, null);
    this.url = (url || process.env.SWITCHBOARD_URL || daemon?.url || 'http://127.0.0.1:7777').replace(/\/+$/, '');
    this.token = token || process.env.SWITCHBOARD_TOKEN || null;
    this.agent = agent ?? (process.env.SWITCHBOARD_AGENT ? { id: process.env.SWITCHBOARD_AGENT, name: process.env.SWITCHBOARD_AGENT_NAME || process.env.SWITCHBOARD_AGENT } : null);
    this.autostart = autostart && !url && !process.env.SWITCHBOARD_URL;
  }

  _token() {
    if (!this.token) this.token = getToken(this.home);
    return this.token;
  }

  async request(method, path, body, { timeoutMs = 70000 } = {}) {
    let res;
    try {
      res = await fetch(`${this.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${this._token()}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new SwitchboardError(`cannot reach switchboard at ${this.url} (${err.cause?.code || err.message}). Start it with: switchboard start`, 0);
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new SwitchboardError(data.error || `HTTP ${res.status}`, res.status, data);
    return data;
  }

  async health() {
    try {
      const res = await fetch(`${this.url}/v1/health`, { signal: AbortSignal.timeout(1500) });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }

  /** Make sure a daemon is running; start one in the background if allowed. */
  async ensure() {
    if (await this.health()) return true;
    if (!this.autostart) return false;
    const child = spawn(process.execPath, [BIN, 'start', '--background-child'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, SWITCHBOARD_HOME: this.home },
    });
    child.unref();
    for (let i = 0; i < 40; i++) {
      await sleep(150);
      const d = readJSON(paths(this.home).daemon, null);
      if (d?.url) this.url = d.url;
      if (await this.health()) return true;
    }
    return false;
  }

  _withAgent(input) {
    return this.agent && !input.agent ? { ...input, agent: this.agent } : input;
  }

  /** Create an ask. Returns immediately with { id, status, ... }. */
  async submit(input) {
    await this.ensure();
    return this.request('POST', '/v1/asks', this._withAgent(input));
  }

  /** Wait for a final answer. Resolves with the answer view (status may still be open on timeout). */
  async wait(id, { timeoutMs = Infinity, signal } = {}) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      if (signal?.aborted) throw new SwitchboardError('aborted', 0);
      const left = end - Date.now();
      const slice = Math.max(1, Math.min(25, Math.ceil(left / 1000)));
      const view = await this.request('GET', `/v1/asks/${id}/wait?timeout=${slice}s`);
      if (view.final || Date.now() >= end) return view;
    }
  }

  /** Create an ask and block until it's resolved (or timeoutMs passes). */
  async ask(input, { timeoutMs = Infinity, signal } = {}) {
    const created = await this.submit(input);
    if (created.final) return created;
    return this.wait(created.id, { timeoutMs, signal });
  }

  notify(message, opts = {}) {
    return this.submit({ kind: 'inform', question: message, ...opts });
  }

  async state() {
    await this.ensure();
    return this.request('GET', '/v1/state');
  }

  cancel(id, reason) {
    return this.request('DELETE', `/v1/asks/${id}${reason ? `?reason=${encodeURIComponent(reason)}` : ''}`);
  }
}

/** opts: client options ({ url, token, agent, ... }) plus { timeoutMs }. */
export function askHuman(input, opts = {}) {
  return new SwitchboardClient(opts).ask(input, opts);
}

export function notifyHuman(message, input = {}, opts = {}) {
  return new SwitchboardClient(opts).notify(message, input);
}

export function getHumanState(opts = {}) {
  return new SwitchboardClient(opts).state();
}

export const daemonInfo = (home = switchboardHome()) => (existsSync(paths(home).daemon) ? readJSON(paths(home).daemon, null) : null);
