// Builds the processor for a single inbox delivery. Reuses the agent's normal
// (non-streaming) handler by synthesizing a "transcript + instruction" user
// message; the post tool (Task 8) turns the model's reply into a broker post.
// If the model replies in prose without calling post(), we wrap that prose as a
// reply to whoever addressed it; if it says nothing, we ack so the room can idle.
import type { AgentHandlerCtx } from "./base.ts";
import type { ContextStore } from "../store/context.ts";
import type { RoomBrokerClient } from "../rooms/client.ts";
import type { InboxDelivery, RoomTurnState } from "../rooms/types.ts";

export type RoomTurnDeps = {
  selfName: string;
  handler: (ctx: AgentHandlerCtx) => Promise<{ text: string }>;
  rooms: RoomBrokerClient;
  roomTurn: RoomTurnState;       // the SAME object wired into ToolDeps
  store: ContextStore;
};

export function renderRoomTurn(d: InboxDelivery, selfName: string): string {
  const lines = d.transcript.map((m) =>
    `[${m.from}${m.to.length ? " → " + m.to.join(", ") : ""}]: ${m.text}`,
  ).join("\n");
  return [
    `You are "${selfName}" in the room "${d.title}". Members: ${d.members.join(", ")}.`,
    ``,
    `Transcript so far:`,
    lines || "(empty)",
    ``,
    `${d.addressedBy} just addressed you (roomId="${d.roomId}"). Reply naturally to continue the conversation. ` +
    `To address someone specific or everyone, or to end the exchange, call post(roomId, text, to). ` +
    `If you have nothing to add, say nothing.`,
  ].join("\n");
}

export function makeRoomTurnProcessor(deps: RoomTurnDeps) {
  return async function processDelivery(d: InboxDelivery): Promise<void> {
    deps.roomTurn.active = { roomId: d.roomId, turnId: d.turnId, addressedBy: d.addressedBy, posted: false };
    const contextId = crypto.randomUUID(); // ephemeral; the transcript IS the context
    try {
      const ctx: AgentHandlerCtx = {
        depth: 0,
        sessionId: d.sessionId ?? "",
        requestId: d.roomId,
        message: {
          messageId: crypto.randomUUID(), role: "user",
          parts: [{ type: "text", text: renderRoomTurn(d, deps.selfName) }],
          contextId,
        },
      };
      const res = await deps.handler(ctx);
      if (!deps.roomTurn.active.posted) {
        const text = (res.text ?? "").trim();
        if (text) await deps.rooms.post(d.roomId, { from: deps.selfName, text, to: [d.addressedBy], turnId: d.turnId });
        else await deps.rooms.ack(d.roomId, { from: deps.selfName, turnId: d.turnId });
      }
    } catch {
      // Never leave a delivery pending — resolve it so the room can idle/recover.
      try { await deps.rooms.ack(d.roomId, { from: deps.selfName, turnId: d.turnId }); } catch { /* ignore */ }
    } finally {
      deps.roomTurn.active = null;
      await deps.store.clear(contextId); // drop the throwaway context
    }
  };
}
