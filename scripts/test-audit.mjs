#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(import.meta.dirname, "..");
const state = fs.mkdtempSync(path.join(os.tmpdir(), "chat-unleashed-audit-"));
const privateMarker = ["synthetic", "private", "value", Date.now()].join("-");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist", "index.js"), "--stdio"],
  cwd: root,
  stderr: "pipe",
  env: { ...process.env, LOCAL_AGENT_MCP_HOME: state },
});
const client = new Client({ name: "audit-regression", version: "1" });

try {
  await client.connect(transport);

  const listed = await client.listTools();
  const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
  for (const name of ["run_command", "write_file", "download_file", "file_ops", "process_control", "web", "app_config", "doc", "code_loop", "project_context"]) {
    assert.equal(byName.get(name)?.annotations?.destructiveHint, true, `${name} must advertise destructive capability`);
  }
  for (const name of ["read_file", "window_list", "system_info", "contacts", "task_status"]) {
    assert.equal(byName.get(name)?.annotations?.readOnlyHint, true, `${name} must advertise read-only behavior`);
  }

  const set = await client.callTool({
    name: "app_config",
    arguments: { action: "set", key: "integrations.secrets.auditTest", value: privateMarker },
  });
  assert.equal(Boolean(set.isError), false);

  const reveal = await client.callTool({
    name: "app_config",
    arguments: { action: "reveal", key: "integrations.secrets.auditTest" },
  });
  assert.equal(Boolean(reveal.isError), false);
  assert.ok(reveal.content.some((part) => part.type === "text" && part.text.includes(privateMarker)));

  const run = await client.callTool({
    name: "run_command",
    arguments: {
      command: "printf audit-ok",
      env: { AUDIT_TEST_PRIVATE: privateMarker },
    },
  });
  assert.equal(Boolean(run.isError), false);

  await client.close();

  const log = fs.readFileSync(path.join(state, "logs", "audit.log"), "utf8");
  assert.ok(log.includes('"tool":"app_config"'));
  assert.ok(log.includes('"tool":"run_command"'));
  assert.ok(log.includes("[REDACTED]"));
  assert.ok(!log.includes(privateMarker), "synthetic secret leaked into audit.log");
  assert.ok(!log.includes("synthetic-private-value"), "revealed secret content leaked into audit summary");

  console.log("audit privacy and MCP risk metadata passed");
} finally {
  try { await client.close(); } catch {}
  fs.rmSync(state, { recursive: true, force: true });
}
