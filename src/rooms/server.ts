import { Hono } from "hono";
import { RoomStore } from "./store.ts";
import type { InboxDelivery } from "./types.ts";
import type { EmitEvent } from "../observability/events.ts";

export type PushFn = (inboxUrl: string, delivery: InboxDelivery) => Promise<boolean>;
export type EmitFn = (event: EmitEvent) => Promise<void>;

export type RoomBrokerConfig = {
  kv: Deno.Kv;
  port: number;
  token: string;                                  // "" disables auth
  resolveInbox: (name: string) => Promise<string | null>;
  push?: PushFn;                                  // default: fetch POST {url}/inbox
  emit?: EmitFn;                                  // default: no-op
  agentDeadlineMs: number;
  humanDeadlineMs: number;
  defaultMaxTurns: number;
  sweepIntervalMs?: number;                       // default 30s; 0 disables timer
  now?: () => number;
};

export type RoomBrokerHandle = { port: number; url: string; shutdown(): Promise<void> };

const defaultPush: PushFn = async (url, delivery) => {
  try {
    const res = await fetch(`${url}/inbox`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(delivery),
    });
    const ok = res.status === 202 || res.ok;
    await res.body?.cancel();
    return ok;
  } catch { return false; }
};

export function startRoomBroker(cfg: RoomBrokerConfig): Promise<RoomBrokerHandle> {
  const now = cfg.now ?? (() => Date.now());
  const store = new RoomStore(cfg.kv, now);
  const push = cfg.push ?? defaultPush;
  const emit: EmitFn = cfg.emit ?? (() => Promise.resolve());
  const app = new Hono();

  const auth = (c: { req: { header: (k: string) => string | undefined } }) =>
    !cfg.token || c.req.header("authorization") === `Bearer ${cfg.token}`;

  // Emit a room.* event with the room's session + requestId == roomId.
  const ev = (
    sessionId: string, roomId: string, agent: string,
    type: EmitEvent["type"], data: Record<string, unknown>,
  ) => void emit({
    sessionId, requestId: roomId, agent, depth: 0, ts: now(), roomId, type, data,
  });

  // Deliver `from`'s freshly-appended post to each addressed active member.
  async function fanOut(roomId: string, from: string, to: string[]): Promise<void> {
    const room = await store.getRoom(roomId);
    if (!room) return;
    const transcript = await store.getTranscript(roomId);
    const activeNames = new Set(room.members.filter((m) => m.active).map((m) => m.name));
    const expand = to.includes("*")
      ? [...activeNames].filter((n) => n !== from)
      : to.filter((n) => n !== from && activeNames.has(n));
    for (const name of expand) {
      const member = room.members.find((m) => m.name === name)!;
      const ttl = member.kind === "human" ? cfg.humanDeadlineMs : cfg.agentDeadlineMs;
      const delivery = await store.createDelivery(roomId, name, from, ttl);
      const payload: InboxDelivery = {
        roomId, turnId: delivery.turnId, addressedBy: from,
        title: room.title, members: [...activeNames], transcript,
      };
      const ok = await push(member.inboxUrl, payload);
      if (!ok) {
        await store.resolveDelivery(roomId, delivery.turnId);
        ev(room.sessionId, roomId, "room-broker", "room.delivery_failed",
          { turnId: delivery.turnId, member: name });
      }
    }
    if (await store.isIdle(roomId)) {
      ev(room.sessionId, roomId, "room-broker", "room.idle", {});
    }
  }

  app.post("/rooms", async (c) => {
    if (!auth(c)) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json();
    const unresolved: string[] = [];
    const members: Array<{ name: string; inboxUrl: string; kind: "agent" | "human" }> = [];
    for (const name of (body.members ?? []) as string[]) {
      const url = await cfg.resolveInbox(name);
      if (!url) { unresolved.push(name); continue; }
      members.push({ name, inboxUrl: url, kind: "agent" });
    }
    for (const hm of (body.humanMembers ?? []) as Array<{ name: string; inboxUrl: string }>) {
      members.push({ name: hm.name, inboxUrl: hm.inboxUrl, kind: "human" });
    }
    const room = await store.createRoom({
      title: String(body.title ?? "room"), createdBy: String(body.createdBy ?? "?"),
      sessionId: String(body.sessionId ?? ""), maxTurns: Number(body.maxTurns ?? cfg.defaultMaxTurns),
      members,
    });
    ev(room.sessionId, room.roomId, room.createdBy, "room.created",
      { title: room.title, members: members.map((m) => m.name), maxTurns: room.maxTurns });
    return c.json({ roomId: room.roomId, unresolved });
  });

  app.post("/rooms/:id/post", async (c) => {
    if (!auth(c)) return c.json({ error: "unauthorized" }, 401);
    const roomId = c.req.param("id");
    const body = await c.req.json();
    const room = await store.getRoom(roomId);
    if (!room || room.status !== "open") return c.json({ error: "unknown or closed room" }, 404);
    if (!room.members.some((m) => m.name === body.from && m.active)) return c.json({ error: "not a member" }, 403);

    if (await store.atTurnCap(roomId)) {
      ev(room.sessionId, roomId, "room-broker", "room.capped", { turnCount: room.turnCount });
      return c.json({ error: "room at turn cap" }, 429);
    }

    const to: string[] = Array.isArray(body.to) ? body.to : [];
    const msg = await store.appendMessage(roomId, { from: body.from, to, text: String(body.text ?? "") });
    if (typeof body.turnId === "string") await store.resolveDelivery(roomId, body.turnId);
    ev(room.sessionId, roomId, body.from, "room.post", { from: body.from, to, seq: msg.seq, text: msg.text });
    await fanOut(roomId, body.from, to);
    return c.json({ seq: msg.seq });
  });

  app.post("/rooms/:id/ack", async (c) => {
    if (!auth(c)) return c.json({ error: "unauthorized" }, 401);
    const roomId = c.req.param("id");
    const body = await c.req.json();
    const room = await store.getRoom(roomId);
    if (!room) return c.json({ error: "unknown room" }, 404);
    await store.resolveDelivery(roomId, String(body.turnId));
    ev(room.sessionId, roomId, String(body.from ?? "?"), "room.ack", { turnId: body.turnId });
    if (await store.isIdle(roomId)) ev(room.sessionId, roomId, "room-broker", "room.idle", {});
    return c.json({ ok: true });
  });

  app.post("/rooms/:id/invite", async (c) => {
    if (!auth(c)) return c.json({ error: "unauthorized" }, 401);
    const roomId = c.req.param("id");
    const { agent } = await c.req.json();
    const room = await store.getRoom(roomId);
    if (!room) return c.json({ error: "unknown room" }, 404);
    const url = await cfg.resolveInbox(agent);
    if (!url) return c.json({ error: `cannot resolve ${agent}` }, 400);
    await store.addMember(roomId, { name: agent, inboxUrl: url, kind: "agent" });
    ev(room.sessionId, roomId, agent, "room.invited", { agent });
    return c.json({ ok: true });
  });

  app.post("/rooms/:id/leave", async (c) => {
    if (!auth(c)) return c.json({ error: "unauthorized" }, 401);
    const roomId = c.req.param("id");
    const { agent } = await c.req.json();
    const room = await store.getRoom(roomId);
    if (!room) return c.json({ error: "unknown room" }, 404);
    const shouldClose = await store.deactivateMember(roomId, agent);
    ev(room.sessionId, roomId, agent, "room.left", { agent });
    if (shouldClose) {
      await store.closeRoom(roomId);
      ev(room.sessionId, roomId, "room-broker", "room.closed", {});
    }
    return c.json({ ok: true });
  });

  app.get("/rooms/:id", async (c) => {
    if (!auth(c)) return c.json({ error: "unauthorized" }, 401);
    const roomId = c.req.param("id");
    const room = await store.getRoom(roomId);
    if (!room) return c.json({ error: "unknown room" }, 404);
    return c.json({ room, transcript: await store.getTranscript(roomId) });
  });

  app.get("/rooms", async (c) => {
    if (!auth(c)) return c.json({ error: "unauthorized" }, 401);
    const member = c.req.query("member");
    if (!member) return c.json([]);
    return c.json(await store.listRoomsByMember(member));
  });

  const server = Deno.serve({ port: cfg.port, onListen: () => {} }, app.fetch);
  const port = (server.addr as Deno.NetAddr).port;

  // Periodic sweep: resolve overdue deliveries so a dead member can't wedge a room.
  const intervalMs = cfg.sweepIntervalMs ?? 30_000;
  let timer: ReturnType<typeof setInterval> | undefined;
  if (intervalMs > 0) {
    timer = setInterval(async () => {
      const swept = await store.sweepExpired();
      const roomIds = new Set<string>();
      for (const d of swept) {
        roomIds.add(d.roomId);
        const room = await store.getRoom(d.roomId);
        ev(room?.sessionId ?? "", d.roomId, "room-broker", "room.turn_timeout",
          { turnId: d.turnId, member: d.member });
      }
      for (const roomId of roomIds) {
        const room = await store.getRoom(roomId);
        if (room && await store.isIdle(roomId)) {
          ev(room.sessionId, roomId, "room-broker", "room.idle", {});
        }
      }
    }, intervalMs);
  }

  return Promise.resolve({
    port, url: `http://localhost:${port}`,
    shutdown: async () => { if (timer) clearInterval(timer); await server.shutdown(); },
  });
}
