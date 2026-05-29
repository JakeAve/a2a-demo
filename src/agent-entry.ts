// Standalone agent entry point. Run with:
//
//   deno task start:agent --role=<name> [--name=<custom>] [--registry=<url>]
//
// Each invocation boots ONE agent of the given role, registers itself with
// the registry, and runs until SIGINT/SIGTERM. Each process owns its own
// Deno KV (so its history is isolated from other agents'). The Claude
// backend gets its own ThreadStore too.
import { assertBackendCredentials, loadConfig } from "./config.ts";
import { loadRoles } from "./roles.ts";
import { startAgent } from "./agent/base.ts";
import { ContextStore } from "./store/context.ts";
import { ThreadStore } from "./store/threads.ts";
import { SessionStore } from "./store/sessions.ts";
import { buildHandlers } from "./agent/handlers.ts";
import { RegistryClient } from "./registry/client.ts";
import type { AgentCard } from "./protocol/types.ts";
import { createEmitter } from "./observability/emit.ts";

function getFlag(args: string[], name: string): string | undefined {
  for (const arg of args) {
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
  }
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1];
  return undefined;
}

const role = getFlag(Deno.args, "role");
if (!role) {
  console.error("usage: deno task start:agent --role=<name> [--name=<custom>] [--registry=<url>]");
  Deno.exit(2);
}
const roles = await loadRoles();
const preset = roles[role];
if (!preset) {
  console.error(`unknown role "${role}". Known: ${Object.keys(roles).join(", ")}`);
  Deno.exit(2);
}

const agentName = getFlag(Deno.args, "name") ?? role;
const modelOverride = getFlag(Deno.args, "model");
const model = modelOverride ?? preset.model;

const cfg = await loadConfig();
const registryUrl = getFlag(Deno.args, "registry") ??
  Deno.env.get("REGISTRY_URL") ??
  `http://localhost:${cfg.registryPort}`;

try {
  assertBackendCredentials([{ name: agentName, preset, model }], cfg);
} catch (e) {
  console.error((e as Error).message);
  Deno.exit(1);
}

const kv = await Deno.openKv();
const emit = createEmitter(cfg.monitorUrl || undefined, cfg.bearerToken);
const store = new ContextStore(kv);
const threads = new ThreadStore(kv);
const sessions = new SessionStore(kv);
const registry = new RegistryClient(registryUrl);
// Fixed A2A_MAX_DEPTH if set, else pegged to the current agent count (min 2).
const resolveMaxDepth = async () =>
  cfg.maxDepth > 0 ? cfg.maxDepth : Math.max(2, (await registry.list()).length);

const baseCard: AgentCard = {
  name: agentName,
  description: preset.description,
  version: "1.0.0",
  url: "http://localhost:0",
  skills: preset.skills,
  securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
  security: [{ bearer: [] }],
};

const handlers = await buildHandlers({
  model,
  preset,
  cfg,
  store,
  threads,
  sessions,
  registry,
  selfName: agentName,
  // Spawned agents cannot spawn further agents — no spawnAgent/availableRoles.
  emit,
});

const handle = await startAgent({
  card: baseCard,
  bearerToken: cfg.bearerToken,
  handler: handlers.handler,
  streamHandler: handlers.streamHandler,
  emit,
  maxDepth: resolveMaxDepth,
});
await registry.register(handle.card);
console.log(`[${agentName}] ${handle.card.url} (${model})  registered with ${registryUrl}`);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${agentName}] shutting down...`);
  try { await registry.deregister(agentName); } catch { /* ignore */ }
  try { await handle.shutdown(); } catch { /* ignore */ }
  kv.close();
  Deno.exit(0);
};
Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);

// Stay alive
await new Promise<void>(() => {});
