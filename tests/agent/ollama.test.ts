import { assertEquals } from "@std/assert";
import { makeOllamaHandlers } from "../../src/agent/ollama.ts";
import type { ContextStore } from "../../src/store/context.ts";

function mockStore(): ContextStore {
  const data = new Map<string, unknown[]>();
  return {
    get: async (id: string) => (data.get(id) ?? []) as never,
    append: async (id: string, m: unknown) => {
      const arr = data.get(id) ?? [];
      arr.push(m);
      data.set(id, arr);
    },
    clear: async (id: string) => { data.delete(id); },
  } as unknown as ContextStore;
}

Deno.test("ollama handler: forwards prompt and stores history", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit)?.body ?? "{}"));
    assertEquals(body.model, "gemma3");
    return new Response(JSON.stringify({ message: { content: "hi back" } }), { status: 200 });
  }) as typeof fetch;

  const store = mockStore();
  const { handler } = makeOllamaHandlers({
    model: "gemma3",
    systemPrompt: "be brief",
    baseUrl: "http://localhost:11434",
    store,
  });

  const result = await handler({
    depth: 0,
    message: { messageId: "1", role: "user", parts: [{ type: "text", text: "hi" }], contextId: "c1" },
  });

  assertEquals(result.text, "hi back");
  assertEquals((await store.get("c1")).length, 2);
  globalThis.fetch = origFetch;
});
