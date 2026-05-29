import { assertEquals } from "@std/assert";
import { makeRoomTurnProcessor } from "../../src/agent/room-turn.ts";
import type { RoomTurnState, InboxDelivery } from "../../src/rooms/types.ts";

function delivery(): InboxDelivery {
  return {
    roomId: "r1", turnId: "T1", addressedBy: "Alvy", title: "t", members: ["Alvy", "Bex"],
    transcript: [{ seq: 0, roomId: "r1", from: "Alvy", to: ["Bex"], text: "hi", ts: 1 }],
  };
}
const store = { clear: () => Promise.resolve() } as never;

Deno.test("prose reply (no post call) is wrapped as a post to the addresser", async () => {
  const calls: Array<{ kind: string; body: unknown }> = [];
  const roomTurn: RoomTurnState = { active: null };
  const proc = makeRoomTurnProcessor({
    selfName: "Bex",
    handler: () => Promise.resolve({ text: "a fair point, Alvy" }),
    rooms: {
      post: (_r: string, b: unknown) => { calls.push({ kind: "post", body: b }); return Promise.resolve({ seq: 1 }); },
      ack: (_r: string, b: unknown) => { calls.push({ kind: "ack", body: b }); return Promise.resolve(); },
    } as never,
    roomTurn, store,
  });
  await proc(delivery());
  assertEquals(calls.length, 1);
  assertEquals(calls[0].kind, "post");
  assertEquals((calls[0].body as { to: string[] }).to, ["Alvy"]);
  assertEquals((calls[0].body as { turnId: string }).turnId, "T1");
});

Deno.test("empty reply acks the delivery", async () => {
  const calls: string[] = [];
  const roomTurn: RoomTurnState = { active: null };
  const proc = makeRoomTurnProcessor({
    selfName: "Bex",
    handler: () => Promise.resolve({ text: "   " }),
    rooms: {
      post: () => { calls.push("post"); return Promise.resolve({ seq: 1 }); },
      ack: () => { calls.push("ack"); return Promise.resolve(); },
    } as never,
    roomTurn, store,
  });
  await proc(delivery());
  assertEquals(calls, ["ack"]);
});

Deno.test("when the handler already posted, no wrap/ack happens", async () => {
  const calls: string[] = [];
  const roomTurn: RoomTurnState = { active: null };
  const proc = makeRoomTurnProcessor({
    selfName: "Bex",
    handler: () => { roomTurn.active!.posted = true; return Promise.resolve({ text: "" }); },
    rooms: {
      post: () => { calls.push("post"); return Promise.resolve({ seq: 1 }); },
      ack: () => { calls.push("ack"); return Promise.resolve(); },
    } as never,
    roomTurn, store,
  });
  await proc(delivery());
  assertEquals(calls, []);
});

Deno.test("room-turn processor uses d.sessionId for ctx.sessionId when provided", async () => {
  let capturedSessionId: string | undefined;
  const roomTurn: RoomTurnState = { active: null };
  const proc = makeRoomTurnProcessor({
    selfName: "Bex",
    handler: (ctx) => {
      capturedSessionId = ctx.sessionId;
      return Promise.resolve({ text: "" });
    },
    rooms: {
      post: () => Promise.resolve({ seq: 0 }),
      ack: () => Promise.resolve(),
    } as never,
    roomTurn, store,
  });
  const d: InboxDelivery = {
    roomId: "r1", turnId: "T2", addressedBy: "Alvy", title: "t",
    members: ["Alvy", "Bex"], transcript: [], sessionId: "session-xyz",
  };
  await proc(d);
  assertEquals(capturedSessionId, "session-xyz");
});

Deno.test("room-turn processor falls back to empty sessionId when sessionId absent", async () => {
  let capturedSessionId: string | undefined;
  const roomTurn: RoomTurnState = { active: null };
  const proc = makeRoomTurnProcessor({
    selfName: "Bex",
    handler: (ctx) => {
      capturedSessionId = ctx.sessionId;
      return Promise.resolve({ text: "" });
    },
    rooms: { post: () => Promise.resolve({ seq: 0 }), ack: () => Promise.resolve() } as never,
    roomTurn, store,
  });
  await proc(delivery()); // delivery() has no sessionId field
  assertEquals(capturedSessionId, "");
});
