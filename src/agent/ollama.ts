import type { AgentHandlerCtx } from "./base.ts";
import type { StreamEvent } from "../protocol/client.ts";
import type { ContextStore, StoredMessage } from "../store/context.ts";

export type OllamaDeps = {
  model: string;
  systemPrompt: string;
  baseUrl: string;
  store: ContextStore;
};

function userText(ctx: AgentHandlerCtx): string {
  return ctx.message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function buildMessages(system: string, history: StoredMessage[]): StoredMessage[] {
  return [{ role: "system", content: system }, ...history];
}

export function makeOllamaHandlers(deps: OllamaDeps) {
  async function handler(ctx: AgentHandlerCtx): Promise<{ text: string }> {
    const contextId = ctx.message.contextId ?? crypto.randomUUID();
    const prompt = userText(ctx);
    await deps.store.append(contextId, { role: "user", content: prompt });
    const history = await deps.store.get(contextId);
    const res = await fetch(`${deps.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deps.model,
        messages: buildMessages(deps.systemPrompt, history),
        stream: false,
      }),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const text: string = json?.message?.content ?? "";
    await deps.store.append(contextId, { role: "assistant", content: text });
    return { text };
  }

  async function* streamHandler(ctx: AgentHandlerCtx): AsyncGenerator<StreamEvent> {
    const contextId = ctx.message.contextId ?? crypto.randomUUID();
    const prompt = userText(ctx);
    await deps.store.append(contextId, { role: "user", content: prompt });
    const history = await deps.store.get(contextId);
    const res = await fetch(`${deps.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deps.model,
        messages: buildMessages(deps.systemPrompt, history),
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
