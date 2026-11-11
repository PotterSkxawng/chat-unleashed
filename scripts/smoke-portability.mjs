#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const project = path.resolve(import.meta.dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "chat unleashed portability "));
const home = path.join(temp, "Home With Spaces");
const state = path.join(temp, "Application Support", "Chat Unleashed");
fs.mkdirSync(home, { recursive: true });

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures += 1;
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(project, "dist", "index.js"), "--stdio"],
  cwd: home,
  env: {
    ...process.env,
    HOME: home,
    CHAT_UNLEASHED_HOME: state,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  },
});
const client = new Client({ name: "portability-smoke", version: "1" });

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const output = (result.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return { ok: result.isError !== true, text: output };
}

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  check("portable server exposes the core tool surface", tools.tools.length >= 100 && names.has("run_command") && names.has("pages_inspect"));

  const configPath = await call("app_config", { action: "path" });
  check(
    "runtime state respects CHAT_UNLEASHED_HOME with spaces",
    configPath.ok && path.resolve(configPath.text.trim()) === path.resolve(path.join(state, "config.json")),
    configPath.text.trim(),
  );

  const shell = await call("run_command", {
    command: "command -v node && node -p 'process.platform + \"-\" + process.arch'",
    cwd: home,
  });
  check(
    "minimal GUI-style PATH still finds the active Node runtime",
    shell.ok && /darwin-arm64/.test(shell.text),
    shell.text.split("\n").slice(-2).join(" | "),
  );

  const network = await call("network_info", {});
  check("network discovery runs without assuming en0", network.ok && /Gateway:|Interfaces:/.test(network.text));

  // App discovery should not block on Automation permission or open documents.
  const iwork = await call("iwork_apps", { includeDocuments: false });
  check("iWork discovery returns a structured status without fixed install paths", iwork.ok && /iWork apps/.test(iwork.text));

  const audit = path.join(state, "logs", "audit.log");
  check("audit log is stored in per-user app state", fs.existsSync(audit), audit);
} finally {
  await client.close().catch(() => {});
  fs.rmSync(temp, { recursive: true, force: true });
}

if (failures) process.exit(1);
console.log("portability smoke: all checks passed");
