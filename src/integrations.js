// One-click connect for the agents people actually run. Each integration knows
// where its config lives, whether it's installed, whether Switchboard is wired in,
// and how to add or remove exactly Switchboard's entries (with a backup first).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BIN = fileURLToPath(new URL('../bin/switchboard.js', import.meta.url));
const SELF = `node "${BIN}"`;
const MARK = 'hook claude-code';

const readJSONFile = (file) => {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8').trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw Object.assign(new Error(`${file} isn't valid JSON, so Switchboard won't touch it. Fix it or add the snippet by hand.`), { status: 409 }); }
};
const backup = (file) => { if (existsSync(file)) copyFileSync(file, `${file}.switchboard-bak`); };
const writeFile = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };

function claudeDesktopConfig(home) {
  if (process.platform === 'win32') return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

// Codex's `notify` is a single-line array of strings. JSON arrays of strings are valid TOML.
const OUR_NOTIFY = ['node', BIN, 'hook', 'codex'];
const notifyLine = (list) => `notify = ${JSON.stringify(list)}`;
const isOurNotify = (list) => list.includes('hook') && list.includes('codex') && list.some((x) => /switchboard\.js$/.test(String(x)));
function readNotify(text) {
  const m = /^[ \t]*notify[ \t]*=[ \t]*(.*)$/m.exec(text);
  if (!m) return null;
  try {
    const list = JSON.parse(m[1].trim());
    return { line: m[0], list: Array.isArray(list) && list.every((x) => typeof x === 'string') ? list : null };
  } catch {
    return { line: m[0], list: null };
  }
}

const getPath = (obj, path) => path.reduce((o, k) => o?.[k], obj);
function setPath(obj, path, value) {
  let o = obj;
  for (const k of path.slice(0, -1)) o = o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {};
  o[path.at(-1)] = value;
}
const nest = (path, value) => path.reduceRight((v, k) => ({ [k]: v }), value);

/** An MCP client configured through a JSON file with a map of servers at `path`. */
function mcpJsonIntegration({ id, name, description, file, dir, path = ['mcpServers'], entry = { command: 'node', args: [BIN, 'mcp'] }, init = {}, reload, extra = null, extraLabel = null }) {
  return {
    id,
    name,
    description,
    file,
    extra,
    extraLabel,
    detected: () => existsSync(dir),
    connected: () => { try { return !!getPath(readJSONFile(file), path)?.switchboard; } catch { return false; } },
    snippet: () => JSON.stringify(nest(path, { switchboard: entry }), null, 2),
    connect() {
      const cur = { ...init, ...readJSONFile(file) };
      backup(file);
      setPath(cur, path, { ...(getPath(cur, path) || {}), switchboard: entry });
      writeFile(file, JSON.stringify(cur, null, 2));
      return `Added the switchboard MCP server to ${file}. ${reload || `Restart ${name} to load it.`}`;
    },
    disconnect() {
      const cur = readJSONFile(file);
      const servers = getPath(cur, path);
      if (!servers?.switchboard) return 'Not connected';
      backup(file);
      delete servers.switchboard;
      writeFile(file, JSON.stringify(cur, null, 2));
      return `Removed switchboard from ${file}.`;
    },
  };
}

/**
 * Hermes keeps MCP servers in YAML. We don't parse YAML (no dependency for one file):
 * we add or remove exactly our own three-line block under `mcp_servers:`.
 */
function hermesIntegration(home) {
  const file = join(home, '.hermes', 'config.yaml');
  const block = (indent) => `${indent}switchboard:\n${indent}${indent}command: "node"\n${indent}${indent}args: [${JSON.stringify(BIN)}, "mcp"]\n`;
  const MARKER = /^[ \t]+switchboard:[ \t]*\r?\n[ \t]+command: "node"[ \t]*\r?\n[ \t]+args: \[[^\]\n]*switchboard\.js[^\]\n]*\][ \t]*\r?\n?/m;
  return {
    id: 'hermes',
    name: 'Hermes Agent',
    description: 'Nous Research’s agent gets ask_human, notify_human and get_human_state, in the terminal and in its messaging gateway.',
    file,
    detected: () => existsSync(join(home, '.hermes')),
    connected: () => existsSync(file) && MARKER.test(readFileSync(file, 'utf8')),
    snippet: () => `mcp_servers:\n${block('  ')}`,
    extra: '/reload-mcp',
    extraLabel: 'Then, inside Hermes:',
    connect() {
      let text = existsSync(file) ? readFileSync(file, 'utf8') : '';
      if (MARKER.test(text)) return 'Already connected.';
      backup(file);
      const head = /^mcp_servers:[ \t]*(\{\s*\})?[ \t]*$/m.exec(text);
      if (!head) text = `${text.trimEnd()}${text.trim() ? '\n\n' : ''}mcp_servers:\n${block('  ')}`;
      else {
        const after = text.slice(head.index + head[0].length + 1);
        const indent = (/^([ \t]+)\S/m.exec(after) || [])[1] || '  ';
        const insertAt = head.index + head[0].length;
        text = `${text.slice(0, head.index)}mcp_servers:\n${block(indent)}${text.slice(insertAt + 1)}`;
      }
      writeFile(file, text);
      return 'Added switchboard to ~/.hermes/config.yaml. Run /reload-mcp in Hermes (the gateway picks it up within a minute).';
    },
    disconnect() {
      if (!existsSync(file)) return 'Not connected';
      const text = readFileSync(file, 'utf8');
      if (!MARKER.test(text)) return 'Not connected';
      backup(file);
      writeFile(file, text.replace(MARKER, ''));
      return 'Removed switchboard from ~/.hermes/config.yaml.';
    },
  };
}

export function integrations({ home = homedir(), hookWaitSeconds = 600 } = {}) {
  const claudeSettings = join(home, '.claude', 'settings.json');
  const codexConfig = join(home, '.codex', 'config.toml');
  const hook = (timeout) => [{ hooks: [{ type: 'command', command: `${SELF} hook claude-code`, timeout }] }];
  const claudeHooks = { PermissionRequest: hook(hookWaitSeconds + 60), Notification: hook(15), Stop: hook(15) };
  const codexNotify = notifyLine(OUR_NOTIFY);
  const codexMcp = `[mcp_servers.switchboard]\ncommand = "node"\nargs = [${JSON.stringify(BIN)}, "mcp"]`;

  return [
    {
      id: 'claude-code',
      name: 'Claude Code',
      description: 'Permission prompts become one-tap decisions here and on your phone. “Done” and “needs you” messages arrive as updates.',
      file: claudeSettings,
      detected: () => existsSync(join(home, '.claude')),
      connected: () => { try { return JSON.stringify(readJSONFile(claudeSettings).hooks || {}).includes(MARK); } catch { return false; } },
      snippet: () => JSON.stringify({ hooks: claudeHooks }, null, 2),
      extra: `claude mcp add switchboard -- node "${BIN}" mcp`,
      extraLabel: 'Optional, for an ask_human tool mid-task:',
      connect() {
        const cur = readJSONFile(claudeSettings);
        backup(claudeSettings);
        cur.hooks = cur.hooks || {};
        for (const [ev, entries] of Object.entries(claudeHooks)) {
          cur.hooks[ev] = [...(cur.hooks[ev] || []).filter((e) => !JSON.stringify(e).includes(MARK)), ...entries];
        }
        writeFile(claudeSettings, JSON.stringify(cur, null, 2));
        return 'Added Switchboard hooks to ~/.claude/settings.json. New Claude Code sessions use them right away.';
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
        return 'Removed Switchboard hooks from ~/.claude/settings.json.';
      },
    },
    {
      id: 'codex',
      name: 'Codex',
      description: 'Turn-complete messages arrive as updates, and Codex gets an ask_human tool for questions mid-task.',
      file: codexConfig,
      detected: () => existsSync(join(home, '.codex')),
      connected: () => existsSync(codexConfig) && readFileSync(codexConfig, 'utf8').includes('[mcp_servers.switchboard]'),
      snippet: () => `${codexNotify}\n\n${codexMcp}`,
      connect() {
        let text = existsSync(codexConfig) ? readFileSync(codexConfig, 'utf8') : '';
        backup(codexConfig);
        const notes = [];
        const current = readNotify(text);
        if (!current) {
          // TOML: top-level keys must come before the first [table].
          const firstTable = text.search(/^\s*\[/m);
          text = firstTable === -1 ? `${codexNotify}\n${text}` : `${text.slice(0, firstTable)}${codexNotify}\n\n${text.slice(firstTable)}`;
        } else if (!current.list) {
          notes.push('Couldn’t read your existing notify setting, so turn-complete updates were not added.');
        } else if (!isOurNotify(current.list)) {
          // Codex allows one notify program. Keep yours: Switchboard passes every event on to it.
          text = text.replace(current.line, notifyLine([...OUR_NOTIFY, '--', ...current.list]));
          notes.push('Your existing notify program keeps working: Switchboard passes each event on to it.');
        }
        if (!text.includes('[mcp_servers.switchboard]')) text = `${text.trimEnd()}\n\n${codexMcp}\n`;
        writeFile(codexConfig, text);
        return ['Connected Codex in ~/.codex/config.toml.', ...notes].join(' ');
      },
      disconnect() {
        if (!existsSync(codexConfig)) return 'Not connected';
        backup(codexConfig);
        let text = readFileSync(codexConfig, 'utf8');
        const current = readNotify(text);
        if (current?.list && isOurNotify(current.list)) {
          const i = current.list.indexOf('--');
          // Put back whatever notify program you had before, or remove ours.
          text = i >= 0 ? text.replace(current.line, notifyLine(current.list.slice(i + 1))) : text.replace(`${current.line}\n`, '').replace(current.line, '');
        }
        text = text.replace(/\n*\[mcp_servers\.switchboard\]\ncommand = "node"\nargs = \[[^\]]*\]\n?/, '\n');
        writeFile(codexConfig, text);
        return 'Removed Switchboard from ~/.codex/config.toml.';
      },
    },
    mcpJsonIntegration({ id: 'cursor', name: 'Cursor', description: 'Gives Cursor’s agent ask_human, notify_human and get_human_state tools.', file: join(home, '.cursor', 'mcp.json'), dir: join(home, '.cursor') }),
    mcpJsonIntegration({ id: 'claude-desktop', name: 'Claude Desktop', description: 'Lets Claude ask you a question or send you an update through Switchboard while it works.', file: claudeDesktopConfig(home), dir: dirname(claudeDesktopConfig(home)) }),
    mcpJsonIntegration({
      id: 'openclaw',
      name: 'OpenClaw',
      description: 'Your always-on OpenClaw agent asks before it acts, and reports back, through Switchboard instead of your chat apps.',
      file: join(home, '.openclaw', 'openclaw.json'),
      dir: join(home, '.openclaw'),
      path: ['mcp', 'servers'],
      reload: 'Start a new OpenClaw session, or run: openclaw mcp reload',
      extra: `openclaw mcp add switchboard --command node --arg "${BIN}" --arg mcp`,
      extraLabel: 'Or add it with the OpenClaw CLI:',
    }),
    hermesIntegration(home),
    mcpJsonIntegration({
      id: 'muse-code',
      name: 'Muse Code',
      description: 'Meta’s terminal coding agent gets ask_human and notify_human. Marked optional, so Muse keeps working if Switchboard is off.',
      file: join(home, '.config', 'muse', 'settings.json'),
      dir: join(home, '.config', 'muse'),
      path: ['mcp_servers'],
      entry: { command: 'node', args: [BIN, 'mcp'], mode: 'optional' },
      init: { schema_version: 1 },
      reload: 'Restart Muse Code, then check with /mcp.',
    }),
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
    extraLabel: i.extraLabel || null,
  }));
}

export function setIntegration(id, on, opts) {
  const i = integrations(opts).find((x) => x.id === id);
  if (!i) throw Object.assign(new Error(`no integration ${id}`), { status: 404 });
  const message = on ? i.connect() : i.disconnect();
  return { message, integration: listIntegrations(opts).find((x) => x.id === id) };
}
