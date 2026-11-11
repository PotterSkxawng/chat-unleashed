import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-unleashed-scale-"));
const home = path.join(root, "home");
process.env.CHAT_UNLEASHED_HOME = home;

let failures = 0;
function check(name, ok, detail = "") {
  console.log((ok ? "ok  " : "FAIL") + " " + name + (detail ? "  " + detail : ""));
  if (!ok) failures++;
}
function timed(name, fn) {
  const start = performance.now();
  return Promise.resolve(fn()).then((value) => {
    const ms = performance.now() - start;
    console.log("time " + name + ": " + ms.toFixed(1) + " ms");
    return { value, ms };
  });
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

try {
  const store = await import("../.stress/store.js");
  const large = await import("../.stress/large-text.js");
  const coding = await import("../.stress/coding.js");
  const capacity = await import("../.stress/capacity.js");
  const exec = await import("../.stress/exec.js");
  const tasks = await import("../.stress/tasks.js");
  const skills = await import("../.stress/skills.js");

  // 1) Large JSONL tail: ~50 MiB on disk, bounded tail read.
  const jsonl = path.join(root, "huge.jsonl");
  const fd = fs.openSync(jsonl, "w");
  const payload = "x".repeat(420);
  const jsonLines = 120000;
  for (let i = 0; i < jsonLines; i++) fs.writeSync(fd, JSON.stringify({ n: i, payload }) + "\n");
  fs.closeSync(fd);
  const rssBeforeTail = process.memoryUsage().rss;
  const tailRun = await timed("50MiB JSONL tail(100)", () => store.readJsonl(jsonl, 100));
  const rssTailDelta = process.memoryUsage().rss - rssBeforeTail;
  check("JSONL tail returns newest records", tailRun.value.length === 100 && tailRun.value[0].n === jsonLines - 100 && tailRun.value[99].n === jsonLines - 1, "rss delta " + Math.round(rssTailDelta / 1024 / 1024) + " MiB");

  // 2) Deep offset in a large text file.
  const textFile = path.join(root, "million-lines.log");
  const out = fs.openSync(textFile, "w");
  const lineCount = 1000000;
  const chunkLines = 10000;
  for (let base = 1; base <= lineCount; base += chunkLines) {
    let chunk = "";
    for (let i = base; i < Math.min(base + chunkLines, lineCount + 1); i++) chunk += "line-" + i + " payload\n";
    fs.writeSync(out, chunk);
  }
  fs.closeSync(out);
  const deepRun = await timed("1M-line deep read", () => large.readTextLines(textFile, 999901, 50, 200000));
  check("deep line offsets work beyond initial byte window", deepRun.value.rows.length === 50 && deepRun.value.rows[0].includes("line-999901") && deepRun.value.rows[49].includes("line-999950"));

  // 3) Large repository symbol index + cache + root collision protection.
  const repo = path.join(root, "big", "repo");
  fs.mkdirSync(repo, { recursive: true });
  const sourceFiles = 20000;
  for (let d = 0; d < 100; d++) {
    const dir = path.join(repo, "src", "d" + d);
    fs.mkdirSync(dir, { recursive: true });
    for (let j = 0; j < 200; j++) {
      const i = d * 200 + j;
      fs.writeFileSync(path.join(dir, "f" + i + ".ts"), "export function fn" + i + "(x: number) { return x + " + i + "; }\n");
    }
  }
  const indexRun = await timed("20k-file symbol index", () => coding.indexRepo({ root: repo, maxFiles: 30000, maxBytes: 64 * 1024 * 1024, maxSymbols: 50000 }));
  check("large repo indexed completely", indexRun.value.symbols === sourceFiles && indexRun.value.limited === false, indexRun.value.symbols + " symbols");
  const findRun = await timed("500 cached symbol queries", async () => {
    let last;
    for (let i = 0; i < 500; i++) last = await coding.findSymbols({ root: repo, query: "fn19999", limit: 5 });
    return last;
  });
  check("cached repeated symbol lookup stays correct", findRun.value.hits.length === 1 && findRun.value.hits[0].name === "fn19999");
  const repo2 = path.join(root, "other", "repo");
  fs.mkdirSync(repo2, { recursive: true });
  fs.writeFileSync(path.join(repo2, "x.ts"), "export const otherRepo = 1;\n");
  const idx2 = await coding.indexRepo({ root: repo2 });
  check("same-basename repos get distinct index files", idx2.file !== indexRun.value.file);

  // 4) Durable task history: thousands of task files, bounded open/recent views.
  const taskCount = 5000;
  const taskRun = await timed("create 5k durable tasks", () => {
    const made = [];
    for (let i = 0; i < taskCount; i++) {
      const task = tasks.createTask({ title: "stress-" + i, goal: "stress", steps: [] });
      if (i % 2 === 0) { task.status = "done"; tasks.saveTask(task); }
      made.push(task);
    }
    return made;
  });
  const firstList = await timed("first task-index migration/list", () => tasks.listTasks(false, 100));
  const secondList = await timed("bounded open-task list", () => tasks.listTasks(false, 100));
  const allRecent = await timed("bounded recent-all list", () => tasks.listTasks(true, 100));
  check("open task list is bounded/correct", firstList.value.length === 100 && secondList.value.length === 100);
  check("recent all-task list is bounded", allRecent.value.length === 100);

  // 5) Skill registry: thousands of saved workflows, cached repeated routing.
  const skillCount = 2000;
  const skillSave = await timed("save 2k reusable skills", () => {
    for (let i = 0; i < skillCount; i++) {
      skills.saveSkill({
        name: "stress-skill-" + i,
        description: "synthetic routing skill " + i,
        when: ["trigger" + i],
        steps: [],
      });
    }
  });
  const skillList1 = await timed("cold list 2k skills", () => skills.listSkills());
  const skillList2 = await timed("cached list 2k skills", () => skills.listSkills());
  check("skill registry lists all synthetic skills", skillList1.value.length === skillCount && skillList2.value.length === skillCount);
  check("skill list cache removes repeat parse/stat cost", skillList2.ms < Math.max(20, skillList1.ms * 0.25), `${skillList1.ms.toFixed(1)}ms -> ${skillList2.ms.toFixed(1)}ms`);
  const skillMatch = await timed("500 cached skill-routing passes", () => {
    let last;
    for (let i = 0; i < 500; i++) last = skills.matchSkills("please run trigger1999", skills.listSkills(), 5);
    return last;
  });
  check("cached skill routing remains correct", skillMatch.value?.[0]?.skill?.name === "stress-skill-1999");

  // 6) Backpressure: remain under active cap, then reject overload instead of ballooning.
  const normal = Array.from({ length: 200 }, async () => {
    const release = await capacity.acquireToolSlot();
    await new Promise((r) => setTimeout(r, 2));
    release();
  });
  await Promise.all(normal);
  let status = capacity.capacityStatus();
  check("capacity limiter obeys active ceiling", status.peakActive <= status.maxActive && status.rejected === 0, JSON.stringify(status));
  const overload = await Promise.allSettled(Array.from({ length: 1000 }, async () => {
    const release = await capacity.acquireToolSlot();
    await new Promise((r) => setTimeout(r, 20));
    release();
  }));
  status = capacity.capacityStatus();
  const rejected = overload.filter((x) => x.status === "rejected").length;
  check("overload is rejected with backpressure", rejected > 0 && status.peakActive <= status.maxActive, rejected + " rejected; peak active " + status.peakActive);

  // 7) Capped command output preserves both the beginning and final diagnostics.
  const noisy = await exec.run("/bin/zsh", ["-lc", "printf HEAD-MARKER; yes x | head -c 2000000; printf TAIL-MARKER"], { timeoutMs: 5000, maxBytes: 65536 });
  check("bounded command capture preserves head and tail", noisy.truncated && noisy.out.includes("HEAD-MARKER") && noisy.out.includes("TAIL-MARKER") && noisy.out.includes("middle output truncated"));

  // 8) Timeout cleanup kills grandchildren, not only the shell process.
  const proc = await exec.run("/bin/zsh", ["-lc", "sleep 60 & echo $!; wait"], { timeoutMs: 250, maxBytes: 10000 });
  const childPid = Number(proc.out.trim().split(/\\s+/)[0]);
  await new Promise((r) => setTimeout(r, 120));
  check("timeout kills process group/grandchildren", proc.timedOut && childPid > 0 && !alive(childPid), "child pid " + childPid);

  console.log("stress root: " + root);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  for (const module of ["store", "large-text", "exec", "coding", "tasks", "capacity", "skills"]) {
    fs.rmSync(path.join(process.cwd(), ".stress", `${module}.js`), { force: true });
  }
  try { fs.rmdirSync(path.join(process.cwd(), ".stress")); } catch {}
}

if (failures) process.exitCode = 1;
else console.log("scale stress: all checks passed");