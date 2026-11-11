#!/usr/bin/env node
// Live checks for the tools added for the six targets.
//
//   node scripts/smoke-targets.mjs
//
// Runs the built server over stdio in a throwaway home and exercises the document
// verifier, the code index and goal loop, benchmarks, git review, and the browser
// driver against a headless Chromium on a private port.
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "lap-targets-home-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "lap-targets-"));

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  ${String(detail).split("\n")[0]}` : ""}`);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(project, "dist/index.js"), "--stdio"],
  cwd: project,
  stderr: "inherit",
  env: { ...process.env, CHAT_UNLEASHED_HOME: home },
});
const client = new Client({ name: "targets-smoke", version: "1.0.0" });
await client.connect(transport);

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
  return { ok: res.isError !== true, text };
}

// --- documents -------------------------------------------------------------

const textFile = path.join(work, "report.txt");
fs.writeFileSync(textFile, "Field notes\n\nReadings were recorded every morning for two weeks.\n".repeat(6));
const pdfFile = path.join(work, "report.pdf");
let havePdf = false;
try {
  const out = execFileSync("/usr/sbin/cupsfilter", [textFile], { timeout: 60_000, maxBuffer: 20 * 1024 * 1024 });
  fs.writeFileSync(pdfFile, out);
  havePdf = fs.existsSync(pdfFile) && fs.statSync(pdfFile).size > 1000;
} catch {
  havePdf = false;
}

if (havePdf) {
  const qa = await call("doc", { action: "qa", path: pdfFile, render: true });
  check("doc qa reads a real PDF", /page\(s\)/.test(qa.text), qa.text.split("\n")[0]);
  const chars = Number(/(\d+) characters/.exec(qa.text)?.[1] ?? 0);
  check("doc qa extracts the real text, not a bridge artefact", chars > 100, `${chars} characters`);
  check("a normal PDF is not reported as blank", qa.ok && !/EMPTY/.test(qa.text), qa.text.split("\n").slice(0, 3).join(" | "));
  check("doc qa reports page detail", /pages:/.test(qa.text) || /no blank/.test(qa.text));
check("doc qa does not invent overlapping text in a clean PDF", !/OVERLAP/.test(qa.text), qa.text.split("\n").find((line) => /OVERLAP/.test(line)) ?? "no overlap reported");
  const compare = await call("doc", { action: "compare", path: pdfFile, comparePath: pdfFile });
  check("doc compare finds no change against itself", /no page changed/.test(compare.text), compare.text.split("\n")[0]);
} else {
  console.log("skip  doc qa: cupsfilter did not produce a PDF on this machine");
}

const backup = await call("doc", { action: "backup", path: textFile, label: "before-edit" });
check("doc backup saves a version", backup.ok && /Saved before-edit/.test(backup.text));
const listing = await call("doc", { action: "backups", path: textFile });
check("doc backups lists it", /before-edit/.test(listing.text));
fs.writeFileSync(textFile, "changed after the backup\n");
const restored = await call("doc", { action: "restore", path: textFile });
check("doc restore puts the old content back", restored.ok && fs.readFileSync(textFile, "utf8").startsWith("Field notes"), fs.readFileSync(textFile, "utf8").slice(0, 20));

// --- code index, goal loop, benchmarks ---------------------------------------

const indexed = await call("code_index", { action: "build", root: project });
check("code_index builds an index", indexed.ok && /symbol\(s\)/.test(indexed.text), indexed.text);
const found = await call("code_index", { action: "find", root: project, query: "runTask" });
check("code_index finds a known symbol", found.ok && /runTask/.test(found.text), found.text.split("\n")[1] ?? found.text);
const summary = await call("code_index", { action: "summary", root: project });
check("code_index summarizes the project", /stack: typescript|stack: javascript/.test(summary.text) && /test:/.test(summary.text), summary.text.split("\n")[1]);

const goalOk = await call("code_loop", {
  action: "run",
  root: work,
  id: "smoke-goal",
  goal: "acceptance commands report honestly",
  iteration: 1,
  acceptance: [{ name: "echo", cmd: "echo ready" }, { name: "must match", cmd: "echo 42", expect: "42" }],
});
check("code_loop passes when every command passes", goalOk.ok && /passed/.test(goalOk.text), goalOk.text.split("\n")[0]);
const goalFail = await call("code_loop", {
  action: "run",
  root: work,
  id: "smoke-goal",
  goal: "a failing command must fail the run",
  iteration: 2,
  acceptance: [{ name: "works", cmd: "true" }, { name: "breaks", cmd: "echo boom && exit 3" }],
});
check("code_loop fails the run when a command fails", !goalFail.ok && /FAIL breaks/.test(goalFail.text), goalFail.text.split("\n")[0]);
const goalMismatch = await call("code_loop", {
  action: "run",
  root: work,
  id: "smoke-goal",
  goal: "output must match",
  iteration: 3,
  acceptance: [{ name: "pattern", cmd: "echo apples", expect: "oranges" }],
});
check("code_loop enforces the output pattern", !goalMismatch.ok);
const history = await call("code_loop", { action: "history", id: "smoke-goal" });
check("code_loop kept every iteration", /iteration 1/.test(history.text) && /iteration 3/.test(history.text));
const resources = await call("code_loop", { action: "resources" });
check("code_loop reports machine resources", /Load|free|swap/.test(resources.text), resources.text);

await call("bench", { action: "record", name: "smoke-kernel", channel: "kernel", metric: "ms_per_token", value: 10, unit: "ms", device: "m3" });
await call("bench", { action: "record", name: "smoke-kernel", channel: "kernel", metric: "ms_per_token", value: 16, unit: "ms", device: "m3" });
const bench = await call("bench", { action: "compare", name: "smoke-kernel" });
check("bench flags a slower metric as a regression", !bench.ok && /REGRESSION/.test(bench.text), bench.text);
const benchList = await call("bench", { action: "list" });
check("bench lists samples", /smoke-kernel/.test(benchList.text));

// --- git ---------------------------------------------------------------------

const repo = path.join(work, "repo");
fs.mkdirSync(repo, { recursive: true });
const git = (...args) => execFileSync("/usr/bin/git", ["-C", repo, ...args], { timeout: 30_000, stdio: "pipe" });
git("init", "-q");
git("-c", "user.email=smoke@example.com", "-c", "user.name=Smoke", "commit", "-q", "--allow-empty", "-m", "first");
fs.writeFileSync(path.join(repo, "file.txt"), "hello\n");
const gitStatus = await call("git_work", { action: "status", root: repo });
check("git_work reports an untracked file", /file\.txt/.test(gitStatus.text), gitStatus.text);
const worktree = await call("git_work", { action: "worktree_create", root: repo, name: "smoke" });
check("git_work creates an isolated worktree", worktree.ok && /lap\/smoke/.test(worktree.text), worktree.text);
const worktrees = await call("git_work", { action: "worktree_list", root: repo });
check("git_work lists the worktree", /lap\/smoke/.test(worktrees.text));
const removed = await call("git_work", { action: "worktree_remove", root: repo, name: "smoke" });
check("git_work removes it again", removed.ok, removed.text);

const checkpoint = await call("git_work", { action: "checkpoint", root: repo, message: "smoke checkpoint" });
const checkpointId = /cp_[0-9a-f]+/.exec(checkpoint.text)?.[0] ?? "";
check("git_work checkpoints the working tree", checkpoint.ok && Boolean(checkpointId), checkpoint.text.split("\n")[0]);
check("a checkpoint leaves the working tree alone", fs.readFileSync(path.join(repo, "file.txt"), "utf8") === "hello\n");
fs.writeFileSync(path.join(repo, "file.txt"), "hello\nrewritten after the checkpoint\n");
fs.writeFileSync(path.join(repo, "added.txt"), "a file that should not survive the restore\n");
const restoredRepo = await call("git_work", { action: "restore_checkpoint", root: repo, id: checkpointId });
check("git_work restores a checkpoint", restoredRepo.ok, restoredRepo.text.split("\n")[0]);
check("the restored tree is the checkpointed one", fs.readFileSync(path.join(repo, "file.txt"), "utf8") === "hello\n", JSON.stringify(fs.readFileSync(path.join(repo, "file.txt"), "utf8")));
const checkpointList = await call("git_work", { action: "checkpoints", root: repo });
check("git_work lists checkpoints, including the pre-restore guard", checkpointList.ok && /smoke checkpoint/.test(checkpointList.text) && /before restoring/.test(checkpointList.text), checkpointList.text.split("\n").slice(0, 2).join(" | "));

const profiled = await call("code_loop", { action: "profile", target: String(process.pid), seconds: 1, top: 5 });
check("code_loop profiles a real process", profiled.ok && /frames by sample count|Call graph/i.test(profiled.text), profiled.text.split("\n").slice(0, 2).join(" | "));
const crashes = await call("code_loop", { action: "crashes", limit: 3 });
check("code_loop reads crash reports without failing", typeof crashes.text === "string" && crashes.text.length > 0, crashes.text.split("\n")[0]);

// --- browser -----------------------------------------------------------------

function chromium() {
  const candidates = [
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

// A real http origin, because Chromium ignores the download attribute on file:
// urls, which would make the download check pass for the wrong reason.
const pageHtml = `<!doctype html><html><head><title>Smoke page</title></head><body>
   <h1>Field notes</h1>
   <button id="go" onclick="document.getElementById('out').textContent='clicked'">Save</button>
   <input id="name" aria-label="Name">
   <p id="out">idle</p>
   <a id="dl" href="/dl.txt">Get file</a>
   </body></html>`;
const webPort = 9581;
const webServer = createServer((req, res) => {
  if ((req.url ?? "").startsWith("/dl.txt")) {
    res.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="smoke-dl.txt"' });
    res.end("downloaded through the driver\n");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(pageHtml);
});
await new Promise((resolve) => webServer.listen(webPort, "127.0.0.1", resolve));
const pageUrl = `http://127.0.0.1:${webPort}/page.html`;

const exe = chromium();
let browserProcess;
let cdpReady = false;
if (exe) {
  const port = 9571;
  const profile = path.join(work, "profile");
  browserProcess = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--headless=new", "--no-first-run", "about:blank"], {
    stdio: "ignore",
    detached: false,
  });
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline && !cdpReady) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      cdpReady = res.ok;
    } catch {
      cdpReady = false;
    }
  }
  if (cdpReady) {
    const status = await call("web", { action: "status", port });
    check("web status attaches to Chromium", status.ok && /browser:/.test(status.text), status.text.split("\n")[0]);
    const opened = await call("web", { action: "open", port, url: pageUrl });
    check("web opens a page", opened.ok && /Smoke page/.test(opened.text), opened.text.split("\n")[0]);
    const dom = await call("web", { action: "dom", port, limit: 40 });
    check("web reads the DOM with stable ids", dom.ok && /Save/.test(dom.text) && /id=lap-/.test(dom.text), dom.text.split("\n")[1]);
    const typed = await call("web", { action: "type", port, locator: "label=Name", value: "Example User" });
    check("web types into a field and verifies the value", typed.ok && /Example User/.test(typed.text), typed.text.split("\n")[0]);
    const clicked = await call("web", { action: "click", port, locator: "text=Save" });
    check("web clicks an element and verifies a change", clicked.ok && /verified: page text changed/.test(clicked.text), clicked.text.split("\n")[1] ?? "");
    const text = await call("web", { action: "text", port, limit: 400 });
    check("web reads page text after the click", /clicked/.test(text.text), text.text.split("\n")[0]);
    const snap = await call("web", { action: "snapshot", port });
    check("web snapshots the page for change detection", /text hash/.test(snap.text), snap.text.split("\n")[1] ?? "");
    const inserted = await call("web", { action: "eval", port, script: "document.body.insertAdjacentHTML('beforeend', '<p id=\"fresh\">a line that only appeared after the snapshot</p>'); document.body.innerText.includes('only appeared after the snapshot')" });
    check("web eval changes the live page", /true/.test(inserted.text), inserted.text.split("\n").slice(-1)[0]);
    const changed = await call("web", { action: "changes", port });
    check("web changes reports lines added after a snapshot", changed.ok && /added/.test(changed.text) && /a line that only appeared/.test(changed.text), changed.text.split("\n")[1] ?? changed.text.split("\n")[0]);
    const downloaded = await call("web", { action: "download", port, locator: "text=Get file", timeoutSeconds: 20 });
    const savedDir = /to (\/[^\n]+)\.\n/.exec(downloaded.text)?.[1] ?? "";
    const savedPath = savedDir ? path.join(savedDir, "smoke-dl.txt") : "";
    check("web download saves a file the page offered", downloaded.ok && savedPath !== "" && fs.existsSync(savedPath), downloaded.text.split("\n")[0]);
    const listed = await call("web", { action: "downloads" });
    check("web downloads lists what arrived", /smoke-dl|dl\.txt/.test(listed.text), listed.text.split("\n")[0]);
    const shot = await call("web", { action: "screenshot", port, path: path.join(work, "shot.png") });
    check("web captures a screenshot", shot.ok && fs.existsSync(path.join(work, "shot.png")), shot.text.split("\n")[0]);
    const bad = await call("web", { action: "click", port, locator: "text=DoesNotExist" });
    check("web refuses to click a locator that matches nothing", !bad.ok && /Nothing matched/.test(bad.text));
    const consoleRead = await call("web", { action: "console", port });
    check("web console read answers", typeof consoleRead.text === "string" && consoleRead.text.length > 0);
  }
} else {
  console.log("skip  web: no Chromium browser on this machine");
}
if (!cdpReady) console.log("skip  web: the headless browser did not open a debugging port");
if (browserProcess) {
  try {
    browserProcess.kill("SIGTERM");
  } catch {
    // Already gone.
  }
}
await new Promise((resolve) => webServer.close(resolve));

// --- screen and skills -------------------------------------------------------

const observe = await call("screen_observe", { screenshot: false });
check("screen_observe answers even without accessibility", observe.text.includes("display 0") || observe.text.includes("app:"), observe.text.split("\n")[0]);
const observed = await call("screen_observe", { screenshot: false, context: true });
check(
  "screen_observe reports the stored cross-app context",
  /screen context|No screen context/.test(observed.text),
  observed.text.split("\n").find((line) => /screen context/.test(line)) ?? observed.text.split("\n")[0],
);
const planned = await call("ui_do", { app: "Finder", name: "Save", dryRun: true });
check("ui_do reports why it cannot act instead of pretending", typeof planned.text === "string" && planned.text.length > 0, planned.text.split("\n")[0]);

const saved = await call("skill", {
  action: "save",
  name: "Smoke export",
  description: "proves the skill registry round trips",
  when: ["smoke export"],
  steps: [{ text: "write a file", tool: "shell", args: { cmd: `printf ok > ${path.join(work, "skill.txt")}` }, verify: { kind: "file", path: path.join(work, "skill.txt") } }],
  acceptance: [{ text: "the file exists", check: { kind: "file", path: path.join(work, "skill.txt") } }],
});
check("skill save stores a workflow", saved.ok && /smoke export|Smoke export/.test(saved.text), saved.text.split("\n")[0]);
const matched = await call("skill", { action: "match", text: "please do a smoke export now" });
check("skill match routes by phrase", matched.ok && /Smoke export/.test(matched.text), matched.text.split("\n")[0]);
const compiledSkill = await call("skill", { action: "compile", id: "Smoke export" });
const taskId = /task_[a-f0-9]+/.exec(compiledSkill.text)?.[0] ?? "";
check("skill compile produces a task", compiledSkill.ok && Boolean(taskId), compiledSkill.text.split("\n")[0]);
if (taskId) {
  await call("task_run", { id: taskId, maxSteps: 3 });
  const reported = await call("skill", { action: "report", id: "Smoke export", task: taskId });
  check("skill report records the task verdict", reported.ok && /runs passed/.test(reported.text), reported.text);
}

const seeded = await call("skill", { action: "seed" });
check("skill seed ships the Apple silicon skills", /metal kernel benchmark/i.test(seeded.text), seeded.text.split("\n")[0]);
const seededAgain = await call("skill", { action: "seed" });
check("seeding twice keeps the existing copies", /already present/.test(seededAgain.text), seededAgain.text.split("\n")[0]);
const routed = await call("skill", { action: "match", text: "write a metal kernel benchmark for this mlx model" });
check("the builtin benchmark skills route by phrase", /metal kernel benchmark/i.test(routed.text), routed.text.split("\n")[0]);

const measuredBuiltin = await call("bench", {
  action: "measure",
  root: project,
  cmd: "printf 'kernel = 12.75 ms/token\\n'",
  pattern: "kernel = ([0-9.]+) ms/token",
  name: "smoke-measured-kernel",
  channel: "kernel",
  metric: "ms_per_token",
  unit: "ms/token",
  device: "smoke-device",
});
check("bench measure extracts and records command output", measuredBuiltin.ok && /12\.75/.test(measuredBuiltin.text), measuredBuiltin.text.split("\n")[0]);

const builtinCases = [
  ["metal kernel benchmark", {
    root: project,
    bench_cmd: "printf 'kernel = 12.75 ms/token\\n'",
    pattern: "kernel = ([0-9.]+) ms/token",
    benchmark_name: "smoke-metal-template",
    metric: "ms_per_token",
    unit: "ms/token",
    device: "smoke-device",
  }, 3],
  ["mlx model benchmark", {
    root: project,
    bench_cmd: "printf 'model = 42.5 tok/s\\n'",
    pattern: "model = ([0-9.]+) tok/s",
    benchmark_name: "smoke-mlx-template",
    metric: "tokens_per_second",
    unit: "tok/s",
    device: "smoke-device",
  }, 3],
  ["apple silicon measurement discipline", { profile_target: String(process.pid) }, 2],
];
for (const [name, vars, expectedSteps] of builtinCases) {
  const shown = await call("skill", { action: "show", id: name });
  check(`${name} is an executable builtin`, shown.ok && new RegExp(`steps: ${expectedSteps}(?:,|$)`).test(shown.text), shown.text.split("\n")[0]);
  const missing = await call("skill", { action: "compile", id: name });
  check(`${name} rejects missing template values`, !missing.ok && /needs variables/.test(missing.text), missing.text.split("\n")[0]);
  const compiled = await call("skill", { action: "compile", id: name, vars });
  check(`${name} compiles with template values`, compiled.ok && compiled.text.includes(`with ${expectedSteps} step`), compiled.text.split("\n")[0]);
}
const swiftBuiltin = await call("skill", { action: "show", id: "swift-package acceptance loop" });
check("swift builtin has executable steps", swiftBuiltin.ok && /steps: 2(?:,|$)/.test(swiftBuiltin.text), swiftBuiltin.text.split("\n")[0]);

await client.close();
fs.rmSync(work, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
