// tests/e2e/monitor.test.ts
// Drives the real emitter against a real monitor server, then asserts the
// persisted events reconstruct the expected tree.
import { assertEquals } from "@std/assert";
import { startMonitor } from "../../monitor/server.ts";
import { createEmitter } from "../../src/observability/emit.ts";

Deno.test("emitted events for a delegation correlate under one session", async () => {
  const kv = await Deno.openKv(":memory:");
  const mon = await startMonitor({ kv, port: 0, token: "" });
  const emit = createEmitter(mon.url, undefined);

  const sessionId = "sess-e2e";
  const requestId = "req-1";
  const base = { sessionId, requestId };
  await emit({ ...base, agent: "REPL", depth: 0, ts: 1, type: "request.started", data: { target: "coordinator" } });
  await emit({ ...base, agent: "coordinator", depth: 0, ts: 2, type: "turn.started", data: {} });
  await emit({ ...base, agent: "coordinator", depth: 0, ts: 3, type: "delegate.start", data: { peer: "scout" }, threadId: "t1" });
  await emit({ ...base, agent: "scout", depth: 1, ts: 4, type: "message.completed", data: { text: "haiku" } });
  await emit({ ...base, agent: "coordinator", depth: 0, ts: 5, type: "delegate.return", data: { peer: "scout", ok: true }, threadId: "t1" });
  await emit({ ...base, agent: "coordinator", depth: 0, ts: 6, type: "message.completed", data: { text: "final" } });

  // Allow fire-and-forget POSTs to land.
  // Bumped from 300ms → 600ms: the 6 concurrent fire-and-forget POSTs can
  // race under load and the shorter delay proved flaky.
  await new Promise((r) => setTimeout(r, 600));

  const detail = await (await fetch(`${mon.url}/api/sessions/${sessionId}`)).json();
  assertEquals(detail.events.length, 6);
  assertEquals(detail.summary.agents.sort(), ["REPL", "coordinator", "scout"]);
  // seq is monotonic and dense.
  // deno-lint-ignore no-explicit-any
  assertEquals(detail.events.map((e: any) => e.seq), [0, 1, 2, 3, 4, 5]);
  // deno-lint-ignore no-explicit-any
  const del = detail.events.find((e: any) => e.type === "delegate.start");
  assertEquals(del.data.peer, "scout");
  assertEquals(del.threadId, "t1");

  await mon.shutdown();
  kv.close();
});
