import { assertEquals } from "@std/assert";
import { startReplInbox } from "../src/repl.ts";
import type { InboxDelivery } from "../src/rooms/types.ts";

function delivery(roomId: string): InboxDelivery {
  return { roomId, turnId: "t", addressedBy: "Bex", title: "t", members: [], transcript: [] };
}

Deno.test("startReplInbox returns 202 and invokes onDelivery", async () => {
  const seen: string[] = [];
  const inbox = startReplInbox({ token: "tok", onDelivery: (d) => { seen.push(d.roomId); } });
  const res = await fetch(`${inbox.url}/inbox`, {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": "Bearer tok" },
    body: JSON.stringify(delivery("r1")),
  });
  await res.body?.cancel();
  assertEquals(res.status, 202);
  await inbox.drain();
  assertEquals(seen, ["r1"]);
  await inbox.shutdown();
});

Deno.test("startReplInbox rejects a bad token with 401", async () => {
  const inbox = startReplInbox({ token: "tok", onDelivery: () => {} });
  const res = await fetch(`${inbox.url}/inbox`, {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": "Bearer wrong" },
    body: JSON.stringify(delivery("r1")),
  });
  await res.body?.cancel();
  assertEquals(res.status, 401);
  await inbox.shutdown();
});
