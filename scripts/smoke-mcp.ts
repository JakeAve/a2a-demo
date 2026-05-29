// Manual end-to-end smoke for the MCP server over a real stdio subprocess.
//
//   deno run -A --unstable-kv --env-file=.env scripts/smoke-mcp.ts
//
// Launches `deno run src/mcp.ts --agents=scout`, connects an MCP client over
// stdio, lists tools, and calls list_agents. Prints PASS/FAIL.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: Deno.execPath(),
  args: [
    "run",
    "-A",
    "--unstable-kv",
    "--env-file=.env",
    "src/mcp.ts",
    "--agents=scout",
  ],
});

const client = new Client({ name: "smoke-mcp", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t: { name: string }) => t.name).join(", "));
if (!tools.tools.some((t: { name: string }) => t.name === "delegate_start")) {
  console.error("FAIL: delegate_start not advertised");
  await client.close();
  Deno.exit(1);
}

const res = await client.callTool({ name: "list_agents", arguments: {} });
const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
console.log("list_agents ->", text);

await client.close();
console.log("PASS");
Deno.exit(0);
