import { assertEquals } from "@std/assert";
import { startAgent } from "../../src/agent/base.ts";
import type { AgentCard } from "../../src/protocol/types.ts";

const card: AgentCard = {
  name: "t", description: "t", version: "1.0.0", url: "http://localhost:0",
  skills: [{ id: "x", name: "x", description: "x" }],
  securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
  security: [{ bearer: [] }],
};

Deno.test("agent card URL matches bound port", async () => {
  const agent = await startAgent({
    card, bearerToken: "secret",
    handler: async () => ({ text: "" }),
    streamHandler: async function* () { yield { type: "done" }; },
  });
  const res = await fetch(`http://localhost:${agent.port}/.well-known/agent.json`);
  const json = await res.json();
  assertEquals(json.url, `http://localhost:${agent.port}`);
  await agent.shutdown();
});
