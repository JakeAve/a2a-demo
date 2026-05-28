import { assert, assertEquals } from "@std/assert";
import { isAgentCard, isMessage, type AgentCard, type Message } from "../../src/protocol/types.ts";

Deno.test("isAgentCard accepts a valid card", () => {
  const card: AgentCard = {
    name: "gemma3",
    description: "fast",
    version: "1.0.0",
    url: "http://localhost:1234",
    skills: [{ id: "general", name: "General", description: "anything" }],
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    security: [{ bearer: [] }],
  };
  assert(isAgentCard(card));
});

Deno.test("isAgentCard rejects missing fields", () => {
  assertEquals(isAgentCard({ name: "x" }), false);
  assertEquals(isAgentCard(null), false);
  assertEquals(isAgentCard("string"), false);
});

Deno.test("isMessage accepts a valid text message", () => {
  const m: Message = {
    messageId: "m1",
    role: "user",
    parts: [{ type: "text", text: "hi" }],
  };
  assert(isMessage(m));
});

Deno.test("isMessage rejects bad role", () => {
  assertEquals(isMessage({ messageId: "m1", role: "bad", parts: [] }), false);
});
