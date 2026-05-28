import { assertEquals } from "@std/assert";
import { startAgent } from "../../src/agent/base.ts";
import type { AgentCard } from "../../src/protocol/types.ts";

const card: AgentCard = {
  name: "test", description: "t", version: "1.0.0",
  url: "http://localhost:0",
  skills: [{ id: "x", name: "x", description: "x" }],
  securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
  security: [{ bearer: [] }],
};

Deno.test("base agent: x-depth >= 2 returns 429", async () => {
  const agent = await startAgent({
    card,
    bearerToken: "tok",
    handler: async () => ({ text: "ok" }),
    streamHandler: async function* () { yield { type: "delta", text: "ok" }; yield { type: "done" }; },
  });
  const url = `http://localhost:${agent.port}/message/send`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer tok", "x-depth": "2" },
    body: JSON.stringify({ message: { messageId: "1", role: "user", parts: [] } }),
  });
  assertEquals(res.status, 429);
  await res.body?.cancel();
  await agent.shutdown();
});

Deno.test("base agent: x-depth 0 and 1 allowed", async () => {
  const agent = await startAgent({
    card,
    bearerToken: "tok",
    handler: async () => ({ text: "ok" }),
    streamHandler: async function* () { yield { type: "done" }; },
  });
  for (const d of ["0", "1"]) {
    const res = await fetch(`http://localhost:${agent.port}/message/send`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok", "x-depth": d },
      body: JSON.stringify({ message: { messageId: "1", role: "user", parts: [{ type: "text", text: "hi" }] } }),
    });
    assertEquals(res.status, 200, `depth ${d} should be allowed`);
    await res.body?.cancel();
  }
  await agent.shutdown();
});
