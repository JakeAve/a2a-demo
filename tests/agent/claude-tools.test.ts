import { assertEquals } from "@std/assert";
import { buildAnthropicTools } from "../../src/agent/claude.ts";
import type { ToolDeps } from "../../src/agent/tools.ts";

// buildAnthropicTools only reads selfName/spawnAgent off deps to shape the tool
// list, so a minimal stub is enough — no registry/store/network involved.
const deps = { selfName: "researcher" } as unknown as ToolDeps;

Deno.test("buildAnthropicTools omits web_search by default", () => {
  const tools = buildAnthropicTools(deps);
  const names = tools.map((t) => (t as { name?: string }).name);
  assertEquals(names.includes("web_search"), false);
  assertEquals(names.includes("list_agents"), true); // base A2A tools present
});

Deno.test("buildAnthropicTools appends the server web_search tool when enabled", () => {
  const tools = buildAnthropicTools(deps, true);
  const ws = tools.find((t) => (t as { name?: string }).name === "web_search") as
    | { type?: string }
    | undefined;
  assertEquals(ws?.type, "web_search_20250305");
  // the A2A tools are still there alongside it
  assertEquals(tools.some((t) => (t as { name?: string }).name === "list_agents"), true);
});
