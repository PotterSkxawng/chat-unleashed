#!/usr/bin/env node
// End-to-end smoke test: spawns the built server over stdio, lists the tool
// surface, then calls the safe, read-mostly tools and reports what each did.
//
//   node scripts/smoke.mjs            # everything
//   node scripts/smoke.mjs system     # only tools whose name contains "system"
//
// Tools that legitimately need macOS permissions or a running app are marked
// EXPECTED so a fresh machine still passes; their output is printed either way.
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, "..");
const filter = process.argv[2] ?? "";
const smokeHome = process.env.LOCAL_AGENT_MCP_HOME ? null : fs.mkdtempSync(path.join(os.tmpdir(), "local-agent-smoke-"));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(project, "dist/index.js"), "--stdio"],
  cwd: project,
  stderr: "inherit",
  env: { ...process.env, LOCAL_AGENT_MCP_HOME: process.env.LOCAL_AGENT_MCP_HOME ?? smokeHome },
});

const client = new Client({ name: "local-agent-mcp-smoke", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`\ntools/list -> ${tools.length} tools`);
const names = tools.map((t) => t.name).sort();
console.log(names.join(", "), "\n");

const calls = [
  ["app_config", { action: "path" }],
  ["app_config", { action: "get" }],
  ["mac_permissions", { action: "status" }],
  ["system_info", {}],
  ["window_list", {}],
  ["app_control", { action: "list" }],
  ["process_list", { limit: 3 }],
  ["process_control", { action: "info", pid: process.pid }],
  ["network_info", {}],
  ["power", { action: "status" }],
  ["audio", { action: "get" }],
  ["media", { action: "status" }, "expected"],
  ["spotlight", { name: "package.json", within: project, limit: 3 }],
  ["recent_files", { within: project, hours: 72, limit: 3 }],
  ["file_ops", { action: "du", path: project }],
  ["shell_session", { action: "start", cwd: project }],
  ["shell_session", { action: "run", command: "echo smoke-$((6*7)) && pwd" }],
  ["shell_session", { action: "list" }],
  ["shell_session", { action: "stop" }],
  ["wait_for", { condition: "port_open", target: "1", timeoutSeconds: 1 }, "expected"],
  ["browser", { action: "tabs" }, "expected"],
  ["screen_capture", {}],
  ["ui_tree", {}],
];

let passed = 0;
let failed = 0;
let expected = 0;

for (const [name, args, mode] of calls) {
  if (filter && !name.includes(filter)) continue;
  const started = Date.now();
  let line;
  try {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
    const text = (res.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    const images = (res.content ?? []).filter((c) => c.type === "image").length;
    const first = text.split("\n").slice(0, 3).join(" | ").slice(0, 220);
    const isError = !!res.isError;
    if (mode === "expected" || isError) {
      // A permission-gated tool reporting exactly why is a pass for a fresh machine,
      // but anything unexpected is printed loudly.
      const permissionish = /permission|Accessibility|Screen Recording|not allowed|blocked|no .* running|Not met/i.test(text);
      if (mode === "expected" || permissionish) {
        expected++;
        line = `EXPECTED  ${name.padEnd(16)} ${first}`;
      } else {
        failed++;
        line = `FAIL      ${name.padEnd(16)} ${first}`;
      }
    } else {
      passed++;
      line = `ok        ${name.padEnd(16)} ${images ? `[${images} image] ` : ""}${first}`;
    }
  } catch (err) {
    failed++;
    line = `ERROR     ${name.padEnd(16)} ${(err && err.message) || err}`;
  }
  console.log(`${line}   (${Date.now() - started}ms)`);
}

await client.close();
if (smokeHome) fs.rmSync(smokeHome, { recursive: true, force: true });
console.log(`\n${passed} ok, ${expected} expected/permission-gated, ${failed} failed`);
process.exit(failed ? 1 : 0);
