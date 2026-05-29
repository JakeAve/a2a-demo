// Regression for the agentic loop dropping a truncated turn. The researcher
// chains web_search -> delegate_start in one turn, but a small max_tokens
// budget truncated mid-tool_use (stop_reason "max_tokens") and the loop
// silently returned the partial text, never executing the delegation. The loop
// now retries a truncated turn with a doubled budget (up to a cap) on the
// still-valid `messages` array. See session 1b114ce1 / src/agent/claude.ts.
import { assertEquals } from "@std/assert";
import type Anthropic from "@anthropic-ai/sdk";
import { makeClaudeHandlers } from "../../src/agent/claude.ts";
import type { ContextStore, StoredMessage } from "../../src/store/context.ts";
import type { ThreadStore } from "../../src/store/threads.ts";
import type { RegistryClient } from "../../src/registry/client.ts";
import type { AgentHandlerCtx } from "../../src/agent/base.ts";

function fakeStore(): ContextStore {
  const history: StoredMessage[] = [];
  return {
    get: () => Promise.resolve(history),
    append: (_id: string, m: StoredMessage) => { history.push(m); return Promise.resolve(); },
  } as unknown as ContextStore;
}

function ctx(): AgentHandlerCtx {
  return {
    depth: 0, sessionId: "s", requestId: "r",
    message: { messageId: "m", role: "user", parts: [{ type: "text", text: "hi" }] },
  } as AgentHandlerCtx;
}

// A stub Anthropic client that replays queued responses and records the
// max_tokens budget each call was made with.
function fakeClient(responses: unknown[], budgets: number[]): Anthropic {
  let i = 0;
  return {
    messages: {
      create: (args: { max_tokens: number }) => {
        budgets.push(args.max_tokens);
        return Promise.resolve(responses[Math.min(i++, responses.length - 1)]);
      },
    },
  } as unknown as Anthropic;
}

function handlerWith(client: Anthropic) {
  return makeClaudeHandlers({
    model: "m", systemPrompt: "sys", apiKey: "",
    store: fakeStore(),
    threads: {} as unknown as ThreadStore,
    registry: {} as unknown as RegistryClient,
    bearerToken: "t", selfName: "researcher", client,
  }).handler;
}

Deno.test("claude loop: a truncated turn is retried with a bigger budget, not dropped", async () => {
  const budgets: number[] = [];
  const client = fakeClient([
    { stop_reason: "max_tokens", content: [{ type: "text", text: "partial (truncated)" }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "the complete answer" }] },
  ], budgets);

  const res = await handlerWith(client)(ctx());

  // Old behavior returned "partial (truncated)" and never retried.
  assertEquals(res.text, "the complete answer");
  assertEquals(budgets[0], 4096);     // generous base budget
  assertEquals(budgets[1], 8192);     // doubled on truncation
});

Deno.test("claude loop: budget escalation is capped and terminates", async () => {
  const budgets: number[] = [];
  // Always truncated — must escalate 4096 -> 8192 -> 16384 then give up.
  const client = fakeClient([
    { stop_reason: "max_tokens", content: [{ type: "text", text: "still truncated" }] },
  ], budgets);

  const res = await handlerWith(client)(ctx());

  assertEquals(budgets, [4096, 8192, 16384]); // stops at the cap, no infinite loop
  assertEquals(res.text, "still truncated");  // best-effort text returned
});
