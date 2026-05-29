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
