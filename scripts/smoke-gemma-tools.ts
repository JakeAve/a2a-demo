// Probe: can the tool-capable captain (gemma4:e4b) act as an A2A agent that
// itself delegates to a smaller peer? Boots captain (tool-capable) + helper
// (gemma3:1b, passive worker). User asks captain a question; captain should
// choose to call delegate_start on helper to actually answer.
import { loadConfig } from "../src/config.ts";
import { startRegistry } from "../src/registry/server.ts";
import { RegistryClient } from "../src/registry/client.ts";
import { startAgent } from "../src/agent/base.ts";
import { makeOllamaHandlers } from "../src/agent/ollama.ts";
import { ContextStore } from "../src/store/context.ts";
import { ThreadStore } from "../src/store/threads.ts";
import { sendMessage } from "../src/protocol/client.ts";
import { loadRoles } from "../src/roles.ts";
const roles = await loadRoles();
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

// helper (gemma3:1b) — passive worker (no tools)
const helperHandlers = makeOllamaHandlers({
  model: "gemma3:1b",
  systemPrompt: roles.worker.systemPrompt,
  baseUrl: cfg.ollamaBaseUrl,
  store,
});
const helper = await startAgent({
  card: baseCard("helper", roles.worker),
  bearerToken: cfg.bearerToken,
  handler: helperHandlers.handler,
  streamHandler: helperHandlers.streamHandler,
});
await registryClient.register(helper.card);
console.log(`[helper]  ${helper.card.url} (gemma3:1b, no tools)`);

// captain (gemma4:e4b) — tool-capable
const captainHandlers = makeOllamaHandlers({
  model: "gemma4:e4b",
  systemPrompt: roles.worker.systemPrompt,
  baseUrl: cfg.ollamaBaseUrl,
  store,
  tools: {
    store,
    threads,
    registry: registryClient,
    bearerToken: cfg.bearerToken,
    selfName: "captain",
    // no spawnAgent — keep it simple
  },
});
const captain = await startAgent({
  card: baseCard("captain", roles.worker),
  bearerToken: cfg.bearerToken,
  handler: captainHandlers.handler,
  streamHandler: captainHandlers.streamHandler,
});
await registryClient.register(captain.card);
console.log(`[captain]  ${captain.card.url} (gemma4:e4b, A2A tools enabled)`);

const replContextId = crypto.randomUUID();

async function ask(label: string, target: string, text: string) {
  console.log(`\n--- ${label} → ${target} ---`);
  console.log(`> ${text}`);
  const start = Date.now();
  try {
    const res = await sendMessage({
      url: target === "captain" ? captain.card.url : helper.card.url,
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
  "test 1 — captain should delegate to helper",
  "captain",
  "You have access to a peer agent named 'helper'. Use delegate_start to ask helper 'what color is the sky?'. Then report exactly what helper said.",
);

await ask(
  "test 2 — captain discovers its peers first",
  "captain",
  "Call list_agents to see what peers exist, then pick one and use delegate_start to ask 'name three fruits'. Report the answer.",
);

console.log("\n--- ThreadStore state ---");
for (const t of await threads.list(replContextId)) {
  console.log(`  ${t.peer}/${t.threadId.slice(0, 8)}  turns=${t.turnCount}  title="${t.title}"`);
}

await helper.shutdown();
await captain.shutdown();
await registry.shutdown();
kv.close();
console.log("\nshutdown complete.");
