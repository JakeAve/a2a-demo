// Verify Ollama streaming with tool calls: stream tokens to the client
// AND surface tool events as they happen, then keep streaming the
// post-tool-call response.
import { loadConfig } from "../src/config.ts";
import { startRegistry } from "../src/registry/server.ts";
import { RegistryClient } from "../src/registry/client.ts";
import { startAgent } from "../src/agent/base.ts";
import { makeOllamaHandlers } from "../src/agent/ollama.ts";
import { ContextStore } from "../src/store/context.ts";
import { ThreadStore } from "../src/store/threads.ts";
import { streamMessage } from "../src/protocol/client.ts";
import { loadRoles } from "../src/roles.ts";
const roles = await loadRoles();
import type { AgentCard } from "../src/protocol/types.ts";

const cfg = await loadConfig();
const registry = await startRegistry(0);
const registryClient = new RegistryClient(`http://localhost:${registry.port}`);
const kv = await Deno.openKv();
const store = new ContextStore(kv);
const threads = new ThreadStore(kv);

const baseCard = (name: string, preset: typeof roles[string]): AgentCard => ({
  name,
  description: preset.description,
  version: "1.0.0",
  url: "http://localhost:0",
  skills: preset.skills,
  securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
  security: [{ bearer: [] }],
});

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
  },
});
const captain = await startAgent({
  card: baseCard("captain", roles.worker),
  bearerToken: cfg.bearerToken,
  handler: captainHandlers.handler,
  streamHandler: captainHandlers.streamHandler,
});
await registryClient.register(captain.card);

console.log(`[registry] localhost:${registry.port}`);
console.log(`[helper]   ${helper.card.url}  (gemma3:1b)`);
console.log(
  `[captain]  ${captain.card.url}  (gemma4:e4b, A2A tools, streaming)`,
);
console.log();

const start = Date.now();
const contextId = crypto.randomUUID();
const prompt =
  "Ask helper to pick one number between 1 and 10. After getting the answer back, say 'helper chose N' and that's all.";
console.log(`> ${prompt}\n`);
console.log("(streaming events below)");

let deltaCount = 0;
let toolCount = 0;
let firstByteAt = 0;

for await (
  const ev of streamMessage({
    url: captain.card.url,
    token: cfg.bearerToken,
    depth: 0,
    message: {
      messageId: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: prompt }],
      contextId,
    },
  })
) {
  if (ev.type === "delta") {
    if (!firstByteAt) firstByteAt = Date.now() - start;
    deltaCount++;
    await Deno.stdout.write(new TextEncoder().encode(ev.text));
  } else if (ev.type === "tool") {
    toolCount++;
    console.log(`\n  [tool-event] ${ev.name}(${JSON.stringify(ev.args)})`);
  } else if (ev.type === "error") {
    console.log(`\n  [error] ${ev.message}`);
  } else if (ev.type === "done") {
    break;
  }
}

console.log(`\n\n--- stats ---`);
console.log(`time-to-first-byte: ${firstByteAt}ms`);
console.log(`total: ${Date.now() - start}ms`);
console.log(`delta events: ${deltaCount}`);
console.log(`tool events:  ${toolCount}`);

await helper.shutdown();
await captain.shutdown();
await registry.shutdown();
kv.close();
