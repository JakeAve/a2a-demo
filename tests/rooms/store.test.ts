import { assertEquals } from "@std/assert";
import { RoomStore } from "../../src/rooms/store.ts";

function fixedClock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

async function freshStore() {
  const kv = await Deno.openKv(":memory:");
  const clock = fixedClock();
  return { store: new RoomStore(kv, clock.now), kv, clock };
}

Deno.test("createRoom stores members and is retrievable", async () => {
  const { store, kv } = await freshStore();
  const room = await store.createRoom({
    title: "debate", createdBy: "Alvy", sessionId: "s1", maxTurns: 24,
    members: [
      { name: "Alvy", inboxUrl: "http://a", kind: "agent" },
      { name: "Bex", inboxUrl: "http://b", kind: "agent" },
    ],
  });
  assertEquals(room.members.length, 2);
  assertEquals(room.status, "open");
  assertEquals(room.turnCount, 0);
  const got = await store.getRoom(room.roomId);
  assertEquals(got?.title, "debate");
  assertEquals(got?.members[0].active, true);
  kv.close();
});

Deno.test("appendMessage assigns increasing seq and bumps turnCount", async () => {
  const { store, kv } = await freshStore();
  const room = await store.createRoom({
    title: "t", createdBy: "Alvy", sessionId: "s1", maxTurns: 24,
    members: [{ name: "Alvy", inboxUrl: "http://a", kind: "agent" }],
  });
  const m0 = await store.appendMessage(room.roomId, { from: "Alvy", to: ["Bex"], text: "one" });
  const m1 = await store.appendMessage(room.roomId, { from: "Bex", to: ["Alvy"], text: "two" });
  assertEquals(m0.seq, 0);
  assertEquals(m1.seq, 1);
  const transcript = await store.getTranscript(room.roomId);
  assertEquals(transcript.map((m) => m.text), ["one", "two"]);
  assertEquals((await store.getRoom(room.roomId))?.turnCount, 2);
  kv.close();
});

Deno.test("listRoomsByMember returns rooms a member belongs to", async () => {
  const { store, kv } = await freshStore();
  const r = await store.createRoom({
    title: "t", createdBy: "Alvy", sessionId: "s1", maxTurns: 24,
    members: [{ name: "Alvy", inboxUrl: "http://a", kind: "agent" }],
  });
  const rooms = await store.listRoomsByMember("Alvy");
  assertEquals(rooms.map((x) => x.roomId), [r.roomId]);
  kv.close();
});

Deno.test("delivery lifecycle drives the idle check", async () => {
  const { store, kv } = await freshStore();
  const r = await store.createRoom({
    title: "t", createdBy: "Alvy", sessionId: "s1", maxTurns: 24,
    members: [
      { name: "Alvy", inboxUrl: "http://a", kind: "agent" },
      { name: "Bex", inboxUrl: "http://b", kind: "agent" },
    ],
  });
  assertEquals(await store.isIdle(r.roomId), true);
  const t1 = await store.createDelivery(r.roomId, "Bex", "Alvy", 5000);
  assertEquals(await store.isIdle(r.roomId), false);
  await store.resolveDelivery(r.roomId, t1.turnId);
  assertEquals(await store.isIdle(r.roomId), true);
  kv.close();
});

Deno.test("sweepExpired resolves only past-deadline pending deliveries", async () => {
  const { store, kv, clock } = await freshStore();
  const r = await store.createRoom({
    title: "t", createdBy: "Alvy", sessionId: "s1", maxTurns: 24,
    members: [{ name: "Bex", inboxUrl: "http://b", kind: "agent" }],
  });
  const t1 = await store.createDelivery(r.roomId, "Bex", "Alvy", 100); // deadline now+100
  clock.advance(50);
  assertEquals((await store.sweepExpired()).length, 0);   // not yet past
  clock.advance(100);                                      // now past
  const swept = await store.sweepExpired();
  assertEquals(swept.map((d) => d.turnId), [t1.turnId]);
  assertEquals(await store.isIdle(r.roomId), true);
  kv.close();
});

Deno.test("atTurnCap is true once turnCount reaches maxTurns", async () => {
  const { store, kv } = await freshStore();
  const r = await store.createRoom({
    title: "t", createdBy: "Alvy", sessionId: "s1", maxTurns: 2,
    members: [{ name: "Alvy", inboxUrl: "http://a", kind: "agent" }],
  });
  assertEquals(await store.atTurnCap(r.roomId), false);
  await store.appendMessage(r.roomId, { from: "Alvy", to: [], text: "1" });
  await store.appendMessage(r.roomId, { from: "Alvy", to: [], text: "2" });
  assertEquals(await store.atTurnCap(r.roomId), true);
  kv.close();
});

Deno.test("deactivateMember reports when fewer than 2 active remain", async () => {
  const { store, kv } = await freshStore();
  const r = await store.createRoom({
    title: "t", createdBy: "Alvy", sessionId: "s1", maxTurns: 24,
    members: [
      { name: "Alvy", inboxUrl: "http://a", kind: "agent" },
      { name: "Bex", inboxUrl: "http://b", kind: "agent" },
    ],
  });
  assertEquals(await store.deactivateMember(r.roomId, "Alvy"), true); // 1 active left -> should close
  assertEquals((await store.getRoom(r.roomId))?.members.find((m) => m.name === "Alvy")?.active, false);
  kv.close();
});
