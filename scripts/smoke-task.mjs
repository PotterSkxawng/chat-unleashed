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
const unverifiedFile = path.join(home, "unverified.txt");
const directFile = path.join(home, "direct-write.txt");
const forbiddenCheckFile = path.join(home, "forbidden-check.txt");
const exclusiveWriteFile = path.join(home, "exclusive-write.txt");
const lockRaceFile = path.join(home, "lock-race.txt");


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

// A step without a verification check must execute at most once. It remains
// visibly unverified, but task_run must not replay its side effect to fill the
// per-call step budget.
const unverifiedPlan = await call(second, "task_plan", {
  title: "unverified step does not replay",
  steps: [{ text: "append once", tool: "shell", args: { cmd: `printf 'x\n' >> '${unverifiedFile}'` } }],
});
const unverifiedId = /task_[a-f0-9]+/.exec(unverifiedPlan.text)?.[0] ?? "";
const unverifiedRun = await call(second, "task_run", { id: unverifiedId, maxSteps: 3 });
const unverifiedLines = fs.existsSync(unverifiedFile) ? fs.readFileSync(unverifiedFile, "utf8").trim().split("\n").filter(Boolean) : [];
check("an unverified action executes once per explicit queueing", unverifiedRun.ok && unverifiedLines.length === 1, `${unverifiedLines.length} line(s)`);
const unverifiedAgain = await call(second, "task_run", { id: unverifiedId, maxSteps: 3 });
const unverifiedLinesAgain = fs.existsSync(unverifiedFile) ? fs.readFileSync(unverifiedFile, "utf8").trim().split("\n").filter(Boolean) : [];
check("a later task_run does not silently replay an unverified action", unverifiedAgain.ok && unverifiedLinesAgain.length === 1 && /unverified/.test(unverifiedAgain.text), `${unverifiedLinesAgain.length} line(s)`);

const lockPlan = await call(second, "task_plan", {
  title: "same-process task lock",
  steps: [{
    text: "append once after a short delay",
    tool: "shell",
    args: { cmd: `sleep 0.5; printf 'x\n' >> '${lockRaceFile}'` },
    verify: { kind: "shell", cmd: `test "$(wc -l < '${lockRaceFile}')" -eq 1` },
  }],
});
const lockId = /task_[a-f0-9]+/.exec(lockPlan.text)?.[0] ?? "";
const lockRuns = await Promise.all([
  call(second, "task_run", { id: lockId, maxSteps: 1 }),
  call(second, "task_run", { id: lockId, maxSteps: 1 }),
]);
const lockLines = fs.existsSync(lockRaceFile) ? fs.readFileSync(lockRaceFile, "utf8").trim().split("\n").filter(Boolean) : [];
check(
  "same-process concurrent task_run calls have one lock owner",
  lockRuns.filter((result) => result.ok).length === 1 &&
    lockRuns.filter((result) => !result.ok && /already running/.test(result.text)).length === 1 &&
    lockLines.length === 1,
  `${lockLines.length} side effect(s)`,
);

// State identifiers must never become path traversal primitives.
const outsideTask = path.join(home, "outside.json");
fs.writeFileSync(outsideTask, JSON.stringify({
  id: "../outside", title: "TRAVERSAL_SENTINEL", goal: "", status: "active",
  created: new Date().toISOString(), updated: new Date().toISOString(), acceptance: [], steps: [],
  context: { apps: [], files: [], facts: {} }, budget: { maxSteps: 1, maxMinutes: 1 },
}));
const traversalTask = await call(second, "task_status", { id: "../outside" });
check("task ids cannot escape the task state directory", !traversalTask.ok && /filename-safe/.test(traversalTask.text) && !/TRAVERSAL_SENTINEL/.test(traversalTask.text));

const outsideSkill = path.join(home, "outside-skill.json");
fs.writeFileSync(outsideSkill, JSON.stringify({
  id: "skill_outside", name: "TRAVERSAL_SKILL_SENTINEL", description: "", when: [], steps: [],
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  stats: { runs: 0, passed: 0, failed: 0, totalMs: 0 },
}));
const traversalSkill = await call(second, "skill", { action: "show", id: "../outside-skill" });
check("skill ids cannot escape the skill state directory", !traversalSkill.ok && !/TRAVERSAL_SKILL_SENTINEL/.test(traversalSkill.text));

// Direct MCP registrations must exist in the in-process task registry too.
// write_file is destructive, so the same metadata also has to gate it.
const directPlan = await call(second, "task_plan", {
  title: "direct MCP tool registry",
  steps: [{
    text: "write through the direct MCP registration",
    tool: "write_file",
    args: { path: directFile, content: "direct tool works\n" },
    verify: { kind: "file", path: directFile },
  }],
});
const directId = /task_[a-f0-9]+/.exec(directPlan.text)?.[0] ?? "";
check("direct destructive MCP tools inherit the task approval gate", /Approval needed/.test(directPlan.text));
const directBlocked = await call(second, "task_run", { id: directId, maxSteps: 1 });
check("a direct destructive tool cannot run before approval", directBlocked.ok && !fs.existsSync(directFile) && /Needs approval/.test(directBlocked.text));
const directApproved = await call(second, "task_approve", { id: directId, step: "s1" });
const directRun = await call(second, "task_run", { id: directId, maxSteps: 1 });
check("an approved direct MCP tool executes through the task registry", directApproved.ok && directRun.ok && fs.readFileSync(directFile, "utf8") === "direct tool works\n");

const exclusiveWrites = await Promise.all([
  call(second, "write_file", { path: exclusiveWriteFile, content: "first\n" }),
  call(second, "write_file", { path: exclusiveWriteFile, content: "second\n" }),
]);
check(
  "write_file overwrite=false has an exclusive winner",
  exclusiveWrites.filter((result) => result.ok).length === 1 &&
    exclusiveWrites.filter((result) => !result.ok).length === 1 &&
    ["first\n", "second\n"].includes(fs.readFileSync(exclusiveWriteFile, "utf8")),
);

// Verification is evidence, not another mutation channel. A tool check must
// refuse any handler that is not explicitly read-only.
const checkPlan = await call(second, "task_plan", {
  title: "verification cannot mutate",
  acceptance: [{
    text: "destructive tool checks are refused",
    check: { kind: "tool", tool: "write_file", args: { path: forbiddenCheckFile, content: "must not exist" } },
  }],
});
const checkId = /task_[a-f0-9]+/.exec(checkPlan.text)?.[0] ?? "";
const checkClose = await call(second, "task_close", { id: checkId });
check("tool verification refuses non-read-only tools", !checkClose.ok && /not verification-safe: write_file/.test(checkClose.text) && !fs.existsSync(forbiddenCheckFile));

const mixedReadPlan = await call(second, "task_plan", {
  title: "mixed tool read-only verification",
  steps: [{
    text: "summarize the project without mutating it",
    tool: "code_index",
    args: { action: "summary", root: project },
    verify: { kind: "tool", tool: "code_index", args: { action: "summary", root: project }, expect: "stack: javascript" },
  }],
});
const mixedReadId = /task_[a-f0-9]+/.exec(mixedReadPlan.text)?.[0] ?? "";
const mixedReadRun = await call(second, "task_run", { id: mixedReadId, maxSteps: 1 });
check("verification allows explicitly safe actions on mixed tools", mixedReadRun.ok && /s1 done/.test(mixedReadRun.text) && !/Approval needed/.test(mixedReadPlan.text));

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
