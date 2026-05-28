// Manual smoke test: boots the same components the orchestrator would,
// runs a few real round-trips against Anthropic + Ollama, then exits.
import { loadConfig } from "../src/config.ts";
import { startRegistry } from "../src/registry/server.ts";
import { RegistryClient } from "../src/registry/client.ts";
import { startAgent } from "../src/agent/base.ts";
import { makeOllamaHandlers } from "../src/agent/ollama.ts";
import { makeClaudeHandlers } from "../src/agent/claude.ts";
import { ContextStore } from "../src/store/context.ts";
import { ThreadStore } from "../src/store/threads.ts";
import { sendMessage } from "../src/protocol/client.ts";
import { roles } from "../src/roles.config.ts";
import type { AgentCard } from "../src/protocol/types.ts";

const cfg = await loadConfig();
const registry = await startRegistry(cfg.registryPort);
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

const gemmaHandlers = makeOllamaHandlers({
  model: "gemma3:1b",
  systemPrompt: roles.gemma3.systemPrompt,
  baseUrl: cfg.ollamaBaseUrl,
  store,
});
const gemma = await startAgent({
  card: baseCard("gemma3", roles.gemma3),
  bearerToken: cfg.bearerToken,
  handler: gemmaHandlers.handler,
  streamHandler: gemmaHandlers.streamHandler,
});
await registryClient.register(gemma.card);
console.log(`[gemma3]  ${gemma.card.url}`);

const sonnetHandlers = makeClaudeHandlers({
  model: roles.sonnet.model,
  systemPrompt: roles.sonnet.systemPrompt,
  apiKey: cfg.anthropicApiKey,
  store,
  threads,
  registry: registryClient,
  bearerToken: cfg.bearerToken,
  selfName: "sonnet",
});
const sonnet = await startAgent({
  card: baseCard("sonnet", roles.sonnet),
  bearerToken: cfg.bearerToken,
  handler: sonnetHandlers.handler,
  streamHandler: sonnetHandlers.streamHandler,
});
await registryClient.register(sonnet.card);
console.log(`[sonnet]  ${sonnet.card.url}`);

// Single REPL-like contextId so each probe shares sonnet's view of the world.
const replContextId = crypto.randomUUID();

async function probe(label: string, target: string, text: string) {
  console.log(`\n--- ${label} → ${target} ---`);
  console.log(`> ${text}`);
  const start = Date.now();
  try {
    const res = await sendMessage({
      url: target === "sonnet" ? sonnet.card.url : gemma.card.url,
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

await probe(
  "test 1 (sonnet starts a delegation thread)",
  "sonnet",
  "Use delegate_start to ask gemma3 to write a 5-7-5 haiku about frogs. Just report the haiku back to me with no commentary.",
);

await probe(
  "test 2 (sonnet should continue the SAME thread)",
  "sonnet",
  "Now ask gemma3 to make that haiku darker and more melancholic. Use delegate_continue so gemma3 remembers the original.",
);

await probe(
  "test 3 (sonnet lists its threads)",
  "sonnet",
  "Call list_my_threads and tell me how many active threads you have, what peer they're with, and the turn count.",
);

console.log("\n--- test 4 (depth guard via raw fetch with x-depth: 2) ---");
const rejectRes = await fetch(`${gemma.card.url}/message/send`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${cfg.bearerToken}`,
    "x-depth": "2",
  },
  body: JSON.stringify({
    message: { messageId: "x", role: "user", parts: [{ type: "text", text: "hi" }] },
  }),
});
console.log(`< HTTP ${rejectRes.status} (expected 429)`);
await rejectRes.body?.cancel();

console.log("\n--- ThreadStore state ---");
const finalThreads = await threads.list(replContextId);
for (const t of finalThreads) {
  console.log(`  ${t.peer}/${t.threadId.slice(0, 8)}  turns=${t.turnCount}  title="${t.title}"`);
}

await gemma.shutdown();
await sonnet.shutdown();
await registry.shutdown();
kv.close();
console.log("\nshutdown complete.");
