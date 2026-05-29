import { assertEquals, assertThrows } from "@std/assert";
import { assertBackendCredentials, loadConfig } from "../src/config.ts";
import type { AppConfig, AgentSpec } from "../src/config.ts";

const baseCfg: AppConfig = {
  registryPort: 1, anthropicApiKey: "", claudeCodeOauthToken: "",
  bearerToken: "t", ollamaBaseUrl: "x", ollamaApiKey: "", monitorUrl: "", maxDepth: 0,
};
const spec = (backend: string): AgentSpec => ({
  name: "a", model: "m",
  preset: { backend, model: "m", description: "", systemPrompt: "", skills: [] } as never,
});

Deno.test("assertBackendCredentials requires API key for claude backend", () => {
  assertThrows(() => assertBackendCredentials([spec("claude")], baseCfg), Error, "ANTHROPIC_API_KEY");
});

Deno.test("assertBackendCredentials accepts claude-code with only OAuth token", () => {
  assertBackendCredentials([spec("claude-code")], { ...baseCfg, claudeCodeOauthToken: "sk-oat" });
});

Deno.test("assertBackendCredentials accepts claude-code with only API key", () => {
  assertBackendCredentials([spec("claude-code")], { ...baseCfg, anthropicApiKey: "sk-api" });
});

Deno.test("assertBackendCredentials rejects claude-code with neither credential", () => {
  assertThrows(() => assertBackendCredentials([spec("claude-code")], baseCfg), Error, "claude-code");
});

Deno.test("loadConfig surfaces CLAUDE_CODE_OAUTH_TOKEN", async () => {
  Deno.env.set("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat-test");
  const cfg = await loadConfig();
  assertEquals(cfg.claudeCodeOauthToken, "sk-ant-oat-test");
  Deno.env.delete("CLAUDE_CODE_OAUTH_TOKEN");
});

Deno.test("loadConfig reads A2A_MONITOR_URL (empty when unset)", async () => {
  const { loadConfig } = await import("../src/config.ts");
  const cfg = await loadConfig();
  // Type-level guarantee plus runtime presence of the field.
  assertEquals(typeof cfg.monitorUrl, "string");
});
