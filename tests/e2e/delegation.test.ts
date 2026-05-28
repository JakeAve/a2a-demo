import { assert, assertEquals } from "@std/assert";
import { startRegistry } from "../../src/registry/server.ts";
import { RegistryClient } from "../../src/registry/client.ts";
import { startAgent } from "../../src/agent/base.ts";
import { sendMessage } from "../../src/protocol/client.ts";
import type { AgentCard } from "../../src/protocol/types.ts";

function card(name: string): AgentCard {
  return {
    name, description: "t", version: "1.0.0",
    url: "http://localhost:0",
    skills: [{ id: "x", name: "x", description: "x" }],
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    security: [{ bearer: [] }],
  };
}

Deno.test("e2e: agent A delegates to agent B and gets a result", async () => {
  const reg = await startRegistry(0);
  const regClient = new RegistryClient(`http://localhost:${reg.port}`);
  const token = "tok";

  // B: leaf agent that echoes prompt
  let bReceivedDepth = -1;
  const b = await startAgent({
    card: card("bravo"),
    bearerToken: token,
    handler: async (ctx) => {
      bReceivedDepth = ctx.depth;
      const text = ctx.message.parts.find((p) => p.type === "text")?.text ?? "";
      return { text: `B-echo:${text}` };
    },
    streamHandler: async function* () { yield { type: "done" }; },
  });
  await regClient.register(b.card);

  // A: delegates to B
  const a = await startAgent({
    card: card("alpha"),
    bearerToken: token,
    handler: async (ctx) => {
      const peer = await regClient.get("bravo");
      assert(peer, "bravo should be registered");
      const res = await sendMessage({
        url: peer!.url,
        token,
        depth: ctx.depth + 1,
        message: { messageId: "m2", role: "agent", parts: [{ type: "text", text: "hello-from-A" }] },
      });
      return { text: `A-wraps:${res.text}` };
    },
    streamHandler: async function* () { yield { type: "done" }; },
  });
  await regClient.register(a.card);

  const result = await sendMessage({
    url: a.card.url,
    token,
    depth: 0,
    message: { messageId: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
  });

  assertEquals(result.text, "A-wraps:B-echo:hello-from-A");
  assertEquals(bReceivedDepth, 1);

  await a.shutdown();
  await b.shutdown();
  await reg.shutdown();
});

Deno.test("e2e: depth 2 rejection", async () => {
  const b = await startAgent({
    card: card("bravo"),
    bearerToken: "tok",
    handler: async () => ({ text: "ok" }),
    streamHandler: async function* () { yield { type: "done" }; },
  });

  let threw = false;
  try {
    await sendMessage({
      url: b.card.url,
      token: "tok",
      depth: 2,
      message: { messageId: "m", role: "user", parts: [{ type: "text", text: "x" }] },
    });
  } catch (e) {
    threw = (e as Error).message.includes("max delegation depth");
  }
  assert(threw, "should have rejected depth 2");
  await b.shutdown();
});
