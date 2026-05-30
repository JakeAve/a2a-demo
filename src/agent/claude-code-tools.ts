import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { type EmitIds, getTools, runTool, type ToolDeps } from "./tools.ts";

export type ToolRunner = (
  deps: ToolDeps,
  name: string,
  args: Record<string, unknown>,
  depth: number,
  parentContextId: string,
  ids?: EmitIds,
) => Promise<string>;

// zod input shapes mirroring the parameter schemas in tools.ts.
const SHAPES: Record<string, z.ZodRawShape> = {
  list_agents: {},
  list_my_threads: {},
  delegate_start: {
    agent: z.string().describe("Target agent name"),
    prompt: z.string().describe("What to ask the peer agent"),
    title: z.string().optional().describe(
      "Optional short label for this thread",
    ),
  },
  delegate_continue: {
    threadId: z.string().describe("threadId to continue"),
    prompt: z.string().describe("Next message in the thread"),
  },
  reset_thread: {
    threadId: z.string().describe("threadId to delete"),
  },
  list_roles: {},
  spawn_agent: {
    role: z.string().describe("Role name from list_roles"),
    name: z.string().optional().describe(
      "Optional unique name (defaults to role)",
    ),
    model: z.string().optional().describe(
      "Optional model override (e.g. 'gemma3:1b')",
    ),
  },
};

// Namespaced tool names the SDK will expose (used for allowedTools).
export function a2aToolNames(deps: ToolDeps): string[] {
  return getTools(deps).map((t) => `mcp__a2a__${t.name}`);
}

// One MCP tool handler: delegate to the A2A tool runner, wrap as CallToolResult.
export function makeToolHandler(
  deps: ToolDeps,
  name: string,
  depth: number,
  contextId: string,
  run: ToolRunner = runTool,
  ids?: EmitIds,
) {
  return async (args: Record<string, unknown>) => {
    const text = await run(deps, name, args ?? {}, depth, contextId, ids);
    return { content: [{ type: "text" as const, text }] };
  };
}

// Build the in-process MCP server exposing the A2A tools for one request.
export function buildA2aMcpServer(
  deps: ToolDeps,
  depth: number,
  contextId: string,
  run: ToolRunner = runTool,
  ids?: EmitIds,
) {
  const tools = getTools(deps).map((t) =>
    tool(
      t.name,
      t.description,
      SHAPES[t.name],
      makeToolHandler(deps, t.name, depth, contextId, run, ids),
    )
  );
  return createSdkMcpServer({ name: "a2a", version: "1.0.0", tools });
}
