// MCP adapter / driver. Sibling to repl.ts: where the REPL drives agents via
// @mentions on stdin, this drives them by exposing the raw A2A delegation tools
// to an MCP client. The client acts as the depth-0 driver, so runTool is called
// with depth 0 (delegations then go out at depth 1, exactly like the REPL).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { getTools, runTool, type BaseTool, type ToolDeps } from "./agent/tools.ts";
import type { OrchestratorContext } from "./orchestrator.ts";

export type McpTool = {
  name: string;
  description: string;
  inputSchema: BaseTool["parameters"];
};

export type McpToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/** The MCP tool list = the existing transport-neutral tools, reshaped to MCP's `inputSchema` key. */
export function mcpToolList(deps: ToolDeps): McpTool[] {
  return getTools(deps).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters,
  }));
}

/** Run one tool via the shared runner and wrap it as an MCP tool result. runTool never throws
 *  (it returns an {error} JSON on failure), so we detect that to set isError. */
export async function callMcpTool(
  deps: ToolDeps,
  contextId: string,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const text = await runTool(deps, name, args, 0, contextId, {
    sessionId,
    requestId: crypto.randomUUID(),
  });
  let isError = false;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "error" in parsed) isError = true;
  } catch { /* non-JSON result is a success */ }
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

/** Build (but do not connect) an MCP Server wired to these deps. Split out so tests can
 *  attach an in-memory transport instead of stdio. */
export function buildMcpServer(deps: ToolDeps, contextId: string, sessionId: string): Server {
  const server = new Server(
    { name: "a2a", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: mcpToolList(deps) }));
  server.setRequestHandler(CallToolRequestSchema, (req: CallToolRequest) =>
    callMcpTool(
      deps,
      contextId,
      sessionId,
      req.params.name,
      (req.params.arguments ?? {}) as Record<string, unknown>,
    ));
  return server;
}

/** Build a ToolDeps for the MCP driver from a booted orchestrator context.
 *  selfName "mcp" identifies the driver in emitted events / the monitor.
 *  web_search is intentionally not exposed (search left unset). */
export function mcpToolDeps(ctx: OrchestratorContext): ToolDeps {
  return {
    store: ctx.store,
    threads: ctx.threads,
    registry: ctx.registryClient,
    bearerToken: ctx.bearerToken,
    selfName: "mcp",
    emit: ctx.emit,
    spawnAgent: ctx.spawnAgent,
    availableRoles: ctx.availableRoles,
  };
}

/** Run the MCP server on stdio until the client disconnects (stdin closes). */
export async function runMcpServer(ctx: OrchestratorContext): Promise<void> {
  const deps = mcpToolDeps(ctx);
  const contextId = crypto.randomUUID(); // one session/thread namespace per server lifetime
  const server = buildMcpServer(deps, contextId, contextId);
  // Assign onclose BEFORE connect so a fast client disconnect can't slip through
  // the gap and leave this promise unresolved.
  const closed = new Promise<void>((resolve) => { server.onclose = () => resolve(); });
  const transport = new StdioServerTransport();
  // If connect() throws, propagate immediately rather than awaiting `closed`
  // (which would never resolve, hanging the server).
  try {
    await server.connect(transport);
  } catch (e) {
    server.onclose = undefined;
    throw e;
  }
  await closed;
}
