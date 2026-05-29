import { assertEquals } from "@std/assert";
import {
  clip, expandRoomTo, roomBadgeLabel, roomPostLabel,
} from "../../monitor/web/room-helpers.js";

// ── clip ──────────────────────────────────────────────────────────────────────

Deno.test("clip truncates long strings and appends ellipsis", () => {
  assertEquals(clip("hello world", 8), "hello w…");
  assertEquals(clip("short", 20), "short");
  assertEquals(clip("  extra   spaces  ", 20), "extra spaces");
});

// ── expandRoomTo ──────────────────────────────────────────────────────────────

Deno.test("expandRoomTo expands * to all members except sender", () => {
  const members = new Set(["Alvy", "Bex", "human"]);
  assertEquals(expandRoomTo(["*"], "Alvy", members), ["Bex", "human"]);
});

Deno.test("expandRoomTo returns named recipients filtered to non-sender non-wildcard", () => {
  const members = new Set(["Alvy", "Bex", "human"]);
  assertEquals(expandRoomTo(["Bex", "human"], "Alvy", members), ["Bex", "human"]);
});

Deno.test("expandRoomTo skips * tokens in named lists and excludes self", () => {
  const members = new Set(["Alvy", "Bex"]);
  assertEquals(expandRoomTo(["Alvy", "*"], "Alvy", members), []);
});

Deno.test("expandRoomTo returns empty for empty to", () => {
  assertEquals(expandRoomTo([], "Alvy", new Set(["Alvy", "Bex"])), []);
});

// ── roomPostLabel ─────────────────────────────────────────────────────────────

Deno.test("roomPostLabel builds from→to: text label", () => {
  const e = { type: "room.post", agent: "Alvy", data: { from: "Alvy", to: ["Bex"], text: "Hello there" } };
  assertEquals(roomPostLabel(e), "Alvy → Bex: Hello there");
});

Deno.test("roomPostLabel shows 'everyone' for broadcast", () => {
  const e = { type: "room.post", agent: "Alvy", data: { from: "Alvy", to: ["*"], text: "Hi all" } };
  assertEquals(roomPostLabel(e), "Alvy → everyone: Hi all");
});

Deno.test("roomPostLabel shows 'nobody' for empty to", () => {
  const e = { type: "room.post", agent: "Alvy", data: { from: "Alvy", to: [], text: "Done" } };
  assertEquals(roomPostLabel(e), "Alvy → nobody: Done");
});

Deno.test("roomPostLabel clips long text", () => {
  const long = "a".repeat(60);
  const e = { type: "room.post", agent: "x", data: { from: "x", to: ["y"], text: long } };
  assertEquals(roomPostLabel(e).length, 48);
  assertEquals(roomPostLabel(e).endsWith("…"), true);
});

// ── roomBadgeLabel ────────────────────────────────────────────────────────────

Deno.test("roomBadgeLabel handles each lifecycle event type", () => {
  const cases: [object, string][] = [
    [{ type: "room.created",          data: { title: "debate", members: ["Alvy", "Bex"] } }, 'created: "debate" (Alvy, Bex)'],
    [{ type: "room.invited",          data: { agent: "Bex" } },                              "invited Bex"],
    [{ type: "room.left",             data: { agent: "Bex" } },                              "Bex left"],
    [{ type: "room.idle",             data: {} } ,                                           "idle"],
    [{ type: "room.capped",           data: { turnCount: 24 } },                             "capped @24"],
    [{ type: "room.turn_timeout",     data: { member: "Bex" } },                             "timeout: Bex"],
    [{ type: "room.delivery_failed",  data: { member: "Bex" } },                             "failed: Bex"],
    [{ type: "room.closed",           data: {} },                                            "closed"],
    [{ type: "room.ack",              agent: "Bex", data: {} },                              "ack from Bex"],
  ];
  for (const [event, expected] of cases) {
    assertEquals(roomBadgeLabel(event as never), expected, `failed for ${(event as {type:string}).type}`);
  }
});
