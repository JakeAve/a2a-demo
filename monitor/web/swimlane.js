// monitor/web/swimlane.js
import { computeLayout } from "/layout.js";

const COLOR = { request: "var(--repl)", delegate: "var(--del)", continue: "var(--del)",
  return: "var(--ret)", final: "var(--ret)", self: "var(--del)", error: "#e05555" };

export async function renderSwimlane(view, crumb, sessionId) {
  crumb.innerHTML = `/ <a href="#/">sessions</a> / ${sessionId.slice(0, 8)}`;
  const data = await (await fetch(`/api/sessions/${sessionId}`)).json();
  let events = data.events;

  const draw = (selectedSeq) => {
    const { lanes, laneX, arrows, height } = computeLayout(events);
    const width = 90 + lanes.length * 200;
    const heads = lanes.map((l) =>
      `<text x="${l.x}" y="24" text-anchor="middle" class="lane-head">${l.agent}</text>
       <line x1="${l.x}" y1="36" x2="${l.x}" y2="${height}" stroke="#fff2" stroke-dasharray="3 5"/>`).join("");
    const body = arrows.map((a) => {
      const x1 = laneX[a.from], x2 = laneX[a.to];
      const color = COLOR[a.kind] ?? "var(--repl)";
      const dash = (a.kind === "return" || a.kind === "final") ? `stroke-dasharray="5 4"` : "";
      const sel = a.seq === selectedSeq ? `stroke-width="3.5"` : `stroke-width="2"`;
      if (a.from === a.to) {
        return `<path d="M${x1},${a.y} q44,-6 44,8 q0,15 -44,8" fill="none" stroke="${color}" stroke-width="1.6" data-seq="${a.seq}"/>
                <text x="${x1 + 52}" y="${a.y + 4}">· ${a.event.data.tool ?? a.event.type}</text>`;
      }
      return `<line x1="${x1}" y1="${a.y}" x2="${x2}" y2="${a.y}" stroke="${color}" ${sel} ${dash} data-seq="${a.seq}" style="cursor:pointer"/>`;
    }).join("");
    view.innerHTML =
      `<div class="tabs" id="tabs"></div>
       <svg width="${width}" height="${height}" id="canvas">${heads}${body}</svg>
       <div class="detail" id="detail"><span class="mut">click an arrow to inspect</span></div>`;

    view.querySelectorAll("[data-seq]").forEach((el) => {
      el.addEventListener("click", () => draw(Number(el.getAttribute("data-seq"))));
    });
    if (selectedSeq != null) {
      const e = events.find((x) => x.seq === selectedSeq);
      if (e) {
        document.getElementById("detail").innerHTML =
          `<strong>${e.agent} · ${e.type}</strong>
           <div class="mut">seq ${e.seq} · depth ${e.depth}${e.threadId ? " · thread " + e.threadId : ""}</div>
           ${Object.entries(e.data).map(([k, v]) =>
             `<div class="bubble"><span class="mut">${k}</span>\n${typeof v === "string" ? v : JSON.stringify(v)}</div>`).join("")}`;
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
