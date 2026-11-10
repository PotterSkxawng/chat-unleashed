import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const project = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "local-agent-files-scale-"));
const flat = path.join(temp, "flat");
const home = path.join(temp, "home");
fs.mkdirSync(flat, { recursive: true });

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
}
async function call(client, name, args) {
  const start = performance.now();
  const r = await client.callTool({ name, arguments: args });
  const ms = performance.now() - start;
  const text = (r.content ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
  console.log(`time ${name}: ${ms.toFixed(1)} ms`);
  return { ok: r.isError !== true, text, ms };
}

let client;
try {
  const start = performance.now();
  for (let i = 0; i < 30_000; i++) {
    fs.writeFileSync(path.join(flat, `file-${String(i).padStart(5, "0")}.txt`), i === 29_999 ? "needle-at-end\n" : "ordinary\n");
  }
  console.log(`time create 30k flat files: ${(performance.now() - start).toFixed(1)} ms`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(project, "dist/index.js"), "--stdio"],
    cwd: project,
    env: { ...process.env, LOCAL_AGENT_MCP_HOME: home },
  });
  client = new Client({ name: "files-scale", version: "1" });
  await client.connect(transport);

  const listed = await call(client, "list_directory", { path: flat, maxEntries: 50 });
  check(
    "30k-entry directory listing stays bounded",
    listed.ok && listed.text.includes("10000+ scanned entries") && listed.text.includes("directory scan capped at 10000 entries"),
    listed.text.split("\n")[0] || "",
  );

  const downloads = await call(client, "web", { action: "downloads", path: flat });
  check(
    "browser download listing stays bounded on 30k files",
    downloads.ok && downloads.text.includes("20 newest file(s)") && downloads.text.includes("scanned 30000 entries"),
    downloads.text.split("\n")[0] || "",
  );

  const searchLast = await call(client, "search_files", {
    root: flat,
    query: "file-29999",
    mode: "name",
    maxResults: 1,
  });
  check("streamed name search finds deep flat-directory entry", searchLast.ok && searchLast.text.includes("file-29999.txt"), searchLast.text.split("\n").slice(-1)[0] || "");

  const searchNone = await call(client, "search_files", {
    root: flat,
    query: "definitely-not-present-xyz",
    mode: "name",
    maxResults: 5,
  });
  check("no-match search scans large flat directory without failure", searchNone.ok && /scanned 30000 entries/.test(searchNone.text), searchNone.text.split("\n").slice(-1)[0] || "");

  const target = path.join(flat, "million-lines.txt");
  const fd = fs.openSync(target, "w");
  for (let base = 0; base < 1_000_000; base += 10_000) {
    let chunk = "";
    for (let i = base; i < base + 10_000; i++) chunk += `line-${i + 1}\n`;
    fs.writeSync(fd, chunk);
  }
  fs.closeSync(fd);
  const deep = await call(client, "read_file", { path: target, offset: 999_950, limit: 25 });
  check("MCP read_file handles deep offsets in million-line files", deep.ok && deep.text.includes("line-999950") && deep.text.includes("line-999974"));

} finally {
  if (client) await client.close().catch(() => {});
  fs.rmSync(temp, { recursive: true, force: true });
}

if (failures) {
  console.error(`file stress: ${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log("file stress: all checks passed");
}
