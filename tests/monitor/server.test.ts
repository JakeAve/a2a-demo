import { assertEquals } from "@std/assert";
import { startMonitor } from "../../monitor/server.ts";

Deno.test("POST /ingest persists and GET /api/sessions returns it", async () => {
  const kv = await Deno.openKv(":memory:");
  const mon = await startMonitor({ kv, port: 0, token: "" });

  const post = await fetch(`${mon.url}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: "s1", requestId: "r1", ts: 1, agent: "REPL", depth: 0,
      type: "request.started", data: { target: "coordinator", prompt: "hi" },
    }),
  });
  assertEquals(post.status, 200);

  const sessions = await (await fetch(`${mon.url}/api/sessions`)).json();
  assertEquals(sessions.length, 1);
  assertEquals(sessions[0].sessionId, "s1");

  const detail = await (await fetch(`${mon.url}/api/sessions/s1`)).json();
  assertEquals(detail.events.length, 1);
  assertEquals(detail.summary.sessionId, "s1");

  await mon.shutdown();
  kv.close();
});

Deno.test("POST /ingest rejects a malformed envelope", async () => {
  const kv = await Deno.openKv(":memory:");
  const mon = await startMonitor({ kv, port: 0, token: "" });
  const res = await fetch(`${mon.url}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nope: true }),
  });
  assertEquals(res.status, 400);
  await mon.shutdown();
  kv.close();
});

Deno.test("GET /stream delivers a posted event to a subscriber", async () => {
  const kv = await Deno.openKv(":memory:");
  const mon = await startMonitor({ kv, port: 0, token: "" });
  const res = await fetch(`${mon.url}/stream?session=s1`, { headers: { accept: "text/event-stream" } });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();

  await fetch(`${mon.url}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: "s1", requestId: "r1", ts: 1, agent: "a", depth: 0, type: "turn.started", data: {},
    }),
  });

  let got = "";
  while (!got.includes("turn.started")) {
    const { value, done } = await reader.read();
    if (done) break;
    got += value;
  }
  assertEquals(got.includes("turn.started"), true);
  await reader.cancel();
  await mon.shutdown();
  kv.close();
});
