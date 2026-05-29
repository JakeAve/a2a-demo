import { assertEquals } from "@std/assert";
import { createEmitter } from "../../src/observability/emit.ts";
import type { EmitEvent } from "../../src/observability/events.ts";

const sample: EmitEvent = {
  sessionId: "s1", requestId: "r1", ts: 1, agent: "a", depth: 0,
  type: "turn.started", data: {},
};

Deno.test("createEmitter with no URL returns a no-op (never calls post)", async () => {
  let calls = 0;
  const emit = createEmitter(undefined, undefined, () => { calls++; return Promise.resolve(); });
  await emit(sample);
  assertEquals(calls, 0);
});

Deno.test("createEmitter with a URL posts the event to /ingest", async () => {
  let captured: { url: string; body: unknown } | null = null;
  const emit = createEmitter("http://mon:7891", "tok", (url, body) => {
    captured = { url, body };
    return Promise.resolve();
  });
  await emit(sample);
  assertEquals(captured!.url, "http://mon:7891/ingest");
  assertEquals((captured!.body as EmitEvent).agent, "a");
});

Deno.test("emit swallows post errors (never throws into the caller)", async () => {
  const emit = createEmitter("http://mon:7891", undefined, () => Promise.reject(new Error("down")));
  await emit(sample); // must not throw
  assertEquals(true, true);
});
