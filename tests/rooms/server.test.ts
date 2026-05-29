import { assertEquals } from "@std/assert";
import { startRoomBroker } from "../../src/rooms/server.ts";
import type { EmitEvent } from "../../src/observability/events.ts";
import type { InboxDelivery } from "../../src/rooms/types.ts";

async function harness() {
  const kv = await Deno.openKv(":memory:");
  const pushed: InboxDelivery[] = [];
  const events: EmitEvent[] = [];
  const inboxes: Record<string, string> = { Alvy: "http://alvy", Bex: "http://bex" };
  const broker = await startRoomBroker({
    kv, port: 0, token: "tok",
    resolveInbox: (name) => Promise.resolve(inboxes[name] ?? null),
    push: (_url, d) => { pushed.push(d); return Promise.resolve(true); },
    emit: (e) => { events.push(e); return Promise.resolve(); },
    agentDeadlineMs: 1000, humanDeadlineMs: 1000, defaultMaxTurns: 24,
  });
  const base = broker.url;
  const h = { "content-type": "application/json", "authorization": "Bearer tok" };
  return { kv, broker, base, h, pushed, events };
}

Deno.test("create + post pushes a delivery to the addressed member and emits events", async () => {
  const { kv, broker, base, h, pushed, events } = await harness();
  const created = await (await fetch(`${base}/rooms`, {
    method: "POST", headers: h,
    body: JSON.stringify({ title: "debate", members: ["Alvy", "Bex"], createdBy: "Alvy", sessionId: "s1" }),
  })).json();
  const roomId = created.roomId;

  const posted = await (await fetch(`${base}/rooms/${roomId}/post`, {
    method: "POST", headers: h,
    body: JSON.stringify({ from: "Alvy", text: "opening", to: ["Bex"] }),
  })).json();

  assertEquals(posted.seq, 0);
  assertEquals(pushed.length, 1);
  assertEquals(pushed[0].addressedBy, "Alvy");
  assertEquals(pushed[0].transcript.at(-1)?.text, "opening");
  assertEquals(events.some((e) => e.type === "room.created"), true);
  assertEquals(events.some((e) => e.type === "room.post"), true);
  await broker.shutdown(); kv.close();
});

// Note: harness only resolves "Alvy" and "Bex"; "Cy" is added via humanMembers
// (inline inboxUrl) so resolveInbox is not needed for Cy.
Deno.test("a member who left cannot post (403)", async () => {
  const { kv, broker, base, h } = await harness();
  const created = await (await fetch(`${base}/rooms`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      title: "t",
      members: ["Alvy", "Bex"],
      humanMembers: [{ name: "Cy", inboxUrl: "http://cy" }],
      createdBy: "Alvy",
      sessionId: "s1",
    }),
  })).json();
  const roomId = created.roomId;
  // Bex leaves; Alvy + Cy remain active so the room stays open.
  await fetch(`${base}/rooms/${roomId}/leave`, {
    method: "POST", headers: h, body: JSON.stringify({ agent: "Bex" }),
  });
  // Bex tries to post after leaving — must be rejected.
  const res = await fetch(`${base}/rooms/${roomId}/post`, {
    method: "POST", headers: h, body: JSON.stringify({ from: "Bex", text: "still here?", to: ["Alvy"] }),
  });
  // Room is still open (2 active members remain), so the active-member guard fires → 403.
  assertEquals(res.status, 403);
  await res.body?.cancel();
  await broker.shutdown(); kv.close();
});

Deno.test("post past maxTurns is rejected and emits room.capped", async () => {
  const { kv, broker, base, h, events } = await harness();
  const created = await (await fetch(`${base}/rooms`, {
    method: "POST", headers: h,
    body: JSON.stringify({ title: "t", members: ["Alvy", "Bex"], createdBy: "Alvy", sessionId: "s1", maxTurns: 1 }),
  })).json();
  const roomId = created.roomId;
  await fetch(`${base}/rooms/${roomId}/post`, {
    method: "POST", headers: h, body: JSON.stringify({ from: "Alvy", text: "1", to: ["Bex"] }),
  });
  const second = await fetch(`${base}/rooms/${roomId}/post`, {
    method: "POST", headers: h, body: JSON.stringify({ from: "Bex", text: "2", to: ["Alvy"] }),
  });
  assertEquals(second.status, 429);
  await second.body?.cancel();
  assertEquals(events.some((e) => e.type === "room.capped"), true);
  await broker.shutdown(); kv.close();
});

Deno.test("creator can post in a room it created without being listed in members", async () => {
  const { kv, broker, base, h, pushed } = await harness();
  // Alvy creates a room listing only Bex (the "members besides you" convention).
  const created = await (await fetch(`${base}/rooms`, {
    method: "POST", headers: h,
    body: JSON.stringify({ title: "t", members: ["Bex"], createdBy: "Alvy", sessionId: "s1" }),
  })).json();
  const roomId = created.roomId;
  // Alvy posts — must NOT be rejected 403 (Alvy was auto-added as creator).
  const res = await fetch(`${base}/rooms/${roomId}/post`, {
    method: "POST", headers: h, body: JSON.stringify({ from: "Alvy", text: "opening", to: ["Bex"] }),
  });
  assertEquals(res.status, 200);
  const json = await res.json();
  assertEquals(json.seq, 0);
  assertEquals(pushed.at(-1)?.addressedBy, "Alvy"); // delivery went to Bex
  await broker.shutdown(); kv.close();
});

Deno.test("join adds a human member who then receives pushed deliveries", async () => {
  const kv = await Deno.openKv(":memory:");
  const pushedTo: Array<{ url: string; delivery: InboxDelivery }> = [];
  const inboxes: Record<string, string> = { Alvy: "http://alvy" };
  const broker = await startRoomBroker({
    kv, port: 0, token: "tok",
    resolveInbox: (name) => Promise.resolve(inboxes[name] ?? null),
    push: (url, d) => { pushedTo.push({ url, delivery: d }); return Promise.resolve(true); },
    agentDeadlineMs: 1000, humanDeadlineMs: 1000, defaultMaxTurns: 24, sweepIntervalMs: 0,
  });
  const base = broker.url;
  const h = { "content-type": "application/json", "authorization": "Bearer tok" };

  const created = await (await fetch(`${base}/rooms`, {
    method: "POST", headers: h,
    body: JSON.stringify({ title: "t", members: ["Alvy"], createdBy: "Alvy", sessionId: "s1" }),
  })).json();
  const roomId = created.roomId;

  const joinRes = await fetch(`${base}/rooms/${roomId}/join`, {
    method: "POST", headers: h,
    body: JSON.stringify({ name: "human", inboxUrl: "http://repl" }),
  });
  assertEquals(joinRes.status, 200);
  await joinRes.body?.cancel();

  await fetch(`${base}/rooms/${roomId}/post`, {
    method: "POST", headers: h,
    body: JSON.stringify({ from: "Alvy", text: "hi human", to: ["human"] }),
  });

  assertEquals(pushedTo.length, 1);
  assertEquals(pushedTo[0].url, "http://repl");
  assertEquals(pushedTo[0].delivery.addressedBy, "Alvy");
  await broker.shutdown(); kv.close();
});
