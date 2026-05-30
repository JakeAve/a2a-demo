import { assertEquals } from "@std/assert";
import { startRoomBroker } from "../../src/rooms/server.ts";
import { RoomBrokerClient } from "../../src/rooms/client.ts";
import { startAgent } from "../../src/agent/base.ts";
import { makeRoomTurnProcessor } from "../../src/agent/room-turn.ts";
import type { AgentCard } from "../../src/protocol/types.ts";
import type { RoomTurnState } from "../../src/rooms/types.ts";

function card(name: string): AgentCard {
  return {
    name,
    description: "",
    version: "1.0.0",
    url: "http://localhost:0",
    skills: [],
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    security: [{ bearer: [] }],
  };
}

// A stub agent that posts a reply via the broker, then (optionally) stays silent.
async function stubAgent(
  name: string,
  brokerUrl: string,
  reply: (turn: number) => string | null,
) {
  const rooms = new RoomBrokerClient(brokerUrl, "tok");
  const roomTurn: RoomTurnState = { active: null };
  let turn = 0;
  const handler = async (ctx: { requestId: string }) => {
    const r = reply(turn++);
    if (r !== null) {
      // address the other member by replying to whoever addressed us
      await rooms.post(ctx.requestId, {
        from: name,
        text: r,
        to: [roomTurn.active!.addressedBy],
        turnId: roomTurn.active!.turnId,
      });
    }
    return { text: "" }; // we posted explicitly; nothing to wrap
  };
  const store = { clear: () => Promise.resolve() } as never;
  const onInbox = makeRoomTurnProcessor({
    selfName: name,
    handler,
    rooms,
    roomTurn,
    store,
  });
  const handle = await startAgent({
    card: card(name),
    bearerToken: "tok",
    handler: () => Promise.resolve({ text: "" }),
    // deno-lint-ignore require-yield
    streamHandler: async function* () {
      return;
    },
    onInbox,
  });
  return { handle, url: `http://localhost:${handle.port}` };
}

Deno.test("two stub agents converse directly and the room goes idle", async () => {
  const kv = await Deno.openKv(":memory:");
  const urls: Record<string, string> = {};
  const broker = await startRoomBroker({
    kv,
    port: 0,
    token: "tok",
    resolveInbox: (n) => Promise.resolve(urls[n] ?? null),
    agentDeadlineMs: 2000,
    humanDeadlineMs: 2000,
    defaultMaxTurns: 24,
    sweepIntervalMs: 0,
  });

  // Alvy replies twice then goes quiet; Bex replies twice then goes quiet.
  const alvy = await stubAgent(
    "Alvy",
    broker.url,
    (t) => (t < 2 ? `Alvy-${t}` : null),
  );
  const bex = await stubAgent(
    "Bex",
    broker.url,
    (t) => (t < 2 ? `Bex-${t}` : null),
  );
  urls["Alvy"] = alvy.url;
  urls["Bex"] = bex.url;

  const client = new RoomBrokerClient(broker.url, "tok");
  const { roomId } = await client.createRoom({
    title: "debate",
    members: ["Alvy", "Bex"],
    createdBy: "Alvy",
    sessionId: "s1",
  });
  await client.post(roomId, { from: "Alvy", text: "opening", to: ["Bex"] });

  // Wait for the chain to wind down.
  for (let i = 0; i < 50; i++) {
    if ((await client.get(roomId))!.room && await isIdle(client, roomId)) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const got = await client.get(roomId);
  const texts = got!.transcript.map((m) => m.text);
  // opening + Bex-0, Alvy-0, Bex-1, Alvy-1 (then both silent)
  assertEquals(texts[0], "opening");
  assertEquals(texts.includes("Bex-0"), true);
  assertEquals(texts.includes("Alvy-1"), true);

  await alvy.handle.shutdown();
  await bex.handle.shutdown();
  await broker.shutdown();
  kv.close();
});

async function isIdle(
  client: RoomBrokerClient,
  roomId: string,
): Promise<boolean> {
  // No public idle endpoint; approximate by checking transcript stability across a tick.
  const a = (await client.get(roomId))!.transcript.length;
  await new Promise((r) => setTimeout(r, 40));
  const b = (await client.get(roomId))!.transcript.length;
  return a === b;
}

Deno.test("a non-stop ping-pong is bounded by maxTurns", async () => {
  const kv = await Deno.openKv(":memory:");
  const urls: Record<string, string> = {};
  const broker = await startRoomBroker({
    kv,
    port: 0,
    token: "tok",
    resolveInbox: (n) => Promise.resolve(urls[n] ?? null),
    agentDeadlineMs: 2000,
    humanDeadlineMs: 2000,
    defaultMaxTurns: 6,
    sweepIntervalMs: 0,
  });
  // Both always reply -> would loop forever without the backstop.
  const alvy = await stubAgent("Alvy", broker.url, () => "A");
  const bex = await stubAgent("Bex", broker.url, () => "B");
  urls["Alvy"] = alvy.url;
  urls["Bex"] = bex.url;

  const client = new RoomBrokerClient(broker.url, "tok");
  const { roomId } = await client.createRoom({
    title: "pingpong",
    members: ["Alvy", "Bex"],
    createdBy: "Alvy",
    sessionId: "s1",
    maxTurns: 6,
  });
  await client.post(roomId, { from: "Alvy", text: "go", to: ["Bex"] });

  await new Promise((r) => setTimeout(r, 600));
  const got = await client.get(roomId);
  // turnCount never exceeds maxTurns (6); transcript length is capped.
  assertEquals(got!.room.turnCount <= 6, true);

  await alvy.handle.shutdown();
  await bex.handle.shutdown();
  await broker.shutdown();
  kv.close();
});
