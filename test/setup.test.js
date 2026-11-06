// First-run experience: install detection, start at login, `connect`, `doctor`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { HOOK_CEILING_SECONDS, listIntegrations, setIntegration } from '../src/integrations.js';
import { autostartStatus, doctorChecks, installInfo, setAutostart } from '../src/system.js';

const tmp = (name) => mkdtempSync(join(tmpdir(), `switchboard-${name}-`));
const BIN = fileURLToPath(new URL('../bin/switchboard.js', import.meta.url));
const NPX_BIN = join('/home/me/.npm/_npx/1a2b3c/node_modules/@nkomianos/switchboard/bin/switchboard.js');

describe('install and start at login', () => {
  test('a copy run by npx counts as temporary; a normal install does not', () => {
    assert.equal(installInfo(NPX_BIN).ephemeral, true);
    assert.equal(installInfo(NPX_BIN.replace(/\//g, '\\')).ephemeral, true);
    assert.equal(installInfo('/usr/local/lib/node_modules/@nkomianos/switchboard/bin/switchboard.js').ephemeral, false);
  });

  test('autostart writes one file for this OS and removes it again', () => {
    const home = tmp('auto');
    assert.equal(autostartStatus({ home }).enabled, false);
    const on = setAutostart(true, { home, node: '/usr/bin/node', bin: '/opt/switchboard/bin/switchboard.js' });
    assert.equal(on.enabled, true);
    const text = readFileSync(on.file, 'utf8');
    assert.match(text, /switchboard\.js/);
    assert.match(text, /start --background-child|<string>--background-child<\/string>/);
    assert.equal(setAutostart(false, { home }).enabled, false);
    assert.equal(existsSync(on.file), false);
  });

  test('a temporary copy refuses to set up autostart or connect agents', () => {
    const home = tmp('npx');
    mkdirSync(join(home, '.codex'));
    assert.throws(() => setAutostart(true, { home, bin: NPX_BIN }), /temporary folder/);
    assert.throws(() => setIntegration('codex', true, { home, bin: NPX_BIN }), /npm install -g/);
    assert.equal(listIntegrations({ home }).find((i) => i.id === 'codex').connected, false);
  });

  test('the permission hook timeout is only a ceiling; the wait comes from settings', () => {
    const snippet = JSON.parse(listIntegrations({ home: tmp('hook') }).find((i) => i.id === 'claude-code').snippet);
    assert.equal(snippet.hooks.PermissionRequest[0].hooks[0].timeout, HOOK_CEILING_SECONDS);
  });
});

describe('doctor', () => {
  test('flags a stopped daemon as the one failure and suggests connecting found agents', () => {
    const checks = doctorChecks({
      daemon: null,
      daemonUrl: 'http://127.0.0.1:7777',
      config: null,
      integrations: [{ id: 'codex', name: 'Codex', detected: true, connected: false }],
      home: tmp('doc'),
    });
    const by = Object.fromEntries(checks.map((c) => [c.name, c]));
    assert.equal(by.Daemon.status, 'fail');
    assert.equal(by.Daemon.fix, 'switchboard start');
    assert.equal(by.Agents.status, 'warn');
    assert.match(by.Agents.fix, /switchboard connect/);
    assert.equal(by['Start at login'].status, 'info');
    assert.equal(checks.filter((c) => c.status === 'fail').length, 1);
  });
});

describe('switchboard connect (CLI)', () => {
  const run = (args, env) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 20000 });

  test('connects every agent it finds, then disconnects them', () => {
    const agentHome = tmp('cli');
    mkdirSync(join(agentHome, '.claude'));
    mkdirSync(join(agentHome, '.codex'));
    const env = { SWITCHBOARD_AGENT_HOME: agentHome, SWITCHBOARD_HOME: tmp('cli-home') };
    const on = run(['connect'], env);
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stdout, /Claude Code/);
    assert.match(on.stdout, /Codex/);
    assert.match(readFileSync(join(agentHome, '.claude', 'settings.json'), 'utf8'), /hook claude-code/);
    assert.match(readFileSync(join(agentHome, '.codex', 'config.toml'), 'utf8'), /mcp_servers\.switchboard/);
    assert.match(run(['connect'], env).stdout, /Already connected/);
    const off = run(['disconnect'], env);
    assert.equal(off.status, 0, off.stderr);
    assert.equal(listIntegrations({ home: agentHome }).some((i) => i.connected), false);
  });

  test('says so when nothing supported is installed', () => {
    const r = run(['connect'], { SWITCHBOARD_AGENT_HOME: tmp('none'), SWITCHBOARD_HOME: tmp('none-home') });
    assert.match(r.stdout, /No supported agents found/);
  });
});
