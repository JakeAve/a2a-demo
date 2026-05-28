import Anthropic from "@anthropic-ai/sdk";
import type { AgentHandlerCtx } from "./base.ts";
import type { StreamEvent } from "../protocol/client.ts";
import type { ContextStore, StoredMessage } from "../store/context.ts";
import type { ThreadStore } from "../store/threads.ts";
import type { RegistryClient } from "../registry/client.ts";
import { sendMessage } from "../protocol/client.ts";

export type ClaudeDeps = {
  model: string;
  systemPrompt: string;
  apiKey: string;
  store: ContextStore;
  threads: ThreadStore;
  registry: RegistryClient;
  bearerToken: string;
  selfName: string;
};

function userText(ctx: AgentHandlerCtx): string {
  return ctx.message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function toAnthropic(
  history: StoredMessage[],
): Array<{ role: "user" | "assistant"; content: string }> {
  return history
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
}

const TOOLS = [
  {
    name: "list_agents",
    description:
      "List peer agents available for delegation. Returns name, description, and skills for each.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "list_my_threads",
    description:
      "List your currently active delegation threads. Each entry shows threadId, peer, title (the first prompt), turnCount, and lastUsedAt. Call this before deciding whether to start a new thread or continue an existing one.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "delegate_start",
    description:
      "Start a NEW sub-conversation with a peer agent. Returns { threadId, text }. The peer sees a clean slate. Use for fresh, unrelated tasks. Keep the returned threadId if you may continue this conversation later.",
    input_schema: {
      type: "object" as const,
      properties: {
        agent: {
          type: "string",
          description: "Target agent name as returned by list_agents",
        },
        prompt: { type: "string", description: "What to ask the peer agent" },
        title: {
          type: "string",
          description:
            "Optional short label for this thread (used by list_my_threads). Defaults to a truncated prompt.",
        },
      },
      required: ["agent", "prompt"],
    },
  },
  {
    name: "delegate_continue",
    description:
      "Continue an existing sub-conversation with a peer. The peer sees prior turns and can refine, iterate, or answer follow-ups. Use this when the user asks you to build on something a peer already produced.",
    input_schema: {
      type: "object" as const,
      properties: {
        threadId: {
          type: "string",
          description: "threadId from delegate_start or list_my_threads",
        },
        prompt: { type: "string", description: "Next message in the thread" },
      },
      required: ["threadId", "prompt"],
    },
  },
  {
    name: "reset_thread",
    description:
      "Delete a delegation thread. Use when a sub-conversation is finished or you want a clean restart with the peer.",
    input_schema: {
      type: "object" as const,
      properties: {
        threadId: { type: "string", description: "threadId to delete" },
      },
      required: ["threadId"],
    },
  },
];

const SYSTEM_SUFFIX = `

Delegation tools available to you:
- list_agents: discover which peer agents exist.
- list_my_threads: see your own active sub-conversations with peers.
- delegate_start(agent, prompt, title?): begin a fresh sub-conversation; returns { threadId, text }.
- delegate_continue(threadId, prompt): continue a prior sub-conversation; the peer sees its earlier turns.
- reset_thread(threadId): drop a finished sub-conversation.

Prefer delegate_continue when the user is iterating on something a peer already produced ("ask gemma again", "refine that", "now make it darker"). Use delegate_start for unrelated tasks. Always call list_my_threads if you're unsure whether an existing thread already covers the request.`;

function truncate(s: string, max = 80): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

export function makeClaudeHandlers(deps: ClaudeDeps) {
  const client = new Anthropic({ apiKey: deps.apiKey });

  async function delegate(
    threadId: string,
    peerUrl: string,
    prompt: string,
    depth: number,
  ): Promise<string> {
    const res = await sendMessage({
      url: peerUrl,
      token: deps.bearerToken,
      depth: depth + 1,
      message: {
        messageId: crypto.randomUUID(),
        role: "agent",
        parts: [{ type: "text", text: prompt }],
        contextId: threadId,
      },
    });
    return res.text;
  }

  async function runTool(
    name: string,
    args: Record<string, unknown>,
    depth: number,
    parentContextId: string,
  ): Promise<string> {
    try {
      if (name === "list_agents") {
        const cards = await deps.registry.list();
        const peers = cards.filter((c) => c.name !== deps.selfName);
        return JSON.stringify(
          peers.map((c) => ({
            name: c.name,
            description: c.description,
            skills: c.skills,
          })),
        );
      }

      if (name === "list_my_threads") {
        const threads = await deps.threads.list(parentContextId);
        return JSON.stringify(
          threads.map((t) => ({
            threadId: t.threadId,
            peer: t.peer,
            title: t.title,
            turnCount: t.turnCount,
            lastUsedAt: t.lastUsedAt,
          })),
        );
      }

      if (name === "delegate_start") {
        const target = String(args.agent);
        const prompt = String(args.prompt);
        const title = typeof args.title === "string" && args.title.trim()
          ? args.title
          : truncate(prompt);
        const card = await deps.registry.get(target);
        if (!card) return JSON.stringify({ error: `unknown agent ${target}` });
        const meta = await deps.threads.start(parentContextId, target, title);
        const text = await delegate(meta.threadId, card.url, prompt, depth);
        await deps.threads.touch(meta.threadId);
        return JSON.stringify({ threadId: meta.threadId, text });
      }

      if (name === "delegate_continue") {
        const threadId = String(args.threadId);
        const prompt = String(args.prompt);
        const meta = await deps.threads.get(threadId);
        if (!meta) return JSON.stringify({ error: `unknown thread ${threadId}` });
        if (meta.parentContextId !== parentContextId) {
          return JSON.stringify({
            error: `thread ${threadId} is not owned by this conversation`,
          });
        }
        const card = await deps.registry.get(meta.peer);
        if (!card) return JSON.stringify({ error: `peer ${meta.peer} is gone` });
        const text = await delegate(threadId, card.url, prompt, depth);
        await deps.threads.touch(threadId);
        return JSON.stringify({ threadId, text });
      }

      if (name === "reset_thread") {
        const threadId = String(args.threadId);
        const meta = await deps.threads.get(threadId);
        if (!meta || meta.parentContextId !== parentContextId) {
          return JSON.stringify({ error: `unknown thread ${threadId}` });
        }
        const ok = await deps.threads.reset(threadId);
        return JSON.stringify({ ok });
      }

      return JSON.stringify({ error: `unknown tool ${name}` });
    } catch (e) {
      return JSON.stringify({ error: (e as Error).message });
    }
  }

  async function handler(ctx: AgentHandlerCtx): Promise<{ text: string }> {
    const contextId = ctx.message.contextId ?? crypto.randomUUID();
    const prompt = userText(ctx);
    await deps.store.append(contextId, { role: "user", content: prompt });

    // Agentic loop with tool use; bounded to avoid runaway.
    let finalText = "";
    const messages = toAnthropic(await deps.store.get(contextId));

    for (let iter = 0; iter < 8; iter++) {
      const resp = await client.messages.create({
        model: deps.model,
        max_tokens: 1024,
        system: deps.systemPrompt + SYSTEM_SUFFIX,
        tools: TOOLS,
        messages,
      });

      const textBlocks = resp.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text);
      const toolBlocks = resp.content.filter((b) => b.type === "tool_use") as Array<{
        type: "tool_use";
        id: string;
        name: string;
        input: Record<string, unknown>;
      }>;

      if (textBlocks.length) finalText = textBlocks.join("\n");

      if (resp.stop_reason !== "tool_use" || toolBlocks.length === 0) break;

      messages.push({ role: "assistant", content: resp.content as never });
      const toolResults = await Promise.all(
        toolBlocks.map(async (tb) => ({
          type: "tool_result" as const,
          tool_use_id: tb.id,
          content: await runTool(tb.name, tb.input, ctx.depth, contextId),
        })),
      );
      messages.push({ role: "user", content: toolResults as never });
    }

    await deps.store.append(contextId, { role: "assistant", content: finalText });
    return { text: finalText };
  }

  async function* streamHandler(
    ctx: AgentHandlerCtx,
  ): AsyncGenerator<StreamEvent> {
    // V1: stream only the final answer. Tool turns happen behind the scenes.
    const result = await handler(ctx);
    // chunk by ~40 chars for visible streaming feel
    const chunkSize = 40;
    for (let i = 0; i < result.text.length; i += chunkSize) {
      yield { type: "delta", text: result.text.slice(i, i + chunkSize) };
    }
    yield { type: "done" };
  }

  return { handler, streamHandler };
}
