import { assertEquals } from "@std/assert";
import {
  ollamaSearchProvider,
  selectSearchProvider,
} from "../../src/agent/web-search.ts";
import { buildOllamaTools, type OllamaDeps } from "../../src/agent/ollama.ts";
import { runTool, type ToolDeps } from "../../src/agent/tools.ts";
import type { EmitEvent } from "../../src/observability/events.ts";

Deno.test("selectSearchProvider returns a provider only when configured", () => {
  assertEquals(selectSearchProvider({}), undefined);
  assertEquals(typeof selectSearchProvider({ ollamaApiKey: "k" }), "function");
});

Deno.test("ollamaSearchProvider posts the query and maps results", async () => {
  let seen: { auth: string | null; body: unknown } = { auth: null, body: null };
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    seen = { auth: req.headers.get("authorization"), body: await req.json() };
    return new Response(
      JSON.stringify({
        results: [{ title: "T", url: "https://e.com", content: "C" }],
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const port = (server.addr as Deno.NetAddr).port;

  const provider = ollamaSearchProvider(
    "secret",
    `http://localhost:${port}/api/web_search`,
  );
  const results = await provider("what is UDP", 3);

  await server.shutdown();
  assertEquals(seen.auth, "Bearer secret");
  assertEquals((seen.body as { query: string }).query, "what is UDP");
  assertEquals((seen.body as { max_results: number }).max_results, 3);
  assertEquals(results, [{ title: "T", url: "https://e.com", content: "C" }]);
});

Deno.test("runTool(web_search) emits a tool.call and returns provider results", async () => {
  const events: EmitEvent[] = [];
  const deps = {
    selfName: "researcher",
    emit: (e: EmitEvent) => {
      events.push(e);
      return Promise.resolve();
    },
    search: () =>
      Promise.resolve([{ title: "T", url: "https://e.com", content: "c" }]),
  } as unknown as ToolDeps;

  const out = await runTool(deps, "web_search", { query: "udp" }, 1, "ctx", {
    sessionId: "s",
    requestId: "r",
  });

  const call = events.find((e) => e.type === "tool.call");
  assertEquals(call?.data.tool, "web_search");
  assertEquals(call?.agent, "researcher");
  assertEquals(JSON.parse(out).results[0].title, "T");
});

Deno.test("buildOllamaTools includes web_search iff the ToolDeps has a provider", () => {
  const fakeProvider = () => Promise.resolve([]);
  const base = {
    model: "m",
    systemPrompt: "",
    baseUrl: "",
    store: null,
  } as unknown as OllamaDeps;
  const hasWebSearch = (deps: OllamaDeps) =>
    buildOllamaTools(deps).some((t) => t.function.name === "web_search");

  // no tool runner at all → no web_search
  assertEquals(hasWebSearch(base), false);

  // tool runner without a provider → no web_search
  const toolsNoSearch = { selfName: "a" } as unknown as ToolDeps;
  assertEquals(hasWebSearch({ ...base, tools: toolsNoSearch }), false);

  // tool runner with a provider → web_search offered
  const toolsWithSearch = {
    selfName: "a",
    search: fakeProvider,
  } as unknown as ToolDeps;
  assertEquals(hasWebSearch({ ...base, tools: toolsWithSearch }), true);
});
