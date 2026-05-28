import { Hono } from "hono";
import { type AgentCard, isAgentCard } from "../protocol/types.ts";

export type RegistryHandle = {
  port: number;
  shutdown(): Promise<void>;
};

export function startRegistry(port: number): Promise<RegistryHandle> {
  const agents = new Map<string, AgentCard>();
  const app = new Hono();

  app.get("/agents", (c) => c.json([...agents.values()]));

  app.get("/agents/:name", (c) => {
    const card = agents.get(c.req.param("name"));
    return card ? c.json(card) : c.json({ error: "not found" }, 404);
  });

  app.post("/register", async (c) => {
    const body = await c.req.json();
    if (!isAgentCard(body)) return c.json({ error: "invalid agent card" }, 400);
    agents.set(body.name, body);
    return c.json({ ok: true });
  });

  app.delete("/register/:name", (c) => {
    agents.delete(c.req.param("name"));
    return c.json({ ok: true });
  });

  const server = Deno.serve({ port, onListen: () => {} }, app.fetch);
  const actualPort = (server.addr as Deno.NetAddr).port;

  return Promise.resolve({
    port: actualPort,
    shutdown: async () => {
      await server.shutdown();
    },
  });
}
