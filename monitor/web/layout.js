// Pure function: ordered events -> { lanes, arrows }. No DOM, so it is unit
// testable under Deno. Lanes are ordered by first appearance, REPL first.
export function computeLayout(events) {
  const order = [];
  const seen = new Set();
  const see = (a) => { if (a && !seen.has(a)) { seen.add(a); order.push(a); } };
  see("REPL");
  for (const e of events) {
    see(e.agent);
    if (e.data && typeof e.data.peer === "string") see(e.data.peer);
    if (e.type === "spawn" && typeof e.data.name === "string") see(e.data.name);
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
      arrows.push({ ...row, kind: "request", from: "REPL", to: e.agent === "REPL" ? (e.data.target ?? "?") : e.agent });
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
    } else {
      continue; // turn.started / turn.completed / non-depth0 message.completed: no arrow
    }
    y += rowH;
  }
  return { lanes, laneX: Object.fromEntries(laneX), arrows, height: y + 20 };
}
