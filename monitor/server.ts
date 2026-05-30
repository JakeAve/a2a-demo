// monitor/server.ts
import { Hono } from "hono";
import { MonitorStore } from "./store.ts";
import { EventBus } from "./bus.ts";
import { parseEvent } from "../src/observability/events.ts";

export type MonitorConfig = {
  kv: Deno.Kv;
  port: number;
  token: string; // "" disables the bearer check on /ingest
  webDir?: string; // static UI directory; omitted in tests
};

export type MonitorHandle = {
  port: number;
  url: string;
  shutdown(): Promise<void>;
};

export function startMonitor(cfg: MonitorConfig): Promise<MonitorHandle> {
  const store = new MonitorStore(cfg.kv);
  const bus = new EventBus();
  const app = new Hono();

  // ── POST /ingest ──────────────────────────────────────────────────────────
  app.post("/ingest", async (c) => {
    if (cfg.token) {
      const auth = c.req.header("authorization") ?? "";
      if (auth !== `Bearer ${cfg.token}`) {
        return c.json({ error: "unauthorized" }, 401);
      }
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "bad json" }, 400);
    }
    const items = Array.isArray(body) ? body : [body];
    try {
      for (const item of items) {
        // Validate with seq=0 placeholder; store will assign the real seq.
        parseEvent({ ...(item as Record<string, unknown>), seq: 0 });
        const stored = await store.ingest(item as never);
        bus.publish(stored);
      }
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    return c.json({ ok: true });
  });

  // ── GET /api/sessions ─────────────────────────────────────────────────────
  app.get("/api/sessions", async (c) => c.json(await store.listSessions()));

  // ── GET /api/sessions/:id ─────────────────────────────────────────────────
  app.get("/api/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const summary = (await store.listSessions()).find((s) =>
      s.sessionId === id
    ) ?? null;
    const events = await store.getSessionEvents(id);
    return c.json({ summary, events });
  });

  // ── GET /stream ───────────────────────────────────────────────────────────
  // SSE endpoint. Uses ReadableStream cancel() as the disconnect signal,
  // which is reliable across Deno+Hono versions (c.req.raw.signal fires on
  // client-initiated abort too, but cancel() is the safer universal hook).
  app.get("/stream", (c) => {
    const session = c.req.query("session") ?? "*";
    let unsub: (() => void) | null = null;

    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const send = (data: unknown) => {
          try {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {
            // controller already closed; ignore
          }
        };

        // Immediately push the hello frame so the client knows the connection
        // is live before any events arrive.
        send({ type: "hello", session });

        unsub = bus.subscribe(session, (ev) => send(ev));

        // Also hook the request abort signal if available (belt-and-suspenders).
        c.req.raw.signal?.addEventListener("abort", () => {
          unsub?.();
          unsub = null;
          try {
            controller.close();
          } catch { /* already closed */ }
        });
      },
      cancel() {
        // Called when the client closes the connection (reader.cancel() or
        // network drop). Clean up the bus subscription.
        unsub?.();
        unsub = null;
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      },
    });
  });

  // ── Static files ──────────────────────────────────────────────────────────
  if (cfg.webDir) {
    app.get("/*", async (c) => {
      const path = new URL(c.req.url).pathname;
      const file = path === "/" ? "/index.html" : path;
      try {
        const body = await Deno.readFile(`${cfg.webDir}${file}`);
        const type = file.endsWith(".html")
          ? "text/html"
          : file.endsWith(".js")
          ? "text/javascript"
          : file.endsWith(".css")
          ? "text/css"
          : "application/octet-stream";
        return new Response(body, { headers: { "content-type": type } });
      } catch {
        return c.notFound();
      }
    });
  }

  // ── Deno.serve ────────────────────────────────────────────────────────────
  const server = Deno.serve({ port: cfg.port, onListen: () => {} }, app.fetch);
  const port = (server.addr as Deno.NetAddr).port;

  return Promise.resolve({
    port,
    url: `http://localhost:${port}`,
    shutdown: async () => {
      await server.shutdown();
    },
  });
}
