import { assert, assertEquals } from "@std/assert";
import { a2aToolNames, makeToolHandler } from "../../src/agent/claude-code-tools.ts";
import type { ToolDeps } from "../../src/agent/tools.ts";

const baseDeps = { selfName: "me", bearerToken: "t" } as unknown as ToolDeps;
const spawnDeps = { ...baseDeps, spawnAgent: async () => ({ ok: true }) } as unknown as ToolDeps;

Deno.test("a2aToolNames omits spawn tools without spawnAgent", () => {
  const names = a2aToolNames(baseDeps);
  assert(names.includes("mcp__a2a__delegate_start"));
  assert(!names.includes("mcp__a2a__spawn_agent"));
});

Deno.test("a2aToolNames includes spawn tools with spawnAgent", () => {
  const names = a2aToolNames(spawnDeps);
  assert(names.includes("mcp__a2a__spawn_agent"));
  assert(names.includes("mcp__a2a__list_roles"));
});

Deno.test("makeToolHandler delegates to the runner with depth + contextId and wraps the result", async () => {
  let captured: unknown[] = [];
  const fakeRun = async (...a: unknown[]) => { captured = a; return '{"ok":true}'; };
  const handler = makeToolHandler(baseDeps, "delegate_start", 1, "ctx-9", fakeRun);
  const out = await handler({ agent: "peer", prompt: "hi" });
  assertEquals(out, { content: [{ type: "text", text: '{"ok":true}' }] });
  assertEquals(captured[1], "delegate_start");
  assertEquals(captured[2], { agent: "peer", prompt: "hi" });
  assertEquals(captured[3], 1);
  assertEquals(captured[4], "ctx-9");
});
