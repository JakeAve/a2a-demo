import { assertEquals } from "@std/assert";
import { SessionStore } from "../../src/store/sessions.ts";

Deno.test("SessionStore round-trips a session id by contextId", async () => {
  const kv = await Deno.openKv(":memory:");
  const sessions = new SessionStore(kv);
  assertEquals(await sessions.get("ctx-1"), undefined);
  await sessions.set("ctx-1", "sess-abc");
  assertEquals(await sessions.get("ctx-1"), "sess-abc");
  assertEquals(await sessions.get("ctx-2"), undefined);
  kv.close();
});
