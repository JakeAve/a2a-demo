// monitor/web/swimlane.js
// STUB — replaced in Task 15 with the real swimlane renderer.
export function renderSwimlane(view, crumb, sessionId) {
  crumb.innerHTML = `/ <a href="#/">sessions</a> / ${sessionId.slice(0, 8)}`;
  view.innerHTML = `<p class="mut">Session view coming in Task 15 — ${sessionId}</p>`;
}
