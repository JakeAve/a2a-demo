import { assertEquals } from "@std/assert";
import {
  classifyLine,
  formatDelivery,
  parseLeadingMentions,
} from "../src/repl.ts";
import type { InboxDelivery } from "../src/rooms/types.ts";

const NO_FOCUS = {
  focusedRoomId: null,
  focusedMembers: new Set<string>(),
  knownAgents: new Set(["scout", "coordinator"]),
  lastAddressedBy: null,
};
function focused(members: string[], lastAddressedBy: string | null = null) {
  return {
    focusedRoomId: "r1",
    focusedMembers: new Set(members),
    knownAgents: new Set(["scout", "coordinator"]),
    lastAddressedBy,
  };
}

Deno.test("parseLeadingMentions pulls leading @tokens", () => {
  assertEquals(parseLeadingMentions("@A @B hello there"), {
    to: ["A", "B"],
    rest: "hello there",
  });
  assertEquals(parseLeadingMentions("no mentions"), {
    to: [],
    rest: "no mentions",
  });
});

Deno.test("empty / quit / commands", () => {
  assertEquals(classifyLine("", NO_FOCUS).kind, "empty");
  assertEquals(classifyLine(":quit", NO_FOCUS).kind, "quit");
  assertEquals(classifyLine(":q", NO_FOCUS).kind, "quit");
  assertEquals(classifyLine(":rooms", NO_FOCUS).kind, "rooms");
  assertEquals(
    classifyLine(":room leave", focused(["scout"])).kind,
    "roomLeave",
  );
  assertEquals(classifyLine(":room log", focused(["scout"])).kind, "roomLog");
});

Deno.test(":room new parses a multi-word title and member CSV", () => {
  const c = classifyLine(":room new hotdog debate Alvy,Bex", NO_FOCUS);
  assertEquals(c, {
    kind: "roomNew",
    title: "hotdog debate",
    members: ["Alvy", "Bex"],
  });
});

Deno.test(":room join parses a roomId", () => {
  assertEquals(classifyLine(":room join r-123", NO_FOCUS), {
    kind: "roomJoin",
    roomId: "r-123",
  });
});

Deno.test("@agent direct-send when not focused", () => {
  assertEquals(classifyLine("@scout find foo", NO_FOCUS), {
    kind: "direct",
    agent: "scout",
    prompt: "find foo",
  });
});

Deno.test("unknown @name when not focused is a hint", () => {
  assertEquals(classifyLine("@nobody hi", NO_FOCUS).kind, "hint");
});

Deno.test("@member while focused is a room post", () => {
  assertEquals(
    classifyLine("@Bex your turn", focused(["Bex"])),
    { kind: "roomPost", to: ["Bex"], text: "your turn" },
  );
});

Deno.test("@known-agent that is NOT a focused member still direct-sends", () => {
  assertEquals(
    classifyLine("@scout summarize", focused(["Bex"])),
    { kind: "direct", agent: "scout", prompt: "summarize" },
  );
});

Deno.test("plain line while focused replies to last addresser", () => {
  assertEquals(
    classifyLine("sounds good", focused(["Bex"], "Bex")),
    { kind: "roomPost", to: ["Bex"], text: "sounds good" },
  );
});

Deno.test("plain line while focused with no addresser broadcasts", () => {
  assertEquals(
    classifyLine("anyone there", focused(["Bex"], null)),
    { kind: "roomPost", to: ["*"], text: "anyone there" },
  );
});

Deno.test("formatDelivery renders the addressed line", () => {
  const d: InboxDelivery = {
    roomId: "r1",
    turnId: "t1",
    addressedBy: "Bex",
    title: "debate",
    members: ["human", "Bex"],
    transcript: [{
      seq: 0,
      roomId: "r1",
      from: "Bex",
      to: ["human"],
      text: "your move",
      ts: 1,
    }],
  };
  assertEquals(formatDelivery(d), "[room: debate] Bex → you: your move");
});
