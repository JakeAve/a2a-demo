import { assertEquals } from "@std/assert";
import { ContextStore } from "../../src/store/context.ts";

Deno.test("ContextStore appends and reads in order", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new ContextStore(kv);

  await store.append("ctx1", { role: "user", content: "hi" });
  await store.append("ctx1", { role: "assistant", content: "hello" });
  await store.append("ctx1", { role: "user", content: "how are you" });

  const history = await store.get("ctx1");
  assertEquals(history.length, 3);
  assertEquals(history[0].content, "hi");
  assertEquals(history[2].content, "how are you");
  kv.close();
});

Deno.test("ContextStore isolates contexts", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new ContextStore(kv);
  await store.append("a", { role: "user", content: "from a" });
  await store.append("b", { role: "user", content: "from b" });
  assertEquals((await store.get("a")).length, 1);
  assertEquals((await store.get("b"))[0].content, "from b");
  kv.close();
});

Deno.test("ContextStore.get returns [] for unknown id", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new ContextStore(kv);
  assertEquals(await store.get("nope"), []);
  kv.close();
});
