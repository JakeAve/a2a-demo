import { assert, assertEquals } from "@std/assert";
import {
  buildMcpServer,
  callMcpTool,
  mcpToolList,
} from "../../src/mcp-server.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolDeps } from "../../src/agent/tools.ts";
import { RegistryClient } from "../../src/registry/client.ts";
import type { EmitEvent } from "../../src/observability/events.ts";

// A registry stub serving an empty agent list on /agents.
function emptyRegistry(): {
  client: RegistryClient;
  stop: () => Promise<void>;
} {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    if (new URL(req.url).pathname === "/agents") {
      return new Response("[]", {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("null", {
      headers: { "content-type": "application/json" },
    });
  });
  const port = (server.addr as Deno.NetAddr).port;
  return {
    client: new RegistryClient(`http://localhost:${port}`),
    stop: () => server.shutdown(),
  };
}

function depsFor(registry: RegistryClient, events: EmitEvent[]): ToolDeps {
  return {
    store: null as never,
    threads: null as never,
    registry,
    bearerToken: "t",
    selfName: "mcp",
    emit: (e) => {
      events.push(e);
      return Promise.resolve();
    },
    // spawnAgent/availableRoles omitted -> spawn tools should NOT be listed.
  };
}

Deno.test("mcpToolList without spawn deps lists only base tools, in MCP inputSchema shape", () => {
  const deps = depsFor(new RegistryClient("http://localhost:1"), []);
  const tools = mcpToolList(deps);
  const names = tools.map((t) => t.name);
  assertEquals(names, [
    "list_agents",
    "list_my_threads",
    "delegate_start",
    "delegate_continue",
    "reset_thread",
  ]);
  // Each tool carries an MCP-shaped JSON Schema under inputSchema (not `parameters`).
  const start = tools.find((t) => t.name === "delegate_start")!;
  assertEquals(start.inputSchema.type, "object");
  assert(start.inputSchema.required.includes("agent"));
});

Deno.test("mcpToolList with spawn deps adds spawn_agent and list_roles", () => {
  const deps = depsFor(new RegistryClient("http://localhost:1"), []);
  deps.spawnAgent = () => Promise.resolve({ ok: true, name: "x" });
  deps.availableRoles = () => [];
  const names = mcpToolList(deps).map((t) => t.name);
  assert(names.includes("spawn_agent"));
  assert(names.includes("list_roles"));
});

Deno.test("callMcpTool routes to runTool and wraps the result as text content", async () => {
  const reg = emptyRegistry();
  const events: EmitEvent[] = [];
  const deps = depsFor(reg.client, events);

  const res = await callMcpTool(deps, "ctx-1", "sess-1", "list_agents", {});
  await reg.stop();

  assertEquals(res.content, [{ type: "text", text: "[]" }]);
  assertEquals(res.isError, undefined);
  // It emitted a tool.call carrying the MCP session/request ids and selfName.
  const call = events.find((e) => e.type === "tool.call")!;
  assertEquals(call.data.tool, "list_agents");
  assertEquals(call.sessionId, "sess-1");
  assertEquals(call.agent, "mcp");
});

Deno.test("callMcpTool flags an error result with isError", async () => {
  const reg = emptyRegistry();
  const deps = depsFor(reg.client, []);
  // Unknown tool -> runTool returns {"error":"unknown tool ..."} JSON, never throws.
  const res = await callMcpTool(deps, "ctx-1", "sess-1", "nope", {});
  await reg.stop();
  assertEquals(res.isError, true);
  assert(res.content[0].text.includes("unknown tool"));
});

Deno.test("e2e: an MCP client lists tools and calls list_agents through the server", async () => {
  const reg = emptyRegistry();
  const deps = depsFor(reg.client, []);

  const [clientTransport, serverTransport] = InMemoryTransport
    .createLinkedPair();
  const server = buildMcpServer(deps, "ctx-e2e", "sess-e2e");
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "1.0.0" }, {
    capabilities: {},
  });
  await client.connect(clientTransport);

  const listed = await client.listTools();
  const names = listed.tools.map((t: { name: string }) => t.name);
  assert(names.includes("delegate_start"));
  assert(names.includes("list_agents"));

  const result = await client.callTool({ name: "list_agents", arguments: {} });
  assertEquals((result.content as { type: string; text: string }[])[0], {
    type: "text",
    text: "[]",
  });

  await client.close();
  await server.close();
  await reg.stop();
});
