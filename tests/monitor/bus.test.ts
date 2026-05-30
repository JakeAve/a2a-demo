import { assertEquals } from "@std/assert";
import { EventBus } from "../../monitor/bus.ts";
import type { A2AEvent } from "../../src/observability/events.ts";

function ev(sessionId: string): A2AEvent {
  return {
    sessionId,
    requestId: "r1",
    seq: 0,
    ts: 1,
    agent: "a",
    depth: 0,
    type: "turn.started",
    data: {},
  };
}

Deno.test("subscribers receive events for their session only", () => {
  const bus = new EventBus();
  const s1: A2AEvent[] = [];
  const s2: A2AEvent[] = [];
  const unsub1 = bus.subscribe("s1", (e) => s1.push(e));
  bus.subscribe("s2", (e) => s2.push(e));
  bus.publish(ev("s1"));
  assertEquals(s1.length, 1);
  assertEquals(s2.length, 0);
  unsub1();
  bus.publish(ev("s1"));
  assertEquals(s1.length, 1); // unsubscribed
});

Deno.test("wildcard subscribers receive every event", () => {
  const bus = new EventBus();
  const all: A2AEvent[] = [];
  bus.subscribe("*", (e) => all.push(e));
  bus.publish(ev("s1"));
  bus.publish(ev("s2"));
  assertEquals(all.length, 2);
});
