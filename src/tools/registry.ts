import { Tool } from '@modelcontextprotocol/sdk/types.js';

export type ToolArgs = Record<string, unknown>;

export interface ToolDef {
  tool: Tool;
  handler: (args: ToolArgs) => Promise<string>;
}

// Read tools only query state; MCP clients may use this hint to skip confirmation.
export const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

export function str(args: ToolArgs, key: string): string {
  return String(args[key] ?? '');
}

export function optStr(args: ToolArgs, key: string): string | undefined {
  const v = args[key];
  return v == null || v === '' ? undefined : String(v);
}

export function posInt(args: ToolArgs, key: string, fallback: number): number {
  return Math.max(1, Math.floor(Number(args[key])) || fallback);
}
