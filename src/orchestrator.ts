// The task orchestrator.
//
// It runs the steps a task can run right now, proves each one with a check,
// writes the result to disk after every step, and stops early when a step fails
// or a budget runs out. The distinction that matters: a step that executed is
// not a step that passed. Without a check a step ends "unverified", and a task
// cannot close as done while any acceptance criterion lacks evidence.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCheck, type CheckResult } from "./checks.js";
import { sh, truncate } from "./exec.js";
import { handlerFor } from "./registry.js";
import { readJson, removeFile, safeFileId, writeJsonAtomic } from "./store.js";
import {
  appendLog,
  fingerprintOf,
  loadTask,
  needsApproval,
  refreshStaleEvidence,
  runnableSteps,
  progressOf,
  saveTask,
  stepsNeedApproval,
  tasksDir,
  type Step,
  type Task,
} from "./tasks.js";

export interface RunOptions {
  maxSteps?: number;
  dryRun?: boolean;
  stopOnFailure?: boolean;
}

export interface StepOutcome {
  step: Step;
  executed: boolean;
  verified: boolean;
  detail: string;
}

export type StopReason = "complete" | "budget" | "failure" | "approval" | "nothing-runnable" | "time" | "locked";

export interface RunReport {
  task: Task;
  outcomes: StepOutcome[];
  stopped: StopReason;
  message: string;
}

interface LockFile {
  pid: number;
  host: string;
  startedAt: string;
  heartbeat: string;
  task: string;
}

const activeLocks = new Set<string>();

function lockFile(id: string): string {
  return path.join(tasksDir(), `${safeFileId(id, "task id")}.lock.json`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function createLockFile(file: string, value: LockFile): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/** One writer per task. Lock creation is exclusive, so two clients racing to
 * start the same task cannot both become the owner. A live local pid always
 * wins; heartbeat age is only used for locks from another host or a corrupt
 * lock left behind by a crashed writer. */
function acquireLock(task: Task): { ok: true } | { ok: false; reason: string } {
  const file = lockFile(task.id);
  const existing = readJson<LockFile>(file);
  if (existing) {
    const sameHost = existing.host === os.hostname();
    if (sameHost && existing.pid === process.pid && activeLocks.has(task.id)) {
      return { ok: false, reason: `already running in this server process since ${existing.startedAt}` };
    }
    if (existing.pid !== process.pid && sameHost && processAlive(existing.pid)) {
      return { ok: false, reason: `already running in pid ${existing.pid} since ${existing.startedAt}` };
    }
    const heartbeat = Date.parse(existing.heartbeat || existing.startedAt);
    if (!sameHost && Number.isFinite(heartbeat) && Date.now() - heartbeat < 120_000) {
      return { ok: false, reason: `already running on ${existing.host} since ${existing.startedAt}` };
    }
    removeFile(file);
  } else if (fs.existsSync(file)) {
    // A just-created exclusive lock may be between open() and its first write.
    // Never delete that window; only clean an unreadable lock after it is old.
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (age < 120_000) return { ok: false, reason: "lock exists and is still being initialized" };
    removeFile(file);
  }

  const stamp = new Date().toISOString();
  const mine: LockFile = { pid: process.pid, host: os.hostname(), startedAt: stamp, heartbeat: stamp, task: task.id };
  if (createLockFile(file, mine)) {
    activeLocks.add(task.id);
    return { ok: true };
  }

  const raced = readJson<LockFile>(file);
  return {
    ok: false,
    reason: raced?.pid
      ? `another runner acquired the lock first (pid ${raced.pid})`
      : "another runner acquired the lock first",
  };
}

function heartbeat(task: Task): void {
  const file = lockFile(task.id);
  const existing = readJson<LockFile>(file);
  if (!existing || existing.pid !== process.pid) return;
  writeJsonAtomic(file, { ...existing, heartbeat: new Date().toISOString() });
}

function releaseLock(task: Task): void {
  activeLocks.delete(task.id);
  const existing = readJson<LockFile>(lockFile(task.id));
  if (!existing || existing.pid === process.pid) removeFile(lockFile(task.id));
}

export function isRunning(taskId: string): boolean {
  const existing = readJson<LockFile>(lockFile(taskId));
  if (!existing) return false;
  if (existing.host !== os.hostname()) {
    const heartbeat = Date.parse(existing.heartbeat || existing.startedAt);
    return Number.isFinite(heartbeat) && Date.now() - heartbeat < 120_000;
  }
  if (existing.pid === process.pid) return activeLocks.has(taskId);
  return processAlive(existing.pid);
}

async function executeStep(step: Step): Promise<{ ok: boolean; detail: string }> {
  if (step.tool === "shell") {
    const cmd = typeof step.args?.cmd === "string" ? step.args.cmd : "";
    if (!cmd) return { ok: false, detail: "a shell step needs args.cmd" };
    const cwd = typeof step.args?.cwd === "string" ? step.args.cwd : undefined;
    const result = await sh(cmd, { cwd, timeoutMs: step.timeoutSeconds * 1000 });
    const output = `${result.out}\n${result.err}`.trim();
    return result.ok
      ? { ok: true, detail: output ? truncate(output, 1500) : "exit 0" }
      : { ok: false, detail: `exit ${result.code}: ${truncate(output, 1500)}` };
  }
  if (step.tool === "sleep") {
    const seconds = Math.max(0, Math.min(600, Number(step.args?.seconds ?? 1)));
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    return { ok: true, detail: `waited ${seconds}s` };
  }
  if (!step.tool) return { ok: false, detail: "the step has no tool or shell command" };
  const handler = handlerFor(step.tool);
  if (!handler) {
    return { ok: false, detail: `unknown tool ${step.tool}. Registered tools: see tools/list.` };
  }
  const result = await handler(step.args ?? {});
  return { ok: result.ok, detail: truncate(result.message, 1500) };
}

async function withTimeout(step: Step): Promise<{ ok: boolean; detail: string }> {
  const limit = Math.max(5, step.timeoutSeconds) * 1000;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ ok: boolean; detail: string }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, detail: `timed out after ${step.timeoutSeconds}s` }), limit);
  });
  try {
    return await Promise.race([executeStep(step), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runStep(task: Task, step: Step): Promise<StepOutcome> {
  step.status = "running";
  step.startedAt = new Date().toISOString();
  step.attempts += 1;
  saveTask(task);
  appendLog(task.id, { event: "step_start", step: step.id, tool: step.tool, args: step.args });

  let execution = await withTimeout(step);
  let check: CheckResult | null = execution.ok && step.verify ? await runCheck(step.verify, 2) : null;
  let replays = 0;

  while (replays < step.retries && (!execution.ok || (check !== null && !check.ok))) {
    replays += 1;
    if (step.replay) {
      execution = await withTimeout(step);
      check = execution.ok && step.verify ? await runCheck(step.verify, 2) : null;
    } else if (check !== null && !check.ok) {
      // Re-running is not always safe, so by default only the check is retried.
      check = await runCheck(step.verify as NonNullable<Step["verify"]>, 3);
    } else {
      break;
    }
  }

  step.endedAt = new Date().toISOString();
  step.evidence = truncate(
    [execution.detail, check ? `check: ${check.detail}` : ""].filter(Boolean).join(" || "),
    700,
  );
  step.status = !execution.ok ? "failed" : step.verify ? (check?.ok ? "done" : "failed") : "unverified";
  step.fingerprint = fingerprintOf(step);
  step.verifiedFingerprint = step.status === "done" ? step.fingerprint : undefined;
  saveTask(task);
  appendLog(task.id, {
    event: "step_end",
    step: step.id,
    status: step.status,
    attempts: replays + 1,
    evidence: step.evidence,
  });

  return {
    step,
    executed: execution.ok,
    verified: step.status === "done",
    detail: step.evidence,
  };
}

export async function runTask(id: string, options: RunOptions = {}): Promise<RunReport> {
  const task = loadTask(id);
  if (!task) throw new Error(`no task ${id}`);

  if (task.status === "done" || task.status === "failed") {
    return { task, outcomes: [], stopped: "complete", message: `${task.id} is already ${task.status}.` };
  }

  const lock = acquireLock(task);
  if (!lock.ok) {
    return { task, outcomes: [], stopped: "locked", message: `Not started: the task is ${lock.reason}.` };
  }

  const stale = refreshStaleEvidence(task);

  const outcomes: StepOutcome[] = [];
  const started = Date.now();
  const maxSteps = Math.max(1, Math.min(50, options.maxSteps ?? 5));
  let stopped: StopReason = "complete";
  const heartbeatTimer = setInterval(() => {
    try {
      heartbeat(task);
    } catch {
      // Losing a heartbeat must not interrupt the action currently running.
    }
  }, 30_000);
  heartbeatTimer.unref();

  try {
    for (;;) {
      if (outcomes.length >= maxSteps) {
        stopped = "budget";
        break;
      }
      if (Date.now() - started > task.budget.maxMinutes * 60_000) {
        stopped = "time";
        break;
      }
      const pending = stepsNeedApproval(task);
      if (pending.length && runnableSteps(task).length === 0) {
        stopped = "approval";
        break;
      }
      const next = runnableSteps(task)[0];
      if (!next) {
        stopped = outcomes.length ? "complete" : "nothing-runnable";
        break;
      }
      if (options.dryRun) {
        outcomes.push({ step: next, executed: false, verified: false, detail: "dry run, nothing executed" });
        stopped = "budget";
        break;
      }
      const outcome = await runStep(task, next);
      outcomes.push(outcome);
      heartbeat(task);
      if (outcome.step.status === "failed") {
        stopped = "failure";
        if (options.stopOnFailure !== false) break;
      }
    }
  } finally {
    clearInterval(heartbeatTimer);
    releaseLock(task);
  }

  const summary = summarizeRun(task, outcomes, stopped);
  return {
    task,
    outcomes,
    stopped,
    message: stale.length
      ? `Re-queued ${stale.join(", ")}: the definition changed after those steps were verified.\n${summary}`
      : summary,
  };
}

function summarizeRun(task: Task, outcomes: StepOutcome[], stopped: StopReason): string {
  const progress = progressOf(task);
  const lines: string[] = [];
  const headline: Record<StopReason, string> = {
    complete: "Every runnable step finished.",
    budget: "Step budget for this call is used up. Run again to continue.",
    failure: "Stopped on a failed step.",
    approval: "Paused: a step needs approval before it can run.",
    "nothing-runnable": "Nothing can run: dependencies, approvals or failures are in the way.",
    time: "Stopped at the task's time budget.",
    locked: "Not started: the task is already running elsewhere.",
  };
  lines.push(headline[stopped]);
  for (const outcome of outcomes) {
    const mark = outcome.verified ? "done" : outcome.executed ? "unverified" : "failed";
    lines.push(`  ${outcome.step.id} ${mark}: ${outcome.step.text}`);
    if (outcome.detail) lines.push(`    ${truncate(outcome.detail, 400)}`);
  }
  lines.push(
    `Progress: ${progress.done}/${progress.total} steps verified` +
      (progress.unverified ? `, ${progress.unverified} unverified` : "") +
      (progress.failed ? `, ${progress.failed} failed` : "") +
      (progress.pending ? `, ${progress.pending} pending` : "") +
      (progress.acceptanceTotal ? `, criteria ${progress.acceptanceMet}/${progress.acceptanceTotal}` : ""),
  );
  const waiting = stepsNeedApproval(task);
  if (waiting.length) lines.push(`Needs approval: ${waiting.map((step) => `${step.id} (${step.text})`).join(", ")}`);
  const next = runnableSteps(task)[0];
  if (next) lines.push(`Next: ${next.id} ${next.text}`);
  else if (stopped !== "complete") lines.push("Next: nothing is runnable; fix or unblock a step first.");
  lines.push(`Close with task_close once the acceptance criteria pass; it re-checks them and refuses to claim success without evidence.`);
  return lines.join("\n");
}
