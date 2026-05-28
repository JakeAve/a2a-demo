import { assert, assertEquals } from "@std/assert";
import { ThreadStore } from "../../src/store/threads.ts";

Deno.test("ThreadStore.start creates a thread and lists it under its parent", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new ThreadStore(kv);

  const meta = await store.start("parent-1", "gemma3", "haiku about frogs");
  assertEquals(meta.peer, "gemma3");
  assertEquals(meta.parentContextId, "parent-1");
  assertEquals(meta.turnCount, 0);
  assert(meta.threadId);

  const threads = await store.list("parent-1");
  assertEquals(threads.length, 1);
  assertEquals(threads[0].threadId, meta.threadId);
  kv.close();
});

Deno.test("ThreadStore.list isolates threads by parent", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new ThreadStore(kv);

  await store.start("parent-a", "gemma3", "task A");
  await store.start("parent-b", "gemma3", "task B");

  assertEquals((await store.list("parent-a")).length, 1);
  assertEquals((await store.list("parent-b")).length, 1);
  assertEquals((await store.list("parent-c")).length, 0);
  kv.close();
});

Deno.test("ThreadStore.touch increments turn count and updates lastUsedAt", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new ThreadStore(kv);

  const meta = await store.start("p", "gemma3", "t");
  const before = meta.lastUsedAt;

  // wait 5ms so the timestamp moves forward
  await new Promise((r) => setTimeout(r, 5));
  const after = await store.touch(meta.threadId);
  assert(after);
  assertEquals(after.turnCount, 1);
  assert(after.lastUsedAt > before, "lastUsedAt should advance");
  kv.close();
});

Deno.test("ThreadStore.touch returns null for unknown thread", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new ThreadStore(kv);
  assertEquals(await store.touch("nope"), null);
  kv.close();
});

Deno.test("ThreadStore.reset clears metadata, owner index, and context history", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new ThreadStore(kv);

  const meta = await store.start("p", "gemma3", "t");
  await kv.set(["context", meta.threadId], [{ role: "user", content: "hi" }]);

  const ok = await store.reset(meta.threadId);
  assert(ok);
  assertEquals(await store.get(meta.threadId), null);
  assertEquals((await store.list("p")).length, 0);
  const ctx = await kv.get(["context", meta.threadId]);
  assertEquals(ctx.value, null);
  kv.close();
});
