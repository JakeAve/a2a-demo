// monitor/web/room-helpers.js
// Pure helpers for room event rendering. No DOM. Importable by deno test.

export const clip = (s, n) => {
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s;
};

// One-line label for a room.post event (used in self-loop labels + inspector).
export function roomPostLabel(event) {
  const d = event.data ?? {};
  const from = d.from ?? event.agent ?? "?";
  const to = Array.isArray(d.to) ? d.to : [];
  const toStr = to.includes("*") ? "everyone" : (to.join(", ") || "nobody");
  return clip(`${from} → ${toStr}: ${d.text ?? ""}`, 48);
}

// Short label for a room lifecycle badge.
export function roomBadgeLabel(event) {
  const d = event.data ?? {};
  switch (event.type) {
    case "room.created":
      return `created: "${clip(d.title ?? "", 16)}" (${
        (d.members ?? []).join(", ")
      })`;
    case "room.invited":
      return `invited ${d.agent ?? "?"}`;
    case "room.ack":
      return `ack from ${event.agent ?? "?"}`;
    case "room.left":
      return `${d.agent ?? "?"} left`;
    case "room.idle":
      return "idle";
    case "room.capped":
      return `capped @${d.turnCount ?? "?"}`;
    case "room.turn_timeout":
      return `timeout: ${d.member ?? "?"}`;
    case "room.delivery_failed":
      return `failed: ${d.member ?? "?"}`;
    case "room.closed":
      return "closed";
    default:
      return event.type;
  }
}

// Expand `to` to a concrete list of recipients.
// If `to` is exactly `["*"]`, expands to all members except the sender.
// For named lists, filters out `"*"` tokens and the sender; does NOT
// validate names against memberSet (callers own that guard).
export function expandRoomTo(to, from, memberSet) {
  if (to.length === 1 && to[0] === "*") {
    return [...memberSet].filter((n) => n !== from);
  }
  return to.filter((n) => n !== "*" && n !== from);
}
