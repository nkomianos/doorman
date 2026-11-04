// A tiny MCP server for proxy tests: one safe tool, one dangerous tool, one that elicits.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'fake', version: '1.0.0' });

server.registerTool('list_repos', { description: 'List repos', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'repo-a, repo-b' }] }));

server.registerTool('delete_repo', { description: 'Delete a repo', inputSchema: { name: z.string() } }, async ({ name }) => ({ content: [{ type: 'text', text: `deleted ${name}` }] }));

server.registerTool('confirm_plan', { description: 'Asks the user to confirm', inputSchema: {} }, async () => {
  const r = await server.server.elicitInput({
    message: 'Apply the migration plan to staging?',
    requestedSchema: { type: 'object', properties: { ok: { type: 'boolean', title: 'Apply' } }, required: ['ok'] },
  }, { timeout: 60000 });
  return { content: [{ type: 'text', text: `action=${r.action} ok=${r.content?.ok}` }] };
});

await server.connect(new StdioServerTransport());
