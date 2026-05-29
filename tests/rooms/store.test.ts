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
