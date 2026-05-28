import { assertEquals } from "@std/assert";
import { startAgent } from "../../src/agent/base.ts";
import type { AgentCard } from "../../src/protocol/types.ts";

const card: AgentCard = {
  name: "t", description: "t", version: "1.0.0", url: "http://localhost:0",
  skills: [{ id: "x", name: "x", description: "x" }],
  securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
  security: [{ bearer: [] }],
};

const body = JSON.stringify({ message: { messageId: "1", role: "user", parts: [] } });

Deno.test("auth: missing token returns 401", async () => {
  const agent = await startAgent({
    card, bearerToken: "secret",
    handler: async () => ({ text: "" }),
    streamHandler: async function* () { yield { type: "done" }; },
  });
  const res = await fetch(`http://localhost:${agent.port}/message/send`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-depth": "0" },
    body,
  });
  assertEquals(res.status, 401);
  await res.body?.cancel();
  await agent.shutdown();
});

Deno.test("auth: wrong token returns 401", async () => {
  const agent = await startAgent({
    card, bearerToken: "secret",
    handler: async () => ({ text: "" }),
    streamHandler: async function* () { yield { type: "done" }; },
  });
  const res = await fetch(`http://localhost:${agent.port}/message/send`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer nope", "x-depth": "0" },
    body,
  });
  assertEquals(res.status, 401);
  await res.body?.cancel();
  await agent.shutdown();
});

Deno.test("auth: agent card is public (no token required)", async () => {
  const agent = await startAgent({
    card, bearerToken: "secret",
    handler: async () => ({ text: "" }),
    streamHandler: async function* () { yield { type: "done" }; },
  });
  const res = await fetch(`http://localhost:${agent.port}/.well-known/agent.json`);
  assertEquals(res.status, 200);
  await res.json();
  await agent.shutdown();
});
