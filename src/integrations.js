// One-click connect for the agents people actually run. Each integration knows
// where its config lives, whether it's installed, whether Doorman is wired in,
// and how to add or remove exactly Doorman's entries (with a backup first).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BIN = fileURLToPath(new URL('../bin/doorman.js', import.meta.url));
const SELF = `node "${BIN}"`;
const MARK = 'hook claude-code';

const readJSONFile = (file) => {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8').trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw Object.assign(new Error(`${file} isn't valid JSON, so Doorman won't touch it. Fix it or add the snippet by hand.`), { status: 409 }); }
};
const backup = (file) => { if (existsSync(file)) copyFileSync(file, `${file}.doorman-bak`); };
const writeFile = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };

function claudeDesktopConfig(home) {
  if (process.platform === 'win32') return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

/** An MCP client configured through a JSON file with an `mcpServers` map. */
function mcpJsonIntegration({ id, name, description, file, dir }) {
  return {
    id,
    name,
    description,
    file,
    detected: () => existsSync(dir),
    connected: () => { try { return !!readJSONFile(file).mcpServers?.doorman; } catch { return false; } },
    snippet: () => JSON.stringify({ mcpServers: { doorman: { command: 'node', args: [BIN, 'mcp'] } } }, null, 2),
    connect() {
      const cur = readJSONFile(file);
      backup(file);
      cur.mcpServers = { ...(cur.mcpServers || {}), doorman: { command: 'node', args: [BIN, 'mcp'] } };
      writeFile(file, JSON.stringify(cur, null, 2));
      return `Added the doorman MCP server to ${file}. Restart ${name} to load it.`;
    },
    disconnect() {
      const cur = readJSONFile(file);
      if (!cur.mcpServers?.doorman) return 'Not connected';
      backup(file);
      delete cur.mcpServers.doorman;
      writeFile(file, JSON.stringify(cur, null, 2));
      return `Removed doorman from ${file}.`;
    },
  };
}

export function integrations({ home = homedir(), hookWaitSeconds = 600 } = {}) {
  const claudeSettings = join(home, '.claude', 'settings.json');
  const codexConfig = join(home, '.codex', 'config.toml');
  const hook = (timeout) => [{ hooks: [{ type: 'command', command: `${SELF} hook claude-code`, timeout }] }];
  const claudeHooks = { PermissionRequest: hook(hookWaitSeconds + 60), Notification: hook(15), Stop: hook(15) };
  const codexNotify = `notify = ["node", ${JSON.stringify(BIN)}, "hook", "codex"]`;
  const codexMcp = `[mcp_servers.doorman]\ncommand = "node"\nargs = [${JSON.stringify(BIN)}, "mcp"]`;

  return [
    {
      id: 'claude-code',
      name: 'Claude Code',
      description: 'Permission prompts become one-tap decisions here and on your phone. “Done” and “needs you” messages arrive as updates.',
      file: claudeSettings,
      detected: () => existsSync(join(home, '.claude')),
      connected: () => { try { return JSON.stringify(readJSONFile(claudeSettings).hooks || {}).includes(MARK); } catch { return false; } },
      snippet: () => JSON.stringify({ hooks: claudeHooks }, null, 2),
      extra: `claude mcp add doorman -- node "${BIN}" mcp`,
      connect() {
        const cur = readJSONFile(claudeSettings);
        backup(claudeSettings);
        cur.hooks = cur.hooks || {};
        for (const [ev, entries] of Object.entries(claudeHooks)) {
          cur.hooks[ev] = [...(cur.hooks[ev] || []).filter((e) => !JSON.stringify(e).includes(MARK)), ...entries];
        }
        writeFile(claudeSettings, JSON.stringify(cur, null, 2));
        return 'Added Doorman hooks to ~/.claude/settings.json. New Claude Code sessions use them right away.';
      },
      disconnect() {
        const cur = readJSONFile(claudeSettings);
        if (!cur.hooks) return 'Not connected';
        backup(claudeSettings);
        for (const ev of Object.keys(cur.hooks)) {
          cur.hooks[ev] = cur.hooks[ev].filter((e) => !JSON.stringify(e).includes(MARK));
          if (!cur.hooks[ev].length) delete cur.hooks[ev];
        }
        writeFile(claudeSettings, JSON.stringify(cur, null, 2));
        return 'Removed Doorman hooks from ~/.claude/settings.json.';
      },
    },
    {
      id: 'codex',
      name: 'Codex',
      description: 'Turn-complete messages arrive as updates, and Codex gets an ask_human tool for questions mid-task.',
      file: codexConfig,
      detected: () => existsSync(join(home, '.codex')),
      connected: () => existsSync(codexConfig) && readFileSync(codexConfig, 'utf8').includes('[mcp_servers.doorman]'),
      snippet: () => `${codexNotify}\n\n${codexMcp}`,
      connect() {
        let text = existsSync(codexConfig) ? readFileSync(codexConfig, 'utf8') : '';
        backup(codexConfig);
        const notes = [];
        // TOML: top-level keys must come before the first [table].
        if (!/^\s*notify\s*=/m.test(text)) {
          const firstTable = text.search(/^\s*\[/m);
          text = firstTable === -1 ? `${codexNotify}\n${text}` : `${text.slice(0, firstTable)}${codexNotify}\n\n${text.slice(firstTable)}`;
        } else if (!text.includes('"hook", "codex"')) notes.push('You already have a notify command, so turn-complete updates were not added.');
        if (!text.includes('[mcp_servers.doorman]')) text = `${text.trimEnd()}\n\n${codexMcp}\n`;
        writeFile(codexConfig, text);
        return ['Connected Codex in ~/.codex/config.toml.', ...notes].join(' ');
      },
      disconnect() {
        if (!existsSync(codexConfig)) return 'Not connected';
        backup(codexConfig);
        let text = readFileSync(codexConfig, 'utf8');
        text = text.split('\n').filter((l) => !(l.trim().startsWith('notify') && l.includes('"hook", "codex"'))).join('\n');
        text = text.replace(/\n*\[mcp_servers\.doorman\]\ncommand = "node"\nargs = \[[^\]]*\]\n?/, '\n');
        writeFile(codexConfig, text);
        return 'Removed Doorman from ~/.codex/config.toml.';
      },
    },
    mcpJsonIntegration({ id: 'cursor', name: 'Cursor', description: 'Gives Cursor’s agent ask_human, notify_human and get_human_state tools.', file: join(home, '.cursor', 'mcp.json'), dir: join(home, '.cursor') }),
    mcpJsonIntegration({ id: 'claude-desktop', name: 'Claude Desktop', description: 'Lets Claude ask you a question or send you an update through Doorman while it works.', file: claudeDesktopConfig(home), dir: dirname(claudeDesktopConfig(home)) }),
  ];
}

export function listIntegrations(opts) {
  return integrations(opts).map((i) => ({
    id: i.id,
    name: i.name,
    description: i.description,
    file: i.file,
    detected: i.detected(),
    connected: i.connected(),
    snippet: i.snippet(),
    extra: i.extra || null,
  }));
}

export function setIntegration(id, on, opts) {
  const i = integrations(opts).find((x) => x.id === id);
  if (!i) throw Object.assign(new Error(`no integration ${id}`), { status: 404 });
  const message = on ? i.connect() : i.disconnect();
  return { message, integration: listIntegrations(opts).find((x) => x.id === id) };
}
