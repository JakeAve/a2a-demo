import { assertEquals } from "@std/assert";
import {
  ollamaSearchProvider,
  selectSearchProvider,
} from "../../src/agent/web-search.ts";
import { buildOllamaTools, type OllamaDeps } from "../../src/agent/ollama.ts";

Deno.test("selectSearchProvider returns a provider only when configured", () => {
  assertEquals(selectSearchProvider({}), undefined);
  assertEquals(typeof selectSearchProvider({ ollamaApiKey: "k" }), "function");
});

Deno.test("ollamaSearchProvider posts the query and maps results", async () => {
  let seen: { auth: string | null; body: unknown } = { auth: null, body: null };
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    seen = { auth: req.headers.get("authorization"), body: await req.json() };
    return new Response(
      JSON.stringify({ results: [{ title: "T", url: "https://e.com", content: "C" }] }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const port = (server.addr as Deno.NetAddr).port;

  const provider = ollamaSearchProvider("secret", `http://localhost:${port}/api/web_search`);
  const results = await provider("what is UDP", 3);

  await server.shutdown();
  assertEquals(seen.auth, "Bearer secret");
  assertEquals((seen.body as { query: string }).query, "what is UDP");
  assertEquals((seen.body as { max_results: number }).max_results, 3);
  assertEquals(results, [{ title: "T", url: "https://e.com", content: "C" }]);
});

Deno.test("buildOllamaTools adds web_search only when enabled with a provider", () => {
  const fakeProvider = () => Promise.resolve([]);
  const base = { model: "m", systemPrompt: "", baseUrl: "", store: null } as unknown as OllamaDeps;

  const none = buildOllamaTools(base);
  assertEquals(none.some((t) => t.function.name === "web_search"), false);

  const withSearch = buildOllamaTools({ ...base, webSearch: true, search: fakeProvider });
  assertEquals(withSearch.some((t) => t.function.name === "web_search"), true);

  // flag without a provider → not offered (e.g. no OLLAMA_API_KEY configured)
  const flagOnly = buildOllamaTools({ ...base, webSearch: true });
  assertEquals(flagOnly.some((t) => t.function.name === "web_search"), false);
});
