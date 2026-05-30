import { assertEquals } from "@std/assert";
import { startAgent } from "../../src/agent/base.ts";
import type { EmitEvent } from "../../src/observability/events.ts";
import type { AgentCard } from "../../src/protocol/types.ts";

const card: AgentCard = {
  name: "tester",
  description: "t",
  version: "1.0.0",
  url: "http://localhost:0",
  skills: [],
  securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
  security: [{ bearer: [] }],
};

Deno.test("base emits turn.started + message.completed with propagated ids", async () => {
  const events: EmitEvent[] = [];
  const handle = await startAgent({
    card,
    bearerToken: "t",
    emit: (e) => {
      events.push(e);
      return Promise.resolve();
    },
    handler: () => Promise.resolve({ text: "hello" }),
    streamHandler: async function* () {
      yield { type: "done" };
    },
  });

  const res = await fetch(`${handle.card.url}/message/send`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": "Bearer t",
      "x-depth": "0",
      "x-session": "s1",
      "x-request": "r1",
    },
    body: JSON.stringify({
      message: {
        messageId: "m1",
        role: "user",
        parts: [{ type: "text", text: "hi" }],
      },
    }),
  });
  await res.json();
  await handle.shutdown();

  const types = events.map((e) => e.type);
  assertEquals(types.includes("turn.started"), true);
  assertEquals(types.includes("message.completed"), true);
  const completed = events.find((e) => e.type === "message.completed")!;
  assertEquals(completed.sessionId, "s1");
  assertEquals(completed.requestId, "r1");
  assertEquals(completed.agent, "tester");
  assertEquals(completed.data.text, "hello");
});
