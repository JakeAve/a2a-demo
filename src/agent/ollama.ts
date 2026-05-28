import type { AgentHandlerCtx } from "./base.ts";
import type { StreamEvent } from "../protocol/client.ts";
import type { ContextStore, StoredMessage } from "../store/context.ts";
import {
  buildSystemSuffix,
  runTool,
  toOllamaTools,
  type ToolDeps,
} from "./tools.ts";

export type OllamaDeps = {
  model: string;
  systemPrompt: string;
  baseUrl: string;
  store: ContextStore;
  // When provided, this Ollama agent will be wired with the same A2A tools
  // as the Claude backend. Requires a tool-capable model on the Ollama side.
  tools?: ToolDeps;
};

type OllamaToolCall = {
  id?: string;
  function: { name: string; arguments: Record<string, unknown> };
};

type OllamaChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_call_id?: string;
};

function userText(ctx: AgentHandlerCtx): string {
  return ctx.message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function buildSystem(deps: OllamaDeps): string {
  if (!deps.tools) return deps.systemPrompt;
  return deps.systemPrompt + buildSystemSuffix(deps.tools);
}

function historyToOllama(
  history: StoredMessage[],
): OllamaChatMessage[] {
  return history.map((m) => ({
    role: m.role === "system" ? "system" : (m.role as "user" | "assistant"),
    content: m.content,
  }));
}

export function makeOllamaHandlers(deps: OllamaDeps) {
  const tools = deps.tools ? toOllamaTools(deps.tools) : undefined;

  async function handler(ctx: AgentHandlerCtx): Promise<{ text: string }> {
    const contextId = ctx.message.contextId ?? crypto.randomUUID();
    const prompt = userText(ctx);
    await deps.store.append(contextId, { role: "user", content: prompt });

    let finalText = "";
    const messages: OllamaChatMessage[] = [
      { role: "system", content: buildSystem(deps) },
      ...historyToOllama(await deps.store.get(contextId)),
    ];

    for (let iter = 0; iter < 8; iter++) {
      const body: Record<string, unknown> = {
        model: deps.model,
        messages,
        stream: false,
      };
      if (tools) body.tools = tools;

      const res = await fetch(`${deps.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
      const json = await res.json();
      const msg = json?.message ?? {};
      const content: string = msg.content ?? "";
      const toolCalls: OllamaToolCall[] = msg.tool_calls ?? [];

      if (content) finalText = content;

      if (!deps.tools || toolCalls.length === 0) break;

      // Append the assistant's tool-call message verbatim so the model sees
      // its own request when reasoning over results.
      messages.push({
        role: "assistant",
        content,
        tool_calls: toolCalls,
      });

      for (const tc of toolCalls) {
        const result = await runTool(
          deps.tools,
          tc.function.name,
          tc.function.arguments ?? {},
          ctx.depth,
          contextId,
        );
        messages.push({
          role: "tool",
          content: result,
          tool_call_id: tc.id,
        });
      }
    }

    await deps.store.append(contextId, { role: "assistant", content: finalText });
    return { text: finalText };
  }

  async function* streamHandler(
    ctx: AgentHandlerCtx,
  ): AsyncGenerator<StreamEvent> {
    // When tools are wired, the tool loop forces non-streaming under the
    // hood. We chunk the final text for a streaming-feel SSE response.
    if (deps.tools) {
      const result = await handler(ctx);
      const chunkSize = 40;
      for (let i = 0; i < result.text.length; i += chunkSize) {
        yield { type: "delta", text: result.text.slice(i, i + chunkSize) };
      }
      yield { type: "done" };
      return;
    }

    // Plain streaming path (no tools).
    const contextId = ctx.message.contextId ?? crypto.randomUUID();
    const prompt = userText(ctx);
    await deps.store.append(contextId, { role: "user", content: prompt });
    const history = await deps.store.get(contextId);
    const res = await fetch(`${deps.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deps.model,
        messages: [
          { role: "system", content: deps.systemPrompt },
          ...history,
        ],
        stream: true,
      }),
    });
    if (!res.ok || !res.body) {
      yield { type: "error", message: `ollama ${res.status}` };
      return;
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    let full = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          const delta: string = obj?.message?.content ?? "";
          if (delta) {
            full += delta;
            yield { type: "delta", text: delta };
          }
        } catch { /* skip */ }
      }
    }
    await deps.store.append(contextId, { role: "assistant", content: full });
    yield { type: "done" };
  }

  return { handler, streamHandler };
}
