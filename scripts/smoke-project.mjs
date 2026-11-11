import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const project = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chat-unleashed-project-smoke-"));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "chat-unleashed-project-home-"));
const repo = path.join(tmp, "repo");
fs.mkdirSync(path.join(repo, "src", "deep"), { recursive: true });
execFileSync("/usr/bin/git", ["init", "-q"], { cwd: repo });
execFileSync("/usr/bin/git", ["config", "user.email", "smoke@example.com"], { cwd: repo });
execFileSync("/usr/bin/git", ["config", "user.name", "smoke"], { cwd: repo });
fs.writeFileSync(path.join(repo, "AGENTS.md"), "# root rule\nROOT_RULE=1\n");
fs.writeFileSync(path.join(repo, "src", "AGENTS.md"), "# src rule\nSRC_RULE=1\n");
fs.writeFileSync(path.join(repo, "src", "deep", "AGENTS.override.md"), "# deep override\nDEEP_RULE=1\n");
fs.writeFileSync(path.join(repo, "src", "deep", "file.ts"), "export const value = 1;\n");
execFileSync("/usr/bin/git", ["add", "."], { cwd: repo });
execFileSync("/usr/bin/git", ["commit", "-qm", "init"], { cwd: repo });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(project, "dist/index.js"), "--stdio"],
  cwd: project,
  env: { ...process.env, CHAT_UNLEASHED_HOME: home },
});
const client = new Client({ name: "project-smoke", version: "1" });
await client.connect(transport);

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${String(detail).split("\n")[0]}` : ""}`);
  if (!ok) failures++;
}
async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  return { ok: r.isError !== true, text: (r.content ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n") };
}

try {
  let r = await call("project_context", { action: "instructions", root: repo, focus: "src/deep/file.ts" });
  check("AGENTS.md root-to-leaf instruction chain", r.ok && r.text.includes("ROOT_RULE=1") && r.text.includes("SRC_RULE=1") && r.text.includes("DEEP_RULE=1"), r.text);

  r = await call("project_context", { action: "write", root: repo, summary: "resume me", decisions: ["keep API stable"], next: ["run tests"], checks: ["npm test"] });
  check("durable project memory write", r.ok && r.text.includes("resume me"), r.text);

  r = await call("project_context", { action: "resume", root: repo, focus: "src/deep/file.ts" });
  check("resume packet embeds saved state + scoped instructions + live git", r.ok && r.text.includes("resume me") && r.text.includes("ROOT_RULE=1") && r.text.includes("DEEP_RULE=1") && r.text.includes("branch:"), r.text);

  r = await call("task_plan", { title: "project-linked task", root: repo, goal: "prove project context follows the task", steps: [] });
  const taskId = /task_[a-f0-9]+/.exec(r.text)?.[0];
  check("task stores project root", r.ok && Boolean(taskId), r.text);
  if (taskId) {
    r = await call("task_resume", { id: taskId });
    check("task_resume includes project resume context", r.ok && r.text.includes("Project resume context:") && r.text.includes("ROOT_RULE=1"), r.text);
  }

  r = await call("project_review", { root: repo, mode: "quick" });
  check("clean repo passes review", r.ok && r.text.startsWith("PASS:"), r.text);

  fs.writeFileSync(path.join(repo, "src", "deep", "file.ts"), "export const marker = /\\b(TODO|FIXME|HACK)\\b/g;\n");
  r = await call("project_review", { root: repo, mode: "quick" });
  check("review ignores unfinished-marker words inside a regex literal", r.ok && r.text.startsWith("PASS:"), r.text);
  execFileSync("/usr/bin/git", ["checkout", "--", "src/deep/file.ts"], { cwd: repo });

  fs.writeFileSync(path.join(repo, "src", "deep", "file.ts"), "// TODO: replace this placeholder\nexport const value = 1;\n");
  r = await call("project_review", { root: repo, mode: "quick" });
  check("review still reports a real unfinished comment", r.ok && r.text.startsWith("WARN:") && r.text.includes("TODO:"), r.text);
  execFileSync("/usr/bin/git", ["checkout", "--", "src/deep/file.ts"], { cwd: repo });

  fs.writeFileSync(path.join(repo, "src", "deep", "file.ts"), "export const value = 2;\n");
  r = await call("project_review", { root: repo, mode: "quick", includeDiff: true });
  check("review bundle includes patch for semantic review", r.ok && r.text.includes("diff for semantic review:") && r.text.includes("-export const value = 1;") && r.text.includes("+export const value = 2;"), r.text);
  execFileSync("/usr/bin/git", ["checkout", "--", "src/deep/file.ts"], { cwd: repo });

  fs.writeFileSync(path.join(repo, "src", "deep", "file.ts"), "<<<<<<< ours\nconst x = 1;\n=======\nconst x = 2;\n>>>>>>> theirs\n");
  r = await call("project_review", { root: repo, mode: "quick" });
  check("conflict markers fail review", !r.ok && /conflict marker|leftover conflict marker/i.test(r.text), r.text);
  execFileSync("/usr/bin/git", ["checkout", "--", "src/deep/file.ts"], { cwd: repo });

  r = await call("project_review", { root: repo, paths: ["AGENTS.md"], commands: ["printf \"validation-ok\\n\""] });
  check("explicit validation command runs", r.ok && /PASS printf/.test(r.text), r.text);
} finally {
  await client.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}

if (failures) process.exitCode = 1;
else console.log("project smoke: all checks passed");