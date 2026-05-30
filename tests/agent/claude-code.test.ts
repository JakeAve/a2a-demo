import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  makeClaudeCodeHandlers,
  type QueryFn,
  resolveClaudeCodeEnv,
} from "../../src/agent/claude-code.ts";
import { ContextStore } from "../../src/store/context.ts";
import { ThreadStore } from "../../src/store/threads.ts";
import { SessionStore } from "../../src/store/sessions.ts";
import type { RegistryClient } from "../../src/registry/client.ts";
import type { AgentHandlerCtx } from "../../src/agent/base.ts";

function ctx(text: string, contextId: string): AgentHandlerCtx {
  return {
    depth: 0,
    sessionId: "",
    requestId: "",
    message: {
      messageId: "m",
      role: "user",
      parts: [{ type: "text", text }],
      contextId,
    },
  };
}

async function makeDeps() {
  const kv = await Deno.openKv(":memory:");
  return {
    kv,
    deps: {
      model: "claude-opus-4-8",
      systemPrompt: "be brief",
      oauthToken: "sk-oat",
      apiKey: "",
      store: new ContextStore(kv),
      threads: new ThreadStore(kv),
      sessions: new SessionStore(kv),
      registry: {} as RegistryClient,
      bearerToken: "t",
      selfName: "coordinator-max",
    },
  };
}

Deno.test("resolveClaudeCodeEnv prefers OAuth and drops the API key", () => {
  const env = resolveClaudeCodeEnv(
    { ANTHROPIC_API_KEY: "sk-api", FOO: "bar" },
    "sk-oat",
    "sk-api",
  );
  assertEquals(env.CLAUDE_CODE_OAUTH_TOKEN, "sk-oat");
  assertEquals("ANTHROPIC_API_KEY" in env, false);
  assertEquals(env.FOO, "bar");
});

Deno.test("resolveClaudeCodeEnv falls back to API key when no OAuth token", () => {
  const env = resolveClaudeCodeEnv(
    { CLAUDE_CODE_OAUTH_TOKEN: "stale" },
    "",
    "sk-api",
  );
  assertEquals(env.ANTHROPIC_API_KEY, "sk-api");
  assertEquals("CLAUDE_CODE_OAUTH_TOKEN" in env, false);
});

Deno.test("resolveClaudeCodeEnv throws when neither credential is set", () => {
  assertThrows(() => resolveClaudeCodeEnv({}, "", ""), Error, "requires");
});

Deno.test("handler returns result text, records session, and resumes next turn", async () => {
  const { kv, deps } = await makeDeps();
  const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const fakeQuery: QueryFn = (input) => {
    calls.push(input);
    return (async function* () {
      yield {
        type: "assistant",
        session_id: "S1",
        message: { content: [{ type: "text", text: "partial" }] },
      };
      yield {
        type: "result",
        subtype: "success",
        session_id: "S1",
        result: "FINAL",
      };
    })();
  };
  const { handler } = makeClaudeCodeHandlers({ ...deps, runQuery: fakeQuery });

  const r1 = await handler(ctx("hello", "c1"));
  assertEquals(r1.text, "FINAL");
  assertEquals(calls[0].options.resume, undefined);
  assertEquals(await deps.sessions.get("c1"), "S1");
  assertEquals((await deps.store.get("c1")).map((m) => m.role), [
    "user",
    "assistant",
  ]);

  await handler(ctx("again", "c1"));
  assertEquals(calls[1].options.resume, "S1");
  kv.close();
});

Deno.test("handler throws a clear error on a failed result", async () => {
  const { kv, deps } = await makeDeps();
  const fakeQuery: QueryFn = () =>
    (async function* () {
      yield {
        type: "result",
        subtype: "error_during_execution",
        session_id: "S2",
        errors: ["out of credit"],
      };
    })();
  const { handler } = makeClaudeCodeHandlers({ ...deps, runQuery: fakeQuery });
  await assertRejects(() => handler(ctx("x", "c2")), Error, "out of credit");
  kv.close();
});

Deno.test("streamHandler yields deltas then done", async () => {
  const { kv, deps } = await makeDeps();
  const fakeQuery: QueryFn = () =>
    (async function* () {
      yield {
        type: "assistant",
        session_id: "S3",
        message: { content: [{ type: "text", text: "chunk" }] },
      };
      yield {
        type: "result",
        subtype: "success",
        session_id: "S3",
        result: "chunk",
      };
    })();
  const { streamHandler } = makeClaudeCodeHandlers({
    ...deps,
    runQuery: fakeQuery,
  });
  const events = [];
  for await (const ev of streamHandler(ctx("y", "c3"))) events.push(ev);
  assertEquals(events[0], { type: "delta", text: "chunk" });
  assertEquals(events.at(-1), { type: "done" });
  kv.close();
});
