import { assertEquals } from "@std/assert";
// layout.js is framework-free ESM; import it directly.
import { computeLayout } from "../../monitor/web/layout.js";

const events = [
  { sessionId: "s1", requestId: "r1", seq: 0, ts: 1, agent: "REPL", depth: 0, type: "request.started", data: { target: "coordinator" } },
  { sessionId: "s1", requestId: "r1", seq: 1, ts: 2, agent: "coordinator", depth: 0, type: "delegate.start", data: { peer: "scout" }, threadId: "t1" },
  { sessionId: "s1", requestId: "r1", seq: 2, ts: 3, agent: "coordinator", depth: 0, type: "delegate.return", data: { peer: "scout" }, threadId: "t1" },
  { sessionId: "s1", requestId: "r1", seq: 3, ts: 4, agent: "coordinator", depth: 0, type: "message.completed", data: { text: "done" } },
];

Deno.test("computeLayout assigns a lane per agent including REPL and peers", () => {
  const { lanes } = computeLayout(events);
  const names = lanes.map((l) => l.agent);
  assertEquals(names.includes("REPL"), true);
  assertEquals(names.includes("coordinator"), true);
  assertEquals(names.includes("scout"), true);
});

Deno.test("computeLayout turns delegate.start into an outbound arrow", () => {
  const { arrows } = computeLayout(events);
  const out = arrows.find((a) => a.kind === "delegate" && a.to === "scout")!;
  assertEquals(out.from, "coordinator");
});

Deno.test("computeLayout draws depth-0 message.completed as a return to REPL", () => {
  const { arrows } = computeLayout(events);
  const fin = arrows.find((a) => a.kind === "final")!;
  assertEquals(fin.from, "coordinator");
  assertEquals(fin.to, "REPL");
});

// An MCP-driven session has no REPL events — its driver self-name is "mcp".
const mcpEvents = [
  { sessionId: "s2", requestId: "r1", seq: 0, ts: 1, agent: "mcp", depth: 0, type: "tool.call", data: { tool: "list_agents" } },
  { sessionId: "s2", requestId: "r2", seq: 1, ts: 2, agent: "mcp", depth: 0, type: "delegate.start", data: { peer: "scout" }, threadId: "t1" },
  { sessionId: "s2", requestId: "r2", seq: 2, ts: 3, agent: "mcp", depth: 0, type: "delegate.return", data: { peer: "scout" }, threadId: "t1" },
];

Deno.test("computeLayout omits the REPL lane for an MCP-driven session", () => {
  const { lanes } = computeLayout(mcpEvents);
  const names = lanes.map((l) => l.agent);
  assertEquals(names.includes("REPL"), false);
  assertEquals(names[0], "mcp"); // the driver leads the lanes
  assertEquals(names.includes("scout"), true);
});

// ── Room events ───────────────────────────────────────────────────────────────

const roomEvents = [
  { sessionId: "s1", requestId: "room-1", seq: 10, ts: 1, agent: "room-broker", depth: 0,
    roomId: "room-1", type: "room.created",
    data: { title: "debate", members: ["analyst", "code-reviewer", "human"], maxTurns: 24 } },
  { sessionId: "s1", requestId: "room-1", seq: 11, ts: 2, agent: "analyst", depth: 0,
    roomId: "room-1", type: "room.post",
    data: { from: "analyst", to: ["code-reviewer"], seq: 0, text: "What do you think?" } },
  { sessionId: "s1", requestId: "room-1", seq: 12, ts: 3, agent: "human", depth: 0,
    roomId: "room-1", type: "room.post",
    data: { from: "human", to: ["*"], seq: 1, text: "Great question!" } },
  { sessionId: "s1", requestId: "room-1", seq: 13, ts: 4, agent: "code-reviewer", depth: 0,
    roomId: "room-1", type: "room.post",
    data: { from: "code-reviewer", to: [], seq: 2, text: "I agree" } },
  { sessionId: "s1", requestId: "room-1", seq: 14, ts: 5, agent: "room-broker", depth: 0,
    roomId: "room-1", type: "room.idle", data: {} },
];

Deno.test("computeLayout adds room participants (including human) as lanes", () => {
  const { lanes } = computeLayout(roomEvents);
  const names = new Set(lanes.map((l) => l.agent));
  assertEquals(names.has("analyst"), true);
  assertEquals(names.has("code-reviewer"), true);
  assertEquals(names.has("human"), true);
  assertEquals(names.has("room-broker"), true);
});

Deno.test("computeLayout room.post with named recipient → kind:room arrow", () => {
  const { arrows } = computeLayout(roomEvents);
  const a = arrows.find((x) => x.kind === "room" && x.from === "analyst" && x.to === "code-reviewer");
  assertEquals(a !== undefined, true);
});

Deno.test("computeLayout room.post with to:* → kind:room arrows to all other members", () => {
  const { arrows } = computeLayout(roomEvents);
  // human → * should fan out to analyst and code-reviewer (from room.created members)
  const fans = arrows.filter((x) => x.kind === "room" && x.from === "human");
  const tos = new Set(fans.map((x) => x.to));
  assertEquals(tos.has("analyst"), true);
  assertEquals(tos.has("code-reviewer"), true);
  assertEquals(tos.has("human"), false); // sender excluded
});

Deno.test("computeLayout room.post with to:[] → kind:room-self self-loop", () => {
  const { arrows } = computeLayout(roomEvents);
  const a = arrows.find((x) => x.kind === "room-self" && x.from === "code-reviewer");
  assertEquals(a !== undefined, true);
  assertEquals(a!.to, "code-reviewer");
});

Deno.test("computeLayout room.created → kind:room-badge on room-broker lane", () => {
  const { arrows } = computeLayout(roomEvents);
  const badge = arrows.find((x) => x.kind === "room-badge" && x.event.type === "room.created");
  assertEquals(badge !== undefined, true);
  assertEquals(badge!.from, "room-broker");
});

Deno.test("computeLayout room.idle → kind:room-badge self-loop", () => {
  const { arrows } = computeLayout(roomEvents);
  const badge = arrows.find((x) => x.kind === "room-badge" && x.event.type === "room.idle");
  assertEquals(badge !== undefined, true);
  assertEquals(badge!.from, badge!.to);
});

Deno.test("computeLayout room events do not break existing delegation layout", () => {
  // Mix delegation events with room events — delegation arrows must still appear.
  const mixed = [
    ...events, // the delegation fixture at the top of this file
    ...roomEvents,
  ];
  const { arrows } = computeLayout(mixed);
  const hasDelegate = arrows.some((a) => a.kind === "delegate");
  const hasRoom = arrows.some((a) => a.kind === "room");
  assertEquals(hasDelegate, true);
  assertEquals(hasRoom, true);
});
