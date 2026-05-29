import { assertEquals } from "@std/assert";
import { sendMessage } from "../../src/protocol/client.ts";

Deno.test("sendMessage forwards x-session and x-request headers", async () => {
  let seen: Record<string, string | null> = {};
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    seen = {
      session: req.headers.get("x-session"),
      request: req.headers.get("x-request"),
      depth: req.headers.get("x-depth"),
    };
    return new Response(JSON.stringify({ text: "ok" }), {
      headers: { "content-type": "application/json" },
    });
  });
  const port = (server.addr as Deno.NetAddr).port;

  await sendMessage({
    url: `http://localhost:${port}`,
    token: "t",
    depth: 1,
    sessionId: "s1",
    requestId: "r1",
    message: { messageId: "m1", role: "agent", parts: [{ type: "text", text: "hi" }] },
  });

  await server.shutdown();
  assertEquals(seen.session, "s1");
  assertEquals(seen.request, "r1");
  assertEquals(seen.depth, "1");
});
