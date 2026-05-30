// Pure function: ordered events -> { lanes, arrows }. No DOM, so it is unit
// testable under Deno. Lanes are ordered by first appearance, so the driver
// (REPL or mcp — whichever emits the first event) leads. We don't seed a REPL
// lane: MCP-driven sessions have no REPL events and shouldn't show an empty one.
import { expandRoomTo } from "./room-helpers.js";

export function computeLayout(events) {
  const order = [];
  const seen = new Set();
  const see = (a) => {
    if (a && !seen.has(a)) {
      seen.add(a);
      order.push(a);
    }
  };

  // roomMembers: roomId -> Set<memberName>. Seeded from room.created, updated on
  // room.invited — used to expand "to:["*"]" in room.post events.
  const roomMembers = new Map();

  for (const e of events) {
    see(e.agent);
    if (e.data && typeof e.data.peer === "string") see(e.data.peer);
    if (e.type === "spawn" && typeof e.data.name === "string") see(e.data.name);
    // Room participant lane discovery
    if (e.type === "room.post") {
      if (typeof e.data?.from === "string") see(e.data.from);
      if (Array.isArray(e.data?.to)) {
        e.data.to.forEach((n) => {
          if (n !== "*") see(n);
        });
      }
    }
    if (e.type === "room.created" && Array.isArray(e.data?.members)) {
      e.data.members.forEach((n) => see(n));
      roomMembers.set(e.roomId ?? "", new Set(e.data.members));
    }
    if (e.type === "room.invited" && typeof e.data?.agent === "string") {
      see(e.data.agent);
      const set = roomMembers.get(e.roomId ?? "");
      if (set) set.add(e.data.agent);
    }
  }

  const laneX = new Map();
  const lanes = order.map((agent, i) => {
    const x = 90 + i * 200;
    laneX.set(agent, x);
    return { agent, x };
  });

  const arrows = [];
  // Lane names live in a separate sticky header bar now, so the arrow body
  // starts near the top of its own SVG rather than below an in-canvas header.
  let y = 28;
  const rowH = 46;
  for (const e of events) {
    const row = { y, seq: e.seq, event: e };
    if (e.type === "request.started") {
      arrows.push({
        ...row,
        kind: "request",
        from: "REPL",
        to: e.agent === "REPL" ? (e.data.target ?? "?") : e.agent,
      });
    } else if (e.type === "delegate.start" || e.type === "delegate.continue") {
      arrows.push({ ...row, kind: "delegate", from: e.agent, to: e.data.peer });
    } else if (e.type === "delegate.return") {
      arrows.push({ ...row, kind: "return", from: e.data.peer, to: e.agent });
    } else if (e.type === "tool.call" || e.type === "spawn") {
      arrows.push({ ...row, kind: "self", from: e.agent, to: e.agent });
    } else if (e.type === "message.completed" && e.depth === 0) {
      arrows.push({ ...row, kind: "final", from: e.agent, to: "REPL" });
    } else if (e.type === "error") {
      arrows.push({ ...row, kind: "error", from: e.agent, to: e.agent });
    } else if (e.type === "room.post") {
      const from = e.data?.from ?? e.agent;
      const to = Array.isArray(e.data?.to) ? e.data.to : [];
      const members = roomMembers.get(e.roomId ?? "") ?? new Set();
      const recipients = expandRoomTo(to, from, members);
      if (recipients.length === 0) {
        // Addressing nobody (chain ends here) — render as a self-loop.
        arrows.push({ ...row, kind: "room-self", from, to: from });
      } else {
        for (const t of recipients) {
          // Skip recipients with no lane (defensive; shouldn't occur after discovery).
          if (laneX.has(t)) arrows.push({ ...row, kind: "room", from, to: t });
        }
      }
    } else if (e.type.startsWith("room.")) {
      // Lifecycle badge (room.created, room.ack, room.idle, room.left, etc.)
      arrows.push({ ...row, kind: "room-badge", from: e.agent, to: e.agent });
    } else {
      continue; // turn.started / turn.completed / non-depth0 message.completed: no arrow
    }
    y += rowH;
  }
  return { lanes, laneX: Object.fromEntries(laneX), arrows, height: y + 20 };
}
