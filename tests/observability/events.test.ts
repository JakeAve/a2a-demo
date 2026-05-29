// tests/observability/events.test.ts
import { assertEquals } from "@std/assert";
import { EVENT_TYPES, parseEvent } from "../../src/observability/events.ts";

Deno.test("parseEvent accepts a well-formed milestone event", () => {
  const ev = {
    sessionId: "s1",
    requestId: "r1",
    seq: 0,
    ts: 1234,
    agent: "coordinator",
    depth: 0,
    type: "delegate.start",
    data: { peer: "scout", threadId: "t1", prompt: "hi" },
  };
  const parsed = parseEvent(ev);
  assertEquals(parsed.agent, "coordinator");
  assertEquals(parsed.data.peer, "scout");
});

Deno.test("parseEvent rejects an unknown type", () => {
  let threw = false;
  try {
    parseEvent({
      sessionId: "s1", requestId: "r1", seq: 0, ts: 1, agent: "a",
      depth: 0, type: "not.a.type", data: {},
    });
  } catch { threw = true; }
  assertEquals(threw, true);
});

Deno.test("EVENT_TYPES lists every milestone type", () => {
  assertEquals(EVENT_TYPES.includes("message.completed"), true);
  assertEquals(EVENT_TYPES.includes("spawn"), true);
});

Deno.test("parseEvent accepts a room.post with roomId", () => {
  const ev = parseEvent({
    sessionId: "s1", requestId: "room-1", seq: 0, ts: 1, agent: "Alvy",
    depth: 0, roomId: "room-1", type: "room.post",
    data: { from: "Alvy", to: ["Bex"], seq: 0, text: "hi" },
  });
  assertEquals(ev.type, "room.post");
  assertEquals(ev.roomId, "room-1");
});

Deno.test("parseEvent still accepts a non-room event without roomId", () => {
  const ev = parseEvent({
    sessionId: "s1", requestId: "r1", seq: 0, ts: 1, agent: "x",
    depth: 0, type: "turn.started", data: {},
  });
  assertEquals(ev.roomId, undefined);
});
