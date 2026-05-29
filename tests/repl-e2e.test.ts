import { assertEquals } from "@std/assert";
import { runRepl } from "../src/repl.ts";
import { startRoomBroker } from "../src/rooms/server.ts";
import { RoomBrokerClient } from "../src/rooms/client.ts";
import type { AgentCard } from "../src/protocol/types.ts";
import { startAgent } from "../src/agent/base.ts";
import { makeRoomTurnProcessor } from "../src/agent/room-turn.ts";
import type { RoomTurnState } from "../src/rooms/types.ts";
import type { PostInput } from "../src/rooms/types.ts";
import type { EmitEvent } from "../src/observability/events.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Yields scripted lines with a gap before each so async deliveries can land.
async function* scripted(lines: string[], gapMs = 150): AsyncGenerator<string> {
  for (const l of lines) {
    await sleep(gapMs);
    yield l;
  }
}

Deno.test("runRepl creates a room, focuses it, and posts a typed line", async () => {
  const kv = await Deno.openKv(":memory:");
  const broker = await startRoomBroker({
    kv, port: 0, token: "tok",
    resolveInbox: () => Promise.resolve(null), // no agents resolve; room is human-only
    agentDeadlineMs: 1000, humanDeadlineMs: 60_000, defaultMaxTurns: 24, sweepIntervalMs: 0,
  });
  const out: string[] = [];

  await runRepl({
    agents: new Map<string, AgentCard>(),
    bearerToken: "tok",
    roomBrokerUrl: broker.url,
    humanName: "human",
    output: (s) => out.push(s),
    input: scripted([":room new solo X", "hello room", ":quit"]),
  });

  const client = new RoomBrokerClient(broker.url, "tok");
  const rooms = await client.listByMember("human");
  assertEquals(rooms.length, 1);
  const got = await client.get(rooms[0].roomId);
  const mine = got!.transcript.find((m) => m.from === "human");
  assertEquals(mine?.text, "hello room");

  await broker.shutdown(); kv.close();
});

function card(name: string): AgentCard {
  return {
    name, description: "", version: "1.0.0", url: "http://localhost:0", skills: [],
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } }, security: [{ bearer: [] }],
  };
}

// Stub agent: on its FIRST delivery, replies to whoever addressed it; then silent.
async function stubAgent(name: string, brokerUrl: string) {
  const rooms = new RoomBrokerClient(brokerUrl, "tok");
  const roomTurn: RoomTurnState = { active: null };
  let turn = 0;
  const handler = async (ctx: { requestId: string }) => {
    if (turn++ === 0) {
      await rooms.post(ctx.requestId, {
        from: name, text: "hi there", to: [roomTurn.active!.addressedBy], turnId: roomTurn.active!.turnId,
      });
    }
    return { text: "" }; // posted (or staying silent -> room-turn auto-acks)
  };
  const store = { clear: () => Promise.resolve() } as never;
  const onInbox = makeRoomTurnProcessor({ selfName: name, handler, rooms, roomTurn, store });
  const handle = await startAgent({
    card: card(name), bearerToken: "tok", handler: () => Promise.resolve({ text: "" }),
    // deno-lint-ignore require-yield
    streamHandler: async function* () { return; }, onInbox,
  });
  return { handle, url: `http://localhost:${handle.port}` };
}

Deno.test("human receives a delivery and replies with the correct turnId", async () => {
  const kv = await Deno.openKv(":memory:");
  const urls: Record<string, string> = {};
  const events: EmitEvent[] = [];
  const broker = await startRoomBroker({
    kv, port: 0, token: "tok",
    resolveInbox: (n) => Promise.resolve(urls[n] ?? null),
    emit: (e) => { events.push(e); return Promise.resolve(); },
    agentDeadlineMs: 2000, humanDeadlineMs: 60_000, defaultMaxTurns: 24, sweepIntervalMs: 0,
  });
  const bex = await stubAgent("Bex", broker.url);
  urls["Bex"] = bex.url;

  // A client wrapper that records the human's outgoing posts (to inspect turnId).
  const real = new RoomBrokerClient(broker.url, "tok");
  const postCalls: Array<{ roomId: string; body: PostInput }> = [];
  const spy = {
    createRoom: (b: Parameters<RoomBrokerClient["createRoom"]>[0]) => real.createRoom(b),
    join: (id: string, b: Parameters<RoomBrokerClient["join"]>[1]) => real.join(id, b),
    post: (id: string, b: PostInput) => { postCalls.push({ roomId: id, body: b }); return real.post(id, b); },
    leave: (id: string, n: string) => real.leave(id, n),
    get: (id: string) => real.get(id),
    listByMember: (n: string) => real.listByMember(n),
  } as unknown as RoomBrokerClient;

  const out: string[] = [];
  await runRepl({
    agents: new Map<string, AgentCard>(),
    bearerToken: "tok",
    roomsClient: spy,
    humanName: "human",
    output: (s) => out.push(s),
    // gap 250ms so each round-trip (broker -> Bex -> broker -> human inbox) lands.
    input: scripted([":room new debate Bex", "@Bex hello", "your turn", ":quit"], 250),
  });

  // 1. The delivery from Bex printed for the human.
  const printed = out.join("");
  assertEquals(printed.includes("[room: debate] Bex → you: hi there"), true);

  // 2. The human's reply ("your turn") addressed Bex and carried a turnId.
  const reply = postCalls.find((p) => p.body.text === "your turn");
  assertEquals(reply?.body.to, ["Bex"]);
  assertEquals(typeof reply?.body.turnId, "string");

  // 3. The room reached idle — only possible if that turnId resolved the
  //    human's pending delivery (sweep is off, so a wrong/missing turnId
  //    would leave it pending forever).
  assertEquals(events.some((e) => e.type === "room.idle"), true);

  // 4. Transcript shows the full exchange.
  const rid = postCalls[0].roomId;
  const texts = (await real.get(rid))!.transcript.map((m) => m.text);
  assertEquals(texts.includes("hello"), true);
  assertEquals(texts.includes("hi there"), true);
  assertEquals(texts.includes("your turn"), true);

  await bex.handle.shutdown(); await broker.shutdown(); kv.close();
});
