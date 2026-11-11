#!/usr/bin/env node
// End-to-end test for the durable task layer.
//
//   node scripts/smoke-task.mjs
//
// It drives the built server over stdio in a throwaway home directory and checks
// the promises that matter: a step is only done when its check passes, a
// destructive step waits for approval, progress survives a client restart, and
// editing a verified step invalidates its evidence.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "lap-smoke-tasks-"));
const outFile = path.join(home, "out.txt");
const missingFile = path.join(home, "missing.txt");


let pass = 0;
let fail = 0;

function check(name, ok, detail = "") {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

async function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(project, "dist/index.js"), "--stdio"],
    cwd: project,
    stderr: "inherit",
    env: { ...process.env, CHAT_UNLEASHED_HOME: home },
  });
  const client = new Client({ name: "task-smoke", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return { ok: res.isError !== true, text };
}

const plan = {
  title: "task layer self test",
  goal: "prove the orchestrator distinguishes executed from verified",
  acceptance: [
    { text: "out.txt exists", check: { kind: "file", path: outFile } },
    { text: "the second output file exists", check: { kind: "file", path: missingFile } },
  ],
  steps: [
    { text: "write the first line", tool: "shell", args: { cmd: `printf one > ${outFile}` }, verify: { kind: "file", path: outFile } },
    { text: "append the second line", tool: "shell", args: { cmd: `printf two >> ${outFile}` }, verify: { kind: "shell", cmd: `grep -q two ${outFile}` } },
    { text: "clean the throwaway directory", tool: "shell", args: { cmd: `rm -rf ${path.join(home, "nothing-here")}` }, verify: { kind: "shell", cmd: "true" } },
  ],
};

const first = await connect();

const created = await call(first, "task_plan", plan);
const id = /task_[a-f0-9]+/.exec(created.text)?.[0] ?? "";
check("task_plan returns an id", Boolean(id), id);
check("task_plan reports the approval gate", /Approval needed/.test(created.text));

const run = await call(first, "task_run", { id, maxSteps: 5 });
check("run verifies the safe steps", /2\/3 steps verified/.test(run.text), run.text.split("\n")[0]);
check("run stops at the destructive step", /Needs approval: s3/.test(run.text));

const status = await call(first, "task_status", { id });
check("status shows verified evidence", /\[done\]/.test(status.text) && /evidence:/.test(status.text));

const earlyClose = await call(first, "task_close", { id });
check("close refuses unmet criteria", !earlyClose.ok && /Unmet criteria/.test(earlyClose.text));

await first.close();

// A fresh client proves the state came from disk, not from memory.
const second = await connect();
const resumed = await call(second, "task_resume", { id });
check("resume finds the verified work", /Last verified step: s2/.test(resumed.text), resumed.text.split("\n")[0]);
check("resume names the blocked step", /Waiting on approval: s3/.test(resumed.text));

const approved = await call(second, "task_approve", { id, step: "s3" });
check("approve clears the gate", approved.ok && /Approved s3/.test(approved.text));

const runAgain = await call(second, "task_run", { id, maxSteps: 5 });
check("approved step runs", /3\/3 steps verified/.test(runAgain.text), runAgain.text.split("\n")[0]);

// Edit a step that was already verified: its evidence must stop counting.
const taskFile = path.join(home, "tasks", `${id}.json`);
const stored = JSON.parse(fs.readFileSync(taskFile, "utf8"));
stored.steps[0].args.cmd = `printf changed > ${outFile}`;
fs.writeFileSync(taskFile, JSON.stringify(stored, null, 2));

const afterEdit = await call(second, "task_resume", { id });
check("editing a verified step re-queues it", /Re-queued s1/.test(afterEdit.text) || /\[pending\]/.test(afterEdit.text), afterEdit.text.split("\n")[0]);

const staleRun = await call(second, "task_run", { id, maxSteps: 5 });
check("the re-queued step runs again", staleRun.ok && /verified/.test(staleRun.text));

const steered = await call(second, "task_steer", {
  id,
  action: "insert",
  step: "s2",
  text: "record a third line",
  tool: "shell",
  args: { cmd: `printf three >> ${outFile}` },
  verify: { kind: "shell", cmd: `grep -q three ${outFile}` },
});
check("insert adds a step", steered.ok && /Inserted s4/.test(steered.text));

const afterSteer = await call(second, "task_run", { id, maxSteps: 5 });
check("inserted step executes and verifies", afterSteer.ok && /s4 done/.test(afterSteer.text));

fs.writeFileSync(missingFile, "present\n");
const closed = await call(second, "task_close", { id });
check("close succeeds once criteria pass", closed.ok && /Closed/.test(closed.text), closed.text.split("\n")[0]);

const steerClosed = await call(second, "task_steer", { id, action: "note", text: "late note" });
check("closed task refuses steering", !steerClosed.ok && /closed/i.test(steerClosed.text));

const listing = await call(second, "task_status", { all: true });
check("closed task appears with all=true", listing.text.includes(id));

await second.close();
fs.rmSync(home, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
