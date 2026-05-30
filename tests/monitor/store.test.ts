import { assertEquals } from "@std/assert";
import { MonitorStore } from "../../monitor/store.ts";
import type { EmitEvent } from "../../src/observability/events.ts";

function ev(partial: Partial<EmitEvent>): EmitEvent {
  return {
    sessionId: "s1",
    requestId: "r1",
    ts: 1,
    agent: "a",
    depth: 0,
    type: "turn.started",
    data: {},
    ...partial,
  };
}

Deno.test("ingest assigns monotonic seq per session and persists", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new MonitorStore(kv);
  const a = await store.ingest(ev({ type: "request.started" }));
  const b = await store.ingest(ev({ type: "turn.started" }));
  assertEquals(a.seq, 0);
  assertEquals(b.seq, 1);

  const events = await store.getSessionEvents("s1");
  assertEquals(events.length, 2);
  assertEquals(events[0].seq, 0);
  assertEquals(events[1].seq, 1);
  kv.close();
});

Deno.test("session summary tracks agents, requests, lastSeq", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new MonitorStore(kv);
  await store.ingest(
    ev({ agent: "REPL", type: "request.started", requestId: "r1" }),
  );
  await store.ingest(
    ev({ agent: "coordinator", type: "turn.started", requestId: "r1" }),
  );
  await store.ingest(
    ev({ agent: "REPL", type: "request.started", requestId: "r2" }),
  );

  const list = await store.listSessions();
  assertEquals(list.length, 1);
  assertEquals(list[0].sessionId, "s1");
  assertEquals(list[0].requestCount, 2);
  assertEquals(list[0].agents.sort(), ["REPL", "coordinator"]);
  assertEquals(list[0].lastSeq, 2);
  kv.close();
});

Deno.test("seq rehydrates after a store restart on the same kv", async () => {
  const kv = await Deno.openKv(":memory:");
  const s1 = new MonitorStore(kv);
  await s1.ingest(ev({}));
  await s1.ingest(ev({}));
  const s2 = new MonitorStore(kv); // fresh instance, same kv
  const c = await s2.ingest(ev({}));
  assertEquals(c.seq, 2);
  kv.close();
});
