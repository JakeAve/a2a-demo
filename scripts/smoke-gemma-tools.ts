// Probe: can gemma4:e4b act as a tool-capable A2A agent that itself
// delegates to a smaller peer? Boots gemma4 (tool-capable) + gemma3:1b
// (passive worker). User asks gemma4 a question; gemma4 should choose
// to call delegate_start on gemma3 to actually answer.
import { loadConfig } from "../src/config.ts";
import { startRegistry } from "../src/registry/server.ts";
import { RegistryClient } from "../src/registry/client.ts";
import { startAgent } from "../src/agent/base.ts";
import { makeOllamaHandlers } from "../src/agent/ollama.ts";
import { ContextStore } from "../src/store/context.ts";
import { ThreadStore } from "../src/store/threads.ts";
import { sendMessage } from "../src/protocol/client.ts";
import { roles } from "../src/roles.config.ts";
import type { AgentCard } from "../src/protocol/types.ts";

const cfg = await loadConfig();
const registry = await startRegistry(0);
const registryClient = new RegistryClient(`http://localhost:${registry.port}`);
const kv = await Deno.openKv();
const store = new ContextStore(kv);
const threads = new ThreadStore(kv);

console.log(`[registry] localhost:${registry.port}`);

const baseCard = (name: string, preset: typeof roles[string]): AgentCard => ({
  name,
  description: preset.description,
  version: "1.0.0",
  url: "http://localhost:0",
  skills: preset.skills,
  securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
  security: [{ bearer: [] }],
});

// gemma3:1b — passive worker (no tools)
const workerHandlers = makeOllamaHandlers({
  model: "gemma3:1b",
  systemPrompt: roles.gemma3.systemPrompt,
  baseUrl: cfg.ollamaBaseUrl,
  store,
});
const worker = await startAgent({
  card: baseCard("gemma3", roles.gemma3),
  bearerToken: cfg.bearerToken,
  handler: workerHandlers.handler,
  streamHandler: workerHandlers.streamHandler,
});
await registryClient.register(worker.card);
console.log(`[gemma3]  ${worker.card.url} (gemma3:1b, no tools)`);

// gemma4:e4b — tool-capable
const captainHandlers = makeOllamaHandlers({
  model: "gemma4:e4b",
  systemPrompt: roles.gemma4.systemPrompt,
  baseUrl: cfg.ollamaBaseUrl,
  store,
  tools: {
    store,
    threads,
    registry: registryClient,
    bearerToken: cfg.bearerToken,
    selfName: "gemma4",
    // no spawnAgent — keep it simple
  },
});
const captain = await startAgent({
  card: baseCard("gemma4", roles.gemma4),
  bearerToken: cfg.bearerToken,
  handler: captainHandlers.handler,
  streamHandler: captainHandlers.streamHandler,
});
await registryClient.register(captain.card);
console.log(`[gemma4]  ${captain.card.url} (gemma4:e4b, A2A tools enabled)`);

const replContextId = crypto.randomUUID();

async function ask(label: string, target: string, text: string) {
  console.log(`\n--- ${label} → ${target} ---`);
  console.log(`> ${text}`);
  const start = Date.now();
  try {
    const res = await sendMessage({
      url: target === "gemma4" ? captain.card.url : worker.card.url,
      token: cfg.bearerToken,
      depth: 0,
      message: {
        messageId: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text }],
        contextId: replContextId,
      },
    });
    console.log(`< (${Date.now() - start}ms) ${res.text}`);
  } catch (e) {
    console.log(`< ERROR: ${(e as Error).message}`);
  }
}

await ask(
  "test 1 — gemma4 should delegate to gemma3",
  "gemma4",
  "You have access to a peer agent named 'gemma3'. Use delegate_start to ask gemma3 'what color is the sky?'. Then report exactly what gemma3 said.",
);

await ask(
  "test 2 — gemma4 discovers its peers first",
  "gemma4",
  "Call list_agents to see what peers exist, then pick one and use delegate_start to ask 'name three fruits'. Report the answer.",
);

console.log("\n--- ThreadStore state ---");
for (const t of await threads.list(replContextId)) {
  console.log(`  ${t.peer}/${t.threadId.slice(0, 8)}  turns=${t.turnCount}  title="${t.title}"`);
}

await worker.shutdown();
await captain.shutdown();
await registry.shutdown();
kv.close();
console.log("\nshutdown complete.");
