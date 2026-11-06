// `switchboard mcp`: an MCP server any agent can add to reach you through Switchboard.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { basename } from 'node:path';
import { z } from 'zod';
import { SwitchboardClient } from './client.js';
import { VERSION } from './config.js';
import { slug } from './util.js';

// What MCP clients call themselves, and what you'd call them.
const CLIENT_NAMES = { 'codex-mcp-client': 'Codex', 'claude-code': 'Claude Code', 'claude-ai': 'Claude Desktop', 'cursor-vscode': 'Cursor', openclaw: 'OpenClaw', hermes: 'Hermes Agent', 'hermes-agent': 'Hermes Agent' };

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });

function describe(view) {
  if (!view.final) return { ...view, note: `Still waiting for the human. Call check_answer with id "${view.id}" later; keep working on anything that doesn't depend on it.` };
  if (view.status === 'expired') return { ...view, note: 'Deadline passed with no answer and no default. Do not proceed with the action.' };
  if (view.status === 'dismissed' && !view.answer?.option) return { ...view, note: 'The human dismissed this. Treat it as "no" and do not ask again right away.' };
  if (view.answer?.option && view.answer?.text) return { ...view, note: `The human chose "${view.answer.label}" and added a note in answer.text. Follow the note; it takes priority over your plan.` };
  return view;
}

/** The Switchboard MCP tools, bound to one client (stdio) or one agent key (HTTP). */
export function buildMcpServer({ client, defaultWaitSeconds = 120, maxWaitSeconds = 3600 } = {}) {
  const server = new McpServer({ name: 'switchboard', version: VERSION });
  const c = client || new SwitchboardClient();
  // Same identity as the agent's hooks ("Codex · api" / codex-api), so its budget and rules are shared.
  const agent = () => {
    if (c.agent) return c.agent;
    const raw = server.server.getClientVersion()?.name || 'mcp-agent';
    const name = CLIENT_NAMES[raw] || raw;
    const project = basename(process.cwd());
    return { id: slug(`${name}-${project}`), name: `${name} · ${project}` };
  };

  server.registerTool('ask_human', {
    title: 'Ask the human',
    description:
      'Ask your human a question through Switchboard, their attention router. Use this instead of stopping to ask in chat when you need a decision, approval or a piece of information. ' +
      'Switchboard decides when to interrupt them (now, at a natural break, or in a digest) based on urgency and their focus state, so: write one short question answerable with one tap; ' +
      'give 2-4 options with their consequences; set a deadline and a safe default whenever one exists (then they are not interrupted unnecessarily); be honest about urgency. ' +
      'They may add a note to any choice (answer.text): follow it. Returns the answer, or a pending id to check later with check_answer.',
    inputSchema: {
      question: z.string().describe('One question, answerable in a tap or a word. Max ~140 chars.'),
      options: z.array(z.union([z.string(), z.object({ label: z.string(), consequence: z.string().optional(), style: z.enum(['default', 'primary', 'danger']).optional() })])).optional()
        .describe('2-4 choices. Omit for a free-text answer.'),
      urgency: z.enum(['low', 'normal', 'high', 'critical']).optional().describe('critical = harm or loss within minutes. Over-claiming urgency lowers your credibility.'),
      deadline: z.string().optional().describe('When an answer stops being useful: duration like "15m" or ISO time.'),
      default: z.string().optional().describe('Option applied if no answer by the deadline. Must be safe.'),
      reversible: z.boolean().optional().describe('Can the action be undone afterwards?'),
      delay_cost: z.string().optional().describe('What waiting costs, e.g. "fare goes up $80 at 6pm".'),
      summary: z.string().optional().describe('One-paragraph context shown when the human expands the ask.'),
      context: z.string().optional().describe('Full details (diffs, logs, drafts) for the "full context" view.'),
      thread: z.string().optional().describe('Groups related asks, e.g. a task or ticket id.'),
      wait_seconds: z.number().int().min(0).max(3600).optional().describe('How long to block waiting (default 120). Returns a pending id if unanswered.'),
    },
  }, async (args) => {
    const input = {
      agent: agent(),
      question: args.question,
      urgency: args.urgency,
      deadline: args.deadline,
      default: args.default,
      reversible: args.reversible,
      delay_cost: args.delay_cost,
      detail: { paragraph: args.summary, full: args.context },
      thread: args.thread,
    };
    if (args.options?.length) input.options = args.options;
    else input.input = { type: 'text' };
    try {
      const view = await c.ask(input, { timeoutMs: Math.min(args.wait_seconds ?? defaultWaitSeconds, maxWaitSeconds) * 1000 });
      return text(describe(view));
    } catch (err) {
      return { ...text(`Switchboard error: ${err.message}`), isError: true };
    }
  });

  server.registerTool('request_review', {
    title: 'Ask the human to review something',
    description:
      'Hand your human a document, plan, diff or file to review before you continue, through Switchboard. They see a formatted preview (and can open the file in their editor), ' +
      'then Approve or Request changes, usually with comments. Comments arrive in answer.text: read them and act on them. ' +
      'Use this instead of pasting a long document into chat and waiting. Returns the decision, or a pending id to check later with check_answer.',
    inputSchema: {
      title: z.string().describe('What to review, as a short question, e.g. "Review the migration plan before I run it?"'),
      summary: z.string().optional().describe('One paragraph: what it is and what you want feedback on.'),
      file_path: z.string().optional().describe('Absolute path of a file to review (local agents only).'),
      content: z.string().optional().describe('The document itself (markdown) or a unified diff, if there is no file.'),
      format: z.enum(['markdown', 'diff', 'text', 'code']).optional().describe('How to show `content` (default markdown).'),
      url: z.string().optional().describe('A link to review instead, e.g. a pull request or a Google Doc.'),
      urgency: z.enum(['low', 'normal', 'high', 'critical']).optional(),
      deadline: z.string().optional().describe('When the review stops being useful, e.g. "2h".'),
      wait_seconds: z.number().int().min(0).max(3600).optional().describe('How long to block waiting (default 120). Returns a pending id if unanswered.'),
    },
  }, async (args) => {
    const attachments = [];
    if (args.file_path) attachments.push({ path: args.file_path });
    if (args.content) attachments.push({ content: args.content, format: args.format || 'markdown', title: args.title });
    if (args.url) attachments.push({ url: args.url });
    if (!attachments.length) return { ...text('Give file_path, content or url so there is something to review.'), isError: true };
    try {
      const view = await c.ask({
        agent: agent(),
        kind: 'review',
        question: args.title,
        urgency: args.urgency,
        deadline: args.deadline,
        detail: { paragraph: args.summary },
        attachments,
      }, { timeoutMs: Math.min(args.wait_seconds ?? defaultWaitSeconds, maxWaitSeconds) * 1000 });
      return text(describe(view));
    } catch (err) {
      return { ...text(`Switchboard error: ${err.message}`), isError: true };
    }
  });

  server.registerTool('check_answer', {
    title: 'Check an earlier ask',
    description: 'Check (and optionally wait for) the answer to an earlier ask_human call that returned pending.',
    inputSchema: { id: z.string(), wait_seconds: z.number().int().min(0).max(3600).optional() },
  }, async ({ id, wait_seconds }) => {
    try {
      return text(describe(await c.wait(id, { timeoutMs: (wait_seconds ?? 30) * 1000 })));
    } catch (err) {
      return { ...text(`Switchboard error: ${err.message}`), isError: true };
    }
  });

  server.registerTool('notify_human', {
    title: 'Tell the human something',
    description: 'Send an FYI that needs no answer (task finished, something noteworthy). Switchboard batches these into digests unless urgent, so use it freely instead of interrupting.',
    inputSchema: {
      message: z.string().describe('One line.'),
      urgency: z.enum(['low', 'normal', 'high', 'critical']).optional(),
      summary: z.string().optional(),
      thread: z.string().optional(),
    },
  }, async (args) => {
    try {
      const r = await c.notify(args.message, { agent: agent(), urgency: args.urgency ?? 'low', detail: args.summary, thread: args.thread });
      return text({ id: r.id, delivery: r.delivery });
    } catch (err) {
      return { ...text(`Switchboard error: ${err.message}`), isError: true };
    }
  });

  server.registerTool('get_human_state', {
    title: 'Is the human available?',
    description: 'Coarse availability of your human (available / focus / dnd / away) and the minimum urgency that may interrupt them. Check before starting work that will need their input soon.',
    inputSchema: {},
  }, async () => {
    try {
      return text(await c.state());
    } catch (err) {
      return { ...text(`Switchboard error: ${err.message}`), isError: true };
    }
  });

  return server;
}

export async function runMcpServer({ client } = {}) {
  const server = buildMcpServer({ client });
  await server.connect(new StdioServerTransport());
  return server;
}
