import { type AppConfig, type AgentSpec } from "./config.ts";
import { startRegistry, type RegistryHandle } from "./registry/server.ts";
import { RegistryClient } from "./registry/client.ts";
import { startAgent, type AgentHandle } from "./agent/base.ts";
import { makeOllamaHandlers } from "./agent/ollama.ts";
import { makeClaudeHandlers } from "./agent/claude.ts";
import { ContextStore } from "./store/context.ts";
import { runRepl } from "./repl.ts";
import type { AgentCard } from "./protocol/types.ts";

export async function runOrchestrator(cfg: AppConfig, specs: AgentSpec[]): Promise<void> {
  const registry: RegistryHandle = await startRegistry(cfg.registryPort);
  const registryClient = new RegistryClient(`http://localhost:${registry.port}`);
  const kv = await Deno.openKv();
  const store = new ContextStore(kv);

  console.log(`[registry]   localhost:${registry.port}`);

  const agents = new Map<string, AgentCard>();
  const handles: AgentHandle[] = [];

  for (const spec of specs) {
    try {
      const baseCard: AgentCard = {
        name: spec.name,
        description: spec.preset.description,
        version: "1.0.0",
        url: "http://localhost:0",
        skills: spec.preset.skills,
        securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
        security: [{ bearer: [] }],
      };

      const handlers = spec.preset.backend === "claude"
        ? makeClaudeHandlers({
            model: spec.model,
            systemPrompt: spec.preset.systemPrompt,
            apiKey: cfg.anthropicApiKey,
            store,
            registry: registryClient,
            bearerToken: cfg.bearerToken,
            selfName: spec.name,
          })
        : makeOllamaHandlers({
            model: spec.model,
            systemPrompt: spec.preset.systemPrompt,
            baseUrl: cfg.ollamaBaseUrl,
            store,
          });

      const handle = await startAgent({
        card: baseCard,
        bearerToken: cfg.bearerToken,
        handler: handlers.handler,
        streamHandler: handlers.streamHandler,
      });
      await registryClient.register(handle.card);
      handles.push(handle);
      agents.set(spec.name, handle.card);
      console.log(`[${spec.name}]   ${handle.card.url}  (${spec.model})`);
    } catch (e) {
      console.error(`[${spec.name}] failed to start: ${(e as Error).message}`);
    }
  }

  const shutdown = async () => {
    console.log("\nshutting down...");
    for (const h of handles) {
      try { await registryClient.deregister(h.card.name); } catch { /* ignore */ }
      try { await h.shutdown(); } catch { /* ignore */ }
    }
    try { await registry.shutdown(); } catch { /* ignore */ }
    kv.close();
    Deno.exit(0);
  };
  Deno.addSignalListener("SIGINT", shutdown);

  await runRepl({ agents, bearerToken: cfg.bearerToken });
  await shutdown();
}
