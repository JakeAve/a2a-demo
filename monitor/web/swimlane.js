// monitor/web/swimlane.js
import { computeLayout } from "/layout.js";

const COLOR = { request: "var(--repl)", delegate: "var(--del)", continue: "var(--del)",
  return: "var(--ret)", final: "var(--ret)", self: "var(--del)", error: "#e05555" };

const HEAD = 44; // height of the sticky lane-name bar

// Escape for safe inlining into SVG/HTML text nodes.
const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

// Collapse whitespace and clip to a character budget, appending an ellipsis.
const clip = (s, n) => {
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s;
};

// Render an inspector value. Tool args/results arrive as JSON strings; indent
// them so nested structure is readable. Plain strings pass through untouched.
const pretty = (v) => {
  if (typeof v !== "string") return JSON.stringify(v, null, 2);
  try {
    const parsed = JSON.parse(v);
    if (parsed && typeof parsed === "object") return JSON.stringify(parsed, null, 2);
  } catch { /* not JSON — show as-is */ }
  return v;
};

// The most useful one-line preview for each event kind, so the message is
// readable on the wire without clicking through to the detail panel.
function preview(e) {
  const d = e.data ?? {};
  switch (e.type) {
    case "request.started": return d.prompt ?? d.target ?? "";
    case "delegate.start": return d.prompt ?? d.title ?? "";
    case "delegate.continue": return d.prompt ?? "";
    case "delegate.return": return d.preview ?? (d.ok === false ? "failed" : "returned");
    case "message.completed": return d.text ?? "";
    case "tool.call": return d.tool ?? "";
    case "spawn": return d.name ?? d.role ?? "";
    case "error": return d.message ?? "error";
    default: return e.type;
  }
}

export async function renderSwimlane(view, crumb, sessionId) {
  crumb.innerHTML = `/ <a href="#/">sessions</a> / ${sessionId.slice(0, 8)}`;
  const data = await (await fetch(`/api/sessions/${sessionId}`)).json();
  let events = data.events;
  // Collapse state for the inspector lives here so it survives the full
  // re-render that every redraw (selection, live SSE event) triggers.
  let collapsed = false;

  const draw = (selectedSeq) => {
    const { lanes, laneX, arrows, height } = computeLayout(events);
    const width = 90 + lanes.length * 200;
    const heads =
      `<rect x="0" y="0" width="${width}" height="${HEAD}" fill="var(--bg)"/>` +
      lanes.map((l) =>
        `<text x="${l.x}" y="27" text-anchor="middle" class="lane-head">${esc(l.agent)}</text>`).join("") +
      `<line x1="0" y1="${HEAD - 0.5}" x2="${width}" y2="${HEAD - 0.5}" stroke="var(--line)"/>`;
    const guides = lanes.map((l) =>
      `<line x1="${l.x}" y1="0" x2="${l.x}" y2="${height}" stroke="#fff2" stroke-dasharray="3 5"/>`).join("");
    const body = arrows.map((a) => {
      const x1 = laneX[a.from], x2 = laneX[a.to];
      const color = COLOR[a.kind] ?? "var(--repl)";
      const dash = (a.kind === "return" || a.kind === "final") ? `stroke-dasharray="5 4"` : "";
      const on = a.seq === selectedSeq;
      const sel = on ? `stroke-width="3.5"` : `stroke-width="2"`;
      const cls = on ? "msg sel" : "msg";
      if (a.from === a.to) {
        // Self-loop (tool call / spawn / error): a small lobe with its label.
        const d = a.event.data ?? {};
        const label = clip(
          a.event.type === "tool.call" ? (d.tool ?? "tool")
            : a.event.type === "spawn" ? `spawn ${d.name ?? d.role ?? ""}`.trim()
            : a.event.type === "error" ? `error: ${d.message ?? ""}`
            : a.event.type,
          28);
        return `<path d="M${x1},${a.y} q44,-6 44,8 q0,15 -44,8" fill="none" stroke="${color}" stroke-width="1.6" data-seq="${a.seq}" style="cursor:pointer"/>
                <text x="${x1 + 52}" y="${a.y + 4}" class="${cls}" data-seq="${a.seq}" style="cursor:pointer">· ${esc(label)}</text>`;
      }
      // Inter-lane message: line + arrowhead + an inline, ellipsized preview
      // centered above the wire so its content is legible at a glance.
      const dir = x2 > x1 ? 1 : -1;
      const head = `${x2},${a.y} ${x2 - dir * 7},${a.y - 4} ${x2 - dir * 7},${a.y + 4}`;
      const budget = Math.max(6, Math.floor(Math.abs(x2 - x1) / 6.6) - 4);
      const label = esc(clip(preview(a.event), budget));
      return `<g data-seq="${a.seq}" style="cursor:pointer">
                <line x1="${x1}" y1="${a.y}" x2="${x2 - dir * 6}" y2="${a.y}" stroke="${color}" ${sel} ${dash}/>
                <polygon points="${head}" fill="${color}"/>
                <text x="${(x1 + x2) / 2}" y="${a.y - 5}" text-anchor="middle" class="${cls}">${label}</text>
              </g>`;
    }).join("");
    view.innerHTML =
      `<div class="swim">
         <div class="lane-scroll">
           <div class="lane-canvas" style="width:${width}px">
             <svg class="lane-headers" width="${width}" height="${HEAD}">${heads}</svg>
             <svg class="lane-body" width="${width}" height="${height}">${guides}${body}</svg>
           </div>
         </div>
         <div class="detail${collapsed ? " collapsed" : ""}" id="detail">
           <div class="detail-head">
             <span class="mut">message inspector</span>
             <button type="button" class="collapse-btn" id="collapse-btn"
               aria-expanded="${!collapsed}" title="${collapsed ? "Expand" : "Collapse"} inspector">${collapsed ? "▴" : "▾"}</button>
           </div>
           <div class="detail-body" id="detail-body"><span class="mut">click a message to inspect</span></div>
         </div>
       </div>`;

    view.querySelectorAll("[data-seq]").forEach((el) => {
      // Selecting a message always reveals the inspector, even if collapsed.
      el.addEventListener("click", () => { collapsed = false; draw(Number(el.getAttribute("data-seq"))); });
    });
    // Collapse toggle: flip the closure flag and reflect it on the panel
    // in place — no full redraw, so the current selection stays put.
    const btn = document.getElementById("collapse-btn");
    btn.addEventListener("click", () => {
      collapsed = !collapsed;
      document.getElementById("detail").classList.toggle("collapsed", collapsed);
      btn.textContent = collapsed ? "▴" : "▾";
      btn.setAttribute("aria-expanded", String(!collapsed));
      btn.title = `${collapsed ? "Expand" : "Collapse"} inspector`;
    });
    if (selectedSeq != null) {
      const e = events.find((x) => x.seq === selectedSeq);
      if (e) {
        document.getElementById("detail-body").innerHTML =
          `<strong>${esc(e.agent)} · ${esc(e.type)}</strong>
           <div class="mut">seq ${e.seq} · depth ${e.depth}${e.threadId ? " · thread " + esc(e.threadId) : ""}</div>
           ${Object.entries(e.data).map(([k, v]) =>
             `<div class="bubble"><span class="mut">${esc(k)}</span>\n${esc(pretty(v))}</div>`).join("")}`;
      }
    }
  };

  draw(null);

  const es = new EventSource(`/stream?session=${sessionId}`);
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === "hello") return;
    events = [...events, ev].sort((a, b) => a.seq - b.seq);
    draw(null);
  };
  globalThis.addEventListener("hashchange", () => es.close(), { once: true });
}
