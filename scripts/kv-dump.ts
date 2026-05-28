const kv = await Deno.openKv();
const iter = kv.list({ prefix: ["context"] });
for await (const entry of iter) {
  console.log("---", entry.key.join("/"));
  const msgs = entry.value as Array<{ role: string; content: string }>;
  for (const m of msgs) {
    console.log(`[${m.role}] ${m.content}`);
  }
}
kv.close();
