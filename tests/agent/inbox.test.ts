import { assertEquals } from "@std/assert";
import { InboxQueue } from "../../src/agent/inbox.ts";

Deno.test("InboxQueue processes deliveries one at a time, in order", async () => {
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;
  const q = new InboxQueue(async (d: { id: string }) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10));
    order.push(d.id);
    active--;
  });
  q.enqueue({ id: "a" });
  q.enqueue({ id: "b" });
  q.enqueue({ id: "c" });
  await q.drain();
  assertEquals(order, ["a", "b", "c"]);
  assertEquals(maxActive, 1); // never concurrent
});

import { startAgent } from "../../src/agent/base.ts";
import type { AgentCard } from "../../src/protocol/types.ts";

const card: AgentCard = {
  name: "T",
  description: "",
  version: "1.0.0",
  url: "http://localhost:0",
  skills: [],
  securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
  security: [{ bearer: [] }],
};

Deno.test("POST /inbox returns 202 and invokes onInbox", async () => {
  const seen: string[] = [];
  const handle = await startAgent({
    card,
    bearerToken: "tok",
    handler: () => Promise.resolve({ text: "" }),
    // deno-lint-ignore require-yield
    streamHandler: async function* () {
      return;
    },
    onInbox: (d) => {
      seen.push(d.roomId);
      return Promise.resolve();
    },
  });
  const res = await fetch(`http://localhost:${handle.port}/inbox`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": "Bearer tok",
    },
    body: JSON.stringify({
      roomId: "r1",
      turnId: "T1",
      addressedBy: "x",
      title: "t",
      members: [],
      transcript: [],
    }),
  });
  await res.body?.cancel();
  assertEquals(res.status, 202);
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(seen, ["r1"]);
  await handle.shutdown();
});
