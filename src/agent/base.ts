import { Hono } from "hono";
import { type AgentCard, isMessage, type Message } from "../protocol/types.ts";
import type { StreamEvent } from "../protocol/client.ts";
import type { Emitter } from "../observability/emit.ts";
import { now } from "../observability/emit.ts";

export type AgentHandlerCtx = {
  depth: number;
  message: Message;
  sessionId: string;
  requestId: string;
};

export type AgentConfig = {
  card: AgentCard;
  bearerToken: string;
  emit?: Emitter; // optional; defaults to no-op
  handler: (ctx: AgentHandlerCtx) => Promise<{ text: string }>;
  streamHandler: (ctx: AgentHandlerCtx) => AsyncGenerator<StreamEvent>;
};

export type AgentHandle = {
  port: number;
  card: AgentCard;
  shutdown(): Promise<void>;
};

type Variables = { depth: number; sessionId: string; requestId: string };

export async function startAgent(cfg: AgentConfig): Promise<AgentHandle> {
  const app = new Hono<{ Variables: Variables }>();
  const emit: Emitter = cfg.emit ?? (() => Promise.resolve());
  const agent = cfg.card.name;

  let servedCard = cfg.card;
  app.get("/.well-known/agent.json", (c) => c.json(servedCard));

  app.use("/message/*", async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    if (auth !== `Bearer ${cfg.bearerToken}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const depth = Number(c.req.header("x-depth") ?? "0");
    if (Number.isNaN(depth) || depth >= 2) {
      return c.json({ error: "max delegation depth reached" }, 429);
    }
    c.set("depth", depth);
    c.set("sessionId", c.req.header("x-session") ?? "");
    c.set("requestId", c.req.header("x-request") ?? "");
    await next();
  });

  app.post("/message/send", async (c) => {
    const body = await c.req.json();
    if (!isMessage(body?.message)) return c.json({ error: "bad message" }, 400);
    const depth = c.get("depth");
    const sessionId = c.get("sessionId");
    const requestId = c.get("requestId");
    const base = { sessionId, requestId, agent, depth };
    const startedTs = now();
    void emit({ ...base, ts: startedTs, type: "turn.started", data: {} });
    try {
      const result = await cfg.handler({ depth, message: body.message, sessionId, requestId });
      void emit({ ...base, ts: now(), type: "message.completed", data: { text: result.text } });
      void emit({ ...base, ts: now(), type: "turn.completed", data: { durationMs: now() - startedTs, status: "ok" } });
      return c.json({ text: result.text });
    } catch (e) {
      void emit({ ...base, ts: now(), type: "error", data: { message: (e as Error).message, where: "send" } });
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  app.post("/message/stream", async (c) => {
    const body = await c.req.json();
    if (!isMessage(body?.message)) return c.json({ error: "bad message" }, 400);
    const depth = c.get("depth");
    const sessionId = c.get("sessionId");
    const requestId = c.get("requestId");
    const base = { sessionId, requestId, agent, depth };
    const startedTs = now();
    void emit({ ...base, ts: startedTs, type: "turn.started", data: {} });

    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        const write = (ev: StreamEvent) =>
          controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
        let acc = "";
        try {
          for await (const ev of cfg.streamHandler({ depth, message: body.message, sessionId, requestId })) {
            if (ev.type === "delta") acc += ev.text;
            write(ev);
          }
          void emit({ ...base, ts: now(), type: "message.completed", data: { text: acc } });
          void emit({ ...base, ts: now(), type: "turn.completed", data: { durationMs: now() - startedTs, status: "ok" } });
        } catch (e) {
          write({ type: "error", message: (e as Error).message });
          void emit({ ...base, ts: now(), type: "error", data: { message: (e as Error).message, where: "stream" } });
        }
        controller.enqueue(enc.encode(`data: [DONE]\n\n`));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  });

  const server = Deno.serve({ port: 0, onListen: () => {} }, app.fetch);
  const port = (server.addr as Deno.NetAddr).port;
  servedCard = { ...cfg.card, url: `http://localhost:${port}` };

  return {
    port,
    card: servedCard,
    shutdown: async () => {
      await server.shutdown();
    },
  };
}
