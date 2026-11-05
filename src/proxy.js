// `switchboard proxy -- <mcp server command>`: sits between an MCP client (Claude Code,
// Cursor, ...) and a stdio MCP server. Without any change to either side it:
//   * routes the server's elicitation requests to Switchboard instead of the client UI
//   * gates tool calls matching --gate patterns behind your approval
// Everything else passes through byte-for-byte (one JSON-RPC message per line).
import { spawn } from 'node:child_process';
import { SwitchboardClient } from './client.js';
import { matchGlob, slug, truncate } from './util.js';

function lineReader(stream, onLine) {
  let buf = '';
  stream.setEncoding?.('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  });
}

function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return null;
  const parts = Object.entries(args).slice(0, 4).map(([k, v]) => `${k}=${truncate(typeof v === 'string' ? v : JSON.stringify(v), 40)}`);
  return parts.join(', ') || null;
}

/** Map an MCP elicitation/create request onto a Switchboard ask, plus how to map the answer back. */
export function elicitationToAsk(params, { agent, serverName, deadline }) {
  const base = {
    agent,
    question: truncate(params.message || `${serverName} needs input`, 300),
    deadline,
    thread: `mcp:${serverName}`,
    tags: ['mcp', 'elicitation'],
    fingerprint: `mcp:${serverName}:elicit:${truncate(params.message || '', 80)}`,
  };
  if (params.mode === 'url') {
    return {
      map: { type: 'url' },
      ask: { ...base, kind: 'decision', options: [{ id: 'accept', label: 'Done', style: 'primary' }, { id: 'decline', label: 'Decline' }], default: 'decline', detail: { line: params.url, paragraph: `Open this link to continue: ${params.url}`, full: params.url } },
    };
  }
  const schema = params.requestedSchema || { type: 'object', properties: {} };
  const props = schema.properties || {};
  const keys = Object.keys(props);
  const decline = { id: 'decline', label: 'Decline' };
  if (keys.length === 0) {
    return { map: { type: 'empty' }, ask: { ...base, kind: 'decision', options: [{ id: 'accept', label: 'Accept', style: 'primary' }, decline] } };
  }
  if (keys.length === 1) {
    const k = keys[0];
    const p = props[k];
    if (p.type === 'boolean') {
      return { map: { type: 'bool', key: k }, ask: { ...base, kind: 'decision', options: [{ id: 'yes', label: p.title || 'Yes', style: 'primary' }, { id: 'no', label: 'No' }, decline] } };
    }
    const values = p.enum || p.oneOf?.map((o) => o.const) || p.items?.enum;
    if (values && values.length <= 7 && p.type !== 'array') {
      const names = p.enumNames || p.oneOf?.map((o) => o.title) || [];
      const options = values.map((v, i) => ({ id: `v${i}`, label: String(names[i] ?? v) }));
      return { map: { type: 'enum', key: k, values }, ask: { ...base, kind: 'decision', options: [...options, decline] } };
    }
    if (p.type === 'string' && !values) {
      return { map: { type: 'text', key: k }, ask: { ...base, kind: 'input', input: { type: 'text', placeholder: p.description || p.title || k }, options: [decline] } };
    }
  }
  return { map: { type: 'form', schema }, ask: { ...base, kind: 'input', input: { schema }, options: [decline] } };
}

export function answerToElicitResult(view, map) {
  const a = view.answer;
  if (view.status === 'expired' || view.status === 'cancelled') return { action: 'cancel' };
  if (!a || a.option === 'decline' || (view.status === 'dismissed' && !a.option)) return { action: 'decline' };
  switch (map.type) {
    case 'url':
    case 'empty':
      return a.option === 'accept' ? { action: 'accept', content: {} } : { action: 'decline' };
    case 'bool':
      return { action: 'accept', content: { [map.key]: a.option === 'yes' } };
    case 'enum': {
      const i = Number(String(a.option).slice(1));
      return { action: 'accept', content: { [map.key]: map.values[i] } };
    }
    case 'text':
      return a.text == null ? { action: 'decline' } : { action: 'accept', content: { [map.key]: a.text } };
    default: {
      const content = {};
      const props = map.schema.properties || {};
      for (const [k, v] of Object.entries(a.values || {})) {
        const t = props[k]?.type;
        if (v === '' || v == null) continue;
        content[k] = t === 'number' || t === 'integer' ? Number(v) : t === 'boolean' ? v === true || v === 'true' : v;
      }
      return { action: 'accept', content };
    }
  }
}

export function runProxy({
  command,
  args = [],
  name,
  gates = [],
  routeElicitation = true,
  gateTimeout = '10m',
  elicitTimeout = '10m',
  client = new SwitchboardClient(),
  input = process.stdin,
  output = process.stdout,
  log = (m) => process.stderr.write(`[switchboard proxy] ${m}\n`),
}) {
  const serverName = name || slug(command.split(/[\\/]/).pop());
  const child = process.platform === 'win32'
    ? spawn([command, ...args].map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' '), { stdio: ['pipe', 'pipe', 'inherit'], shell: true })
    : spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  let clientName = 'mcp-client';
  const agent = () => ({ id: slug(clientName), name: clientName });
  const toClient = (msg) => output.write(`${JSON.stringify(msg)}\n`);
  const toServer = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const gatedCalls = new Map(); // client request id -> ask id
  const elicits = new Map(); // server request id -> ask id

  async function gate(msg) {
    const tool = msg.params?.name;
    try {
      const created = await client.submit({
        agent: agent(),
        kind: 'decision',
        question: truncate(`Allow ${clientName} to run ${tool} on ${serverName}?`, 300),
        options: [{ id: 'allow', label: 'Allow', style: 'primary' }, { id: 'deny', label: 'Deny', style: 'danger' }],
        default: 'deny',
        deadline: gateTimeout,
        detail: { line: summarizeArgs(msg.params?.arguments), full: JSON.stringify(msg.params?.arguments ?? {}, null, 2) },
        fingerprint: `mcp:${serverName}:${tool}`,
        thread: `mcp:${serverName}`,
        tags: ['mcp', 'tool-gate'],
      });
      gatedCalls.set(msg.id, created.id);
      const view = created.final ? created : await client.wait(created.id);
      gatedCalls.delete(msg.id);
      if (view.status === 'cancelled') return;
      if (view.answer?.option === 'allow') return toServer(msg);
      const why = view.status === 'answered' ? 'the human denied it' : view.status === 'auto' ? 'a rule denied it' : `no approval (${view.status})`;
      toClient({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `Switchboard blocked this call to ${tool}: ${why}. Do not retry without asking.` }], isError: true } });
    } catch (err) {
      log(`gate failed (${err.message}); denying ${tool}`);
      toClient({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `Switchboard could not get approval for ${tool}: ${err.message}` }], isError: true } });
    }
  }

  async function elicit(msg) {
    const { ask, map } = elicitationToAsk(msg.params || {}, { agent: agent(), serverName, deadline: elicitTimeout });
    try {
      const created = await client.submit(ask);
      elicits.set(msg.id, created.id);
      const view = created.final ? created : await client.wait(created.id);
      elicits.delete(msg.id);
      toServer({ jsonrpc: '2.0', id: msg.id, result: answerToElicitResult(view, map) });
    } catch (err) {
      log(`elicitation failed: ${err.message}`);
      toServer({ jsonrpc: '2.0', id: msg.id, result: { action: 'cancel' } });
    }
  }

  lineReader(input, (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { child.stdin.write(`${line}\n`); return; }
    if (msg.method === 'initialize' && msg.params) {
      clientName = msg.params.clientInfo?.name || clientName;
      if (routeElicitation) {
        msg.params.capabilities = { ...msg.params.capabilities, elicitation: { ...(msg.params.capabilities?.elicitation || {}), form: {}, url: {} } };
      }
    }
    if (msg.method === 'tools/call' && msg.id != null && gates.some((g) => matchGlob(g, msg.params?.name))) {
      gate(msg);
      return;
    }
    if (msg.method === 'notifications/cancelled' && gatedCalls.has(msg.params?.requestId)) {
      client.cancel(gatedCalls.get(msg.params.requestId), 'client cancelled the call').catch(() => {});
      return;
    }
    toServer(msg);
  });

  lineReader(child.stdout, (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { output.write(`${line}\n`); return; }
    if (routeElicitation && msg.method === 'elicitation/create' && msg.id != null) {
      elicit(msg);
      return;
    }
    if (msg.method === 'notifications/cancelled' && elicits.has(msg.params?.requestId)) {
      client.cancel(elicits.get(msg.params.requestId), 'server cancelled the request').catch(() => {});
      return;
    }
    toClient(msg);
  });

  input.on('end', () => child.stdin.end());
  return child;
}
