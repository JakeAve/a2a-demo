// monitor/main.ts
// Standalone monitor service. Run: deno task monitor
import { load } from "@std/dotenv";
import { startMonitor } from "./server.ts";

await load({ export: true });
const env = Deno.env.toObject();
const port = Number(env.MONITOR_PORT ?? 7891);
const kvPath = env.MONITOR_KV_PATH ?? "./a2a-monitor.db";
const token = env.AGENT_BEARER_TOKEN ?? "";
const webDir = new URL("./web", import.meta.url).pathname;

const kv = await Deno.openKv(kvPath);
const mon = await startMonitor({ kv, port, token, webDir });
console.log(`[monitor] ${mon.url}  (kv: ${kvPath})`);

const shutdown = async () => {
  await mon.shutdown();
  kv.close();
  Deno.exit(0);
};
Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);
await new Promise<void>(() => {});
