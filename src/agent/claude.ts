import Anthropic from "@anthropic-ai/sdk";
import type { AgentHandlerCtx } from "./base.ts";
import type { StreamEvent } from "../protocol/client.ts";
import type { ContextStore, StoredMessage } from "../store/context.ts";
import type { RegistryClient } from "../registry/client.ts";
import { sendMessage } from "../protocol/client.ts";

export type ClaudeDeps = {
  model: string;
  systemPrompt: string;
  apiKey: string;
  store: ContextStore;
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
    name: "delegate_task",
    description:
      "Delegate a task to a peer agent. Returns the peer's text response. Use when another agent is better suited (cheaper, faster, more specialised). Cannot be called recursively past depth 2.",
    input_schema: {
      type: "object" as const,
      properties: {
        agent: {
          type: "string",
          description: "Target agent name as returned by list_agents",
        },
        prompt: { type: "string", description: "What to ask the peer agent" },
      },
      required: ["agent", "prompt"],
    },
  },
];

export function makeClaudeHandlers(deps: ClaudeDeps) {
  const client = new Anthropic({ apiKey: deps.apiKey });

  async function runTool(
    name: string,
    args: Record<string, unknown>,
    depth: number,
    contextId: string,
  ): Promise<string> {
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
    if (name === "delegate_task") {
      const target = String(args.agent);
      const prompt = String(args.prompt);
      const card = await deps.registry.get(target);
      if (!card) return `error: unknown agent ${target}`;
      // Each delegation runs in its own sub-context so the peer doesn't see
      // this agent's conversation history. The parent's contextId is recorded
      // so future versions could attach metadata or link threads.
      void contextId;
      try {
        const res = await sendMessage({
          url: card.url,
          token: deps.bearerToken,
          depth: depth + 1,
          message: {
            messageId: crypto.randomUUID(),
            role: "agent",
            parts: [{ type: "text", text: prompt }],
            contextId: crypto.randomUUID(),
          },
        });
        return res.text;
      } catch (e) {
        return `error: ${(e as Error).message}`;
      }
    }
    return `error: unknown tool ${name}`;
  }

  async function handler(ctx: AgentHandlerCtx): Promise<{ text: string }> {
    const contextId = ctx.message.contextId ?? crypto.randomUUID();
    const prompt = userText(ctx);
    await deps.store.append(contextId, { role: "user", content: prompt });

    // Agentic loop with tool use; bounded to avoid runaway.
    let finalText = "";
    const messages = toAnthropic(await deps.store.get(contextId));

    for (let iter = 0; iter < 5; iter++) {
      const resp = await client.messages.create({
        model: deps.model,
        max_tokens: 1024,
        system: deps.systemPrompt,
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
