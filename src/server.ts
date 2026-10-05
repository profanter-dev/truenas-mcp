import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { ToolDef } from './tools/registry.js';

// Uses the low-level Server with plain JSON Schema: McpServer.registerTool()
// with Zod schemas hits TypeScript's inference depth limit (TS2589).
export function createMcpServer(defs: ToolDef[], version: string): Server {
  const byName = new Map(defs.map((d) => [d.tool.name, d]));

  const server = new Server(
    { name: 'truenas-mcp', version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: defs.map((d) => d.tool) }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const def = byName.get(name);
    if (!def) {
      return { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true };
    }

    try {
      const text = await def.handler(args ?? {});
      return { content: [{ type: 'text' as const, text }] };
    } catch (e) {
      const text = `Error: ${e instanceof Error ? e.message : String(e)}`;
      return { content: [{ type: 'text' as const, text }], isError: true };
    }
  });

  return server;
}
