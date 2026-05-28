import { assertEquals, assertThrows } from "@std/assert";
import { resolveClaudeCodeEnv } from "../../src/agent/claude-code.ts";

Deno.test("resolveClaudeCodeEnv prefers OAuth and drops the API key", () => {
  const env = resolveClaudeCodeEnv({ ANTHROPIC_API_KEY: "sk-api", FOO: "bar" }, "sk-oat", "sk-api");
  assertEquals(env.CLAUDE_CODE_OAUTH_TOKEN, "sk-oat");
  assertEquals("ANTHROPIC_API_KEY" in env, false);
  assertEquals(env.FOO, "bar");
});

Deno.test("resolveClaudeCodeEnv falls back to API key when no OAuth token", () => {
  const env = resolveClaudeCodeEnv({ CLAUDE_CODE_OAUTH_TOKEN: "stale" }, "", "sk-api");
  assertEquals(env.ANTHROPIC_API_KEY, "sk-api");
  assertEquals("CLAUDE_CODE_OAUTH_TOKEN" in env, false);
});

Deno.test("resolveClaudeCodeEnv throws when neither credential is set", () => {
  assertThrows(() => resolveClaudeCodeEnv({}, "", ""), Error, "requires");
});
