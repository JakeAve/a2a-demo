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

Deno.test("base agent: a higher maxDepth resolver allows deeper delegation", async () => {
  const agent = await startAgent({
    card,
    bearerToken: "tok",
    maxDepth: () => 4, // peg-to-agent-count would supply this dynamically
    handler: async () => ({ text: "ok" }),
    streamHandler: async function* () { yield { type: "done" }; },
  });
  const send = (d: string) =>
    fetch(`http://localhost:${agent.port}/message/send`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok", "x-depth": d },
      body: JSON.stringify({ message: { messageId: "1", role: "user", parts: [{ type: "text", text: "hi" }] } }),
    });
  const ok = await send("3"); // 3 < 4 → allowed (would be 429 under the old cap of 2)
  assertEquals(ok.status, 200);
  await ok.body?.cancel();
  const blocked = await send("4"); // 4 >= 4 → rejected
  assertEquals(blocked.status, 429);
  await blocked.body?.cancel();
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
