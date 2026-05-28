// Standalone agent entry point. Run with:
//
//   deno task start:agent --role=<name> [--name=<custom>] [--registry=<url>]
//
// Each invocation boots ONE agent of the given role, registers itself with
// the registry, and runs until SIGINT/SIGTERM. Each process owns its own
// Deno KV (so its history is isolated from other agents'). The Claude
// backend gets its own ThreadStore too.
import { loadConfig } from "./config.ts";
import { roles } from "./roles.config.ts";
import { startAgent } from "./agent/base.ts";
import { makeOllamaHandlers } from "./agent/ollama.ts";
import { makeClaudeHandlers } from "./agent/claude.ts";
import { ContextStore } from "./store/context.ts";
import { ThreadStore } from "./store/threads.ts";
import { RegistryClient } from "./registry/client.ts";
import type { AgentCard } from "./protocol/types.ts";

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

if (preset.backend === "claude" && !cfg.anthropicApiKey) {
  console.error("ANTHROPIC_API_KEY is required for Claude agents.");
  Deno.exit(1);
}

const kv = await Deno.openKv();
const store = new ContextStore(kv);
const threads = new ThreadStore(kv);
const registry = new RegistryClient(registryUrl);

const baseCard: AgentCard = {
  name: agentName,
  description: preset.description,
  version: "1.0.0",
  url: "http://localhost:0",
  skills: preset.skills,
  securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
  security: [{ bearer: [] }],
};

const handlers = preset.backend === "claude"
  ? makeClaudeHandlers({
      model,
      systemPrompt: preset.systemPrompt,
      apiKey: cfg.anthropicApiKey,
      store,
      threads,
      registry,
      bearerToken: cfg.bearerToken,
      selfName: agentName,
      // Spawned agents cannot spawn further agents — that capability lives
      // only with the orchestrator. Pass undefined and the Claude backend
      // will omit the spawn tools from its TOOLS list.
    })
  : makeOllamaHandlers({
      model,
      systemPrompt: preset.systemPrompt,
      baseUrl: cfg.ollamaBaseUrl,
      store,
      tools: preset.toolCapable
        ? {
            store,
            threads,
            registry,
            bearerToken: cfg.bearerToken,
            selfName: agentName,
            // No spawnAgent — spawned agents can't spawn further agents.
          }
        : undefined,
    });

const handle = await startAgent({
  card: baseCard,
  bearerToken: cfg.bearerToken,
  handler: handlers.handler,
  streamHandler: handlers.streamHandler,
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
