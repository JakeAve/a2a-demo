// MCP entry point. Run with:
//
//   deno task mcp --agents="coordinator,scout,analyst"
//
// Boots the same scaffolding as the REPL orchestrator (registry + agents +
// spawn closure) but serves an MCP stdio server instead of the REPL. This
// process is the sole orchestrator for its registry/KV while running.
//
// CRITICAL: on a stdio transport, stdout carries the MCP JSON-RPC stream.
// Anything else written to stdout corrupts the protocol. So:
//   1. We redirect console.log -> console.error (the orchestrator logs
//      registry/agent/shutdown lines via console.log).
//   2. setupOrchestrator is told childStdout:"null" so spawned agents' stdout
//      can't reach our stdout either (their stderr still surfaces real errors).
console.log = (...args: unknown[]) => console.error(...args);

import { assertBackendCredentials, getAgentsFlag, loadConfig, parseAgentsFlag } from "./config.ts";
import { loadRoles } from "./roles.ts";
import { setupOrchestrator } from "./orchestrator.ts";
import { runMcpServer } from "./mcp-server.ts";

const cfg = await loadConfig();
const roles = await loadRoles();
const specs = parseAgentsFlag(getAgentsFlag(Deno.args), roles);

try {
  assertBackendCredentials(specs, cfg);
} catch (e) {
  console.error((e as Error).message);
  Deno.exit(1);
}

const ctx = await setupOrchestrator(cfg, specs, roles, { childStdout: "null" });

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await ctx.shutdown(); } catch { /* ignore */ }
  Deno.exit(0);
};
Deno.addSignalListener("SIGINT", () => { void shutdown(); });
Deno.addSignalListener("SIGTERM", () => { void shutdown(); });

console.error("[mcp] A2A MCP server ready on stdio");
await runMcpServer(ctx); // resolves when the client disconnects
await shutdown();
