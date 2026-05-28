import { assertEquals } from "@std/assert";
import { loadConfig } from "../src/config.ts";

Deno.test("loadConfig surfaces CLAUDE_CODE_OAUTH_TOKEN", async () => {
  Deno.env.set("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat-test");
  const cfg = await loadConfig();
  assertEquals(cfg.claudeCodeOauthToken, "sk-ant-oat-test");
  Deno.env.delete("CLAUDE_CODE_OAUTH_TOKEN");
});
