import { assertEquals } from "@std/assert";
import { getTools, runTool, type ToolDeps } from "../../src/agent/tools.ts";
import type { RoomTurnState } from "../../src/rooms/types.ts";

function depsWithRooms(
  postSpy: (roomId: string, body: unknown) => void,
): ToolDeps {
  const roomTurn: RoomTurnState = {
    active: { roomId: "r1", turnId: "T1", addressedBy: "Alvy", posted: false },
  };
  return {
    store: {} as never,
    threads: {} as never,
    registry: {} as never,
    bearerToken: "t",
    selfName: "Bex",
    roomTurn,
    rooms: {
      post: (roomId: string, body: unknown) => {
        postSpy(roomId, body);
        return Promise.resolve({ seq: 0 });
      },
      createRoom: () => Promise.resolve({ roomId: "r1", unresolved: [] }),
      ack: () => Promise.resolve(),
      invite: () => Promise.resolve(),
      leave: () => Promise.resolve(),
      get: () => Promise.resolve(null),
      listByMember: () => Promise.resolve([]),
    } as never,
  };
}

Deno.test("room tools are exposed when a broker client is present", () => {
  const names = getTools(depsWithRooms(() => {})).map((t) => t.name);
  for (
    const n of [
      "create_room",
      "post",
      "invite",
      "leave",
      "list_rooms",
      "room_history",
    ]
  ) {
    assertEquals(names.includes(n), true, `missing ${n}`);
  }
});

Deno.test("post attaches the active turnId on the first call and marks posted", async () => {
  let captured: { roomId: string; body: { turnId?: string } } | null = null;
  const deps = depsWithRooms((roomId, body) => {
    captured = { roomId, body: body as { turnId?: string } };
  });
  await runTool(
    deps,
    "post",
    { roomId: "r1", text: "hi", to: ["Alvy"] },
    0,
    "ctx",
    { sessionId: "s1", requestId: "r1" },
  );
  assertEquals(captured!.body.turnId, "T1");
  assertEquals(deps.roomTurn!.active!.posted, true);
});
