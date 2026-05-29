import { assertEquals } from "@std/assert";
import { buildHandlers } from "../../src/agent/handlers.ts";
import { ContextStore } from "../../src/store/context.ts";
import { ThreadStore } from "../../src/store/threads.ts";
import { SessionStore } from "../../src/store/sessions.ts";
import type { RegistryClient } from "../../src/registry/client.ts";
import type { AppConfig } from "../../src/config.ts";
import type { RolePreset } from "../../src/roles.ts";

Deno.test("buildHandlers returns handler + streamHandler for a claude-code preset", async () => {
  const kv = await Deno.openKv(":memory:");
  const preset: RolePreset = {
    backend: "claude-code", model: "claude-opus-4-8", description: "", systemPrompt: "s",
    skills: [], toolCapable: true,
  };
  const cfg: AppConfig = {
    registryPort: 1, anthropicApiKey: "", claudeCodeOauthToken: "sk-oat",
    bearerToken: "t", ollamaBaseUrl: "x", monitorUrl: "",
  };
  const h = buildHandlers({
    model: "claude-opus-4-8", preset, cfg,
    store: new ContextStore(kv), threads: new ThreadStore(kv), sessions: new SessionStore(kv),
    registry: {} as RegistryClient, selfName: "coordinator-max",
  });
  assertEquals(typeof h.handler, "function");
  assertEquals(typeof h.streamHandler, "function");
  kv.close();
});
