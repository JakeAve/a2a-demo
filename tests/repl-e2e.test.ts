import { assertEquals } from "@std/assert";
import { runRepl } from "../src/repl.ts";
import { startRoomBroker } from "../src/rooms/server.ts";
import { RoomBrokerClient } from "../src/rooms/client.ts";
import type { AgentCard } from "../src/protocol/types.ts";

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
