import { assertEquals } from "@std/assert";
import { RoomBrokerClient } from "../../src/rooms/client.ts";

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const orig = globalThis.fetch;
  globalThis.fetch =
    ((input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(handler(String(input), init ?? {}))) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

Deno.test("createRoom POSTs and returns roomId", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const restore = stubFetch((url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ roomId: "r1", unresolved: [] }), {
      status: 200,
    });
  });
  const client = new RoomBrokerClient("http://broker", "tok");
  const res = await client.createRoom({
    title: "t",
    members: ["Alvy", "Bex"],
    createdBy: "Alvy",
    sessionId: "s1",
  });
  restore();
  assertEquals(res.roomId, "r1");
  assertEquals(calls[0].url, "http://broker/rooms");
  assertEquals((calls[0].body as { title: string }).title, "t");
});

Deno.test("post sends from/text/to/turnId", async () => {
  let captured: unknown;
  const restore = stubFetch((_url, init) => {
    captured = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ seq: 3 }), { status: 200 });
  });
  const client = new RoomBrokerClient("http://broker", "tok");
  const res = await client.post("r1", {
    from: "Bex",
    text: "hi",
    to: ["Alvy"],
    turnId: "T1",
  });
  restore();
  assertEquals(res.seq, 3);
  assertEquals(captured, {
    from: "Bex",
    text: "hi",
    to: ["Alvy"],
    turnId: "T1",
  });
});

Deno.test("join POSTs name/inboxUrl/kind", async () => {
  let captured: unknown;
  let capturedUrl = "";
  const restore = stubFetch((url, init) => {
    capturedUrl = url;
    captured = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const client = new RoomBrokerClient("http://broker", "tok");
  await client.join("r1", { name: "human", inboxUrl: "http://repl:5000" });
  restore();
  assertEquals(capturedUrl, "http://broker/rooms/r1/join");
  assertEquals(captured, { name: "human", inboxUrl: "http://repl:5000" });
});
