// monitor/web/app.js
import { renderSwimlane } from "/swimlane.js";

const view = document.getElementById("view");
const crumb = document.getElementById("crumb");

async function getJSON(url) { return (await fetch(url)).json(); }

async function routeSessions() {
  crumb.textContent = "";
  const sessions = await getJSON("/api/sessions");
  view.innerHTML = `<table><thead><tr>
    <th>session</th><th>started</th><th>agents</th><th>requests</th><th>status</th>
    </tr></thead><tbody>${
      sessions.map((s) => `<tr>
        <td><a href="#/session/${s.sessionId}">${s.sessionId.slice(0, 8)}</a></td>
        <td class="mut">${new Date(s.startedAt).toLocaleTimeString()}</td>
        <td>${s.agents.join(", ")}</td>
        <td>${s.requestCount}</td>
        <td>${s.status}</td></tr>`).join("")
    }</tbody></table>`;

  if (routeSessions._es) routeSessions._es.close(); // avoid leaking on auto-refresh
  const es = new EventSource("/stream?session=*");
  es.onmessage = () => { routeSessions._dirty = true; };
  clearInterval(routeSessions._timer);
  routeSessions._timer = setInterval(() => {
    if (routeSessions._dirty && !location.hash.startsWith("#/session/")) {
      routeSessions._dirty = false;
      routeSessions();
    }
  }, 1000);
  routeSessions._es = es;
}

function router() {
  if (routeSessions._es) { routeSessions._es.close(); routeSessions._es = null; }
  clearInterval(routeSessions._timer); // stop list polling when leaving the list route
  const m = location.hash.match(/^#\/session\/(.+)$/);
  if (m) return renderSwimlane(view, crumb, m[1]);
  return routeSessions();
}

globalThis.addEventListener("hashchange", router);
router();
