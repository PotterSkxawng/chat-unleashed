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
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runCheck, type CheckResult, type CheckToolExecutor } from "./checks.js";
import { sh, truncate } from "./exec.js";
import { handlerFor, type ToolOutcome } from "./registry.js";
import {
  TASK_WORKER_PREFIX,
  type TaskWorkerRequest,
  type TaskWorkerResponse,
} from "./task-worker-protocol.js";
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

const STATEFUL_TASK_TOOLS = new Set(["shell_session", "js", "js_add_node_module_dir", "js_reset", "turn_ended"]);
const MAX_RETAINED_TASK_WORKERS = 8;

interface RetainedTaskWorker {
  worker: IsolatedToolWorker;
  lastUsed: number;
  active: number;
}

const retainedTaskWorkers = new Map<string, RetainedTaskWorker>();

interface PendingToolCall {
  resolve: (value: ToolOutcome) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class IsolatedToolWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, PendingToolCall>();
  private expectedExitPids = new Set<number>();
  private watchdogs = new Map<number, ReturnType<typeof spawn>>();

  private entry(): string {
    const override = process.env.CHAT_UNLEASHED_TASK_WORKER_ENTRY?.trim();
    if (override) return path.resolve(override);
    return fileURLToPath(import.meta.url);
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    const child = spawn(process.execPath, [this.entry(), "--task-worker"], {
      cwd: process.cwd(),
      env: { ...process.env, CHAT_UNLEASHED_TASK_WORKER: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.child = child;
    this.buffer = "";
    let stderrTail = "";

    const workerPid = child.pid;
    if (process.platform !== "win32" && workerPid) {
      const watchdog = spawn(
        "/bin/sh",
        ["-c", `cat >/dev/null; kill -KILL -${workerPid} 2>/dev/null || true`],
        { stdio: ["pipe", "ignore", "ignore"], detached: true },
      );
      watchdog.unref();
      (watchdog.stdin as (NodeJS.WritableStream & { unref?: () => void }) | null)?.unref?.();
      this.watchdogs.set(workerPid, watchdog);
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 16 * 1024 * 1024) {
        const error = new Error("task tool worker response exceeded 16 MiB");
        this.failAll(error);
        const pid = child.pid;
        if (pid) this.expectedExitPids.add(pid);
        if (this.child === child) this.child = null;
        if (pid) this.killPidGroup(pid, "SIGKILL");
        return;
      }
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (!line.startsWith(TASK_WORKER_PREFIX)) continue;
        let response: TaskWorkerResponse;
        try {
          response = JSON.parse(line.slice(TASK_WORKER_PREFIX.length)) as TaskWorkerResponse;
        } catch {
          continue;
        }
        const waiter = this.pending.get(response.id);
        if (!waiter) continue;
        this.pending.delete(response.id);
        clearTimeout(waiter.timer);
        if (response.error) waiter.reject(new Error(response.error));
        else if (response.result) waiter.resolve(response.result);
        else waiter.reject(new Error("task tool worker returned an empty response"));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-16_000);
    });
    child.stdin.on("error", (error) => {
      if (this.child === child) this.failAll(error);
    });
    child.on("error", (error) => {
      if (this.child === child) {
        this.child = null;
        this.failAll(error);
      }
    });
    child.on("exit", (code, signal) => {
      const pid = child.pid;
      const expected = pid ? this.expectedExitPids.delete(pid) : false;
      const wasCurrent = this.child === child;
      if (wasCurrent) this.child = null;
      if (pid && !expected) this.killPidGroup(pid, "SIGKILL");
      if (pid) this.stopWatchdog(pid);
      if (!expected && wasCurrent) {
        const detail = `task tool worker exited unexpectedly (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""})`;
        this.failAll(new Error(stderrTail ? `${detail}: ${stderrTail.slice(-1000)}` : detail));
      }
    });
    return child;
  }

  private failAll(error: Error): void {
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      this.pending.delete(id);
    }
  }

  private stopWatchdog(workerPid: number): void {
    const watchdog = this.watchdogs.get(workerPid);
    if (!watchdog) return;
    this.watchdogs.delete(workerPid);
    try { watchdog.kill("SIGKILL"); } catch { /* already gone */ }
  }

  private killPidGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      if (process.platform !== "win32") process.kill(-pid, signal);
      else if (this.child?.pid === pid) this.child.kill(signal);
    } catch {
      if (this.child?.pid !== pid) return;
      try {
        this.child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }

  async call(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<ToolOutcome> {
    const child = this.ensureStarted();
    const id = this.nextId++;
    const request: TaskWorkerRequest = { id, tool: name, args };
    return await new Promise<ToolOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`${name} exceeded its hard task deadline after ${Math.round(timeoutMs / 1000)}s`);
        this.pending.delete(id);
        reject(error);
        this.failAll(new Error(`task tool worker terminated after ${name} exceeded its hard deadline`));
        const workerPid = child.pid;
        if (workerPid) {
          this.expectedExitPids.add(workerPid);
          this.stopWatchdog(workerPid);
        }
        if (this.child === child) this.child = null;
        // This is a hard deadline, not normal shutdown. Kill the entire process
        // group immediately so a handler that ignores SIGTERM gets no grace
        // window in which it can keep mutating state.
        if (workerPid) this.killPidGroup(workerPid, "SIGKILL");
      }, Math.max(100, timeoutMs));
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify(request)}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  stop(): void {
    if (!this.child) return;
    this.failAll(new Error("task tool worker stopped"));
    const child = this.child;
    this.child = null;
    const workerPid = child.pid;
    if (workerPid) {
      this.expectedExitPids.add(workerPid);
      this.stopWatchdog(workerPid);
      this.killPidGroup(workerPid, "SIGKILL");
    }
  }

  forceStop(): void {
    this.failAll(new Error("task tool worker stopped"));
    const child = this.child;
    this.child = null;
    const workerPid = child?.pid;
    if (workerPid) {
      this.expectedExitPids.add(workerPid);
      this.stopWatchdog(workerPid);
      this.killPidGroup(workerPid, "SIGKILL");
    }
  }
}

export async function withIsolatedToolWorker<T>(
  body: (executeTool: CheckToolExecutor) => Promise<T>,
): Promise<T> {
  const worker = new IsolatedToolWorker();
  const executeTool: CheckToolExecutor = (name, args, timeoutMs) => worker.call(name, args, timeoutMs);
  try {
    return await body(executeTool);
  } finally {
    worker.stop();
  }
}

function evictOldestIdleRetainedWorker(exceptTaskId?: string): boolean {
  const oldest = [...retainedTaskWorkers.entries()]
    .filter(([taskId, retained]) => taskId !== exceptTaskId && retained.active === 0)
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
  if (!oldest) return false;
  oldest[1].worker.stop();
  retainedTaskWorkers.delete(oldest[0]);
  return true;
}

function trimRetainedWorkers(): void {
  while (retainedTaskWorkers.size > MAX_RETAINED_TASK_WORKERS) {
    if (!evictOldestIdleRetainedWorker()) break;
  }
}

function retainedWorkerFor(taskId: string): RetainedTaskWorker {
  const existing = retainedTaskWorkers.get(taskId);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing;
  }
  if (retainedTaskWorkers.size >= MAX_RETAINED_TASK_WORKERS) {
    evictOldestIdleRetainedWorker(taskId);
  }
  const retained: RetainedTaskWorker = { worker: new IsolatedToolWorker(), lastUsed: Date.now(), active: 0 };
  retainedTaskWorkers.set(taskId, retained);
  return retained;
}

export function stopTaskToolWorker(taskId: string): void {
  const retained = retainedTaskWorkers.get(taskId);
  if (!retained) return;
  retained.worker.stop();
  retainedTaskWorkers.delete(taskId);
}

export async function withTaskToolExecutor<T>(
  task: Task,
  body: (executeTool: CheckToolExecutor) => Promise<T>,
): Promise<T> {
  const isolated = new IsolatedToolWorker();
  let retained: RetainedTaskWorker | undefined;

  const executeTool: CheckToolExecutor = async (name, args, timeoutMs) => {
    if (!STATEFUL_TASK_TOOLS.has(name)) return await isolated.call(name, args, timeoutMs);

    if (!retained) {
      retained = retainedWorkerFor(task.id);
      retained.active += 1;
    }
    try {
      return await retained.worker.call(name, args, timeoutMs);
    } catch (error) {
      const failedRetained = retained;
      if (failedRetained && retainedTaskWorkers.get(task.id) === failedRetained) {
        failedRetained.worker.forceStop();
        retainedTaskWorkers.delete(task.id);
      }
      retained = undefined;
      throw error;
    }
  };

  try {
    return await body(executeTool);
  } finally {
    isolated.stop();
    if (retained && retainedTaskWorkers.get(task.id) === retained) {
      retained.active = Math.max(0, retained.active - 1);
      retained.lastUsed = Date.now();
    }
    trimRetainedWorkers();
  }
}

process.once("exit", () => {
  // Timers do not run once Node is exiting, so use an immediate group kill here.
  for (const { worker } of retainedTaskWorkers.values()) worker.forceStop();
  retainedTaskWorkers.clear();
});

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

async function executeStep(
  step: Step,
  executeTool: CheckToolExecutor,
): Promise<{ ok: boolean; detail: string }> {
  const limit = Math.max(5, step.timeoutSeconds) * 1000;
  if (step.tool === "shell") {
    const cmd = typeof step.args?.cmd === "string" ? step.args.cmd : "";
    if (!cmd) return { ok: false, detail: "a shell step needs args.cmd" };
    const cwd = typeof step.args?.cwd === "string" ? step.args.cwd : undefined;
    const result = await sh(cmd, { cwd, timeoutMs: limit });
    const output = `${result.out}\n${result.err}`.trim();
    return result.ok
      ? { ok: true, detail: output ? truncate(output, 1500) : "exit 0" }
      : {
          ok: false,
          detail: result.timedOut
            ? `timed out after ${step.timeoutSeconds}s`
            : `exit ${result.code}: ${truncate(output, 1500)}`,
        };
  }
  if (step.tool === "sleep") {
    const seconds = Math.max(0, Math.min(600, Number(step.args?.seconds ?? 1)));
    if (seconds * 1000 > limit) {
      await new Promise((resolve) => setTimeout(resolve, limit));
      return { ok: false, detail: `timed out after ${step.timeoutSeconds}s` };
    }
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    return { ok: true, detail: `waited ${seconds}s` };
  }
  if (!step.tool) return { ok: false, detail: "the step has no tool or shell command" };
  if (!handlerFor(step.tool)) {
    return { ok: false, detail: `unknown tool ${step.tool}. Registered tools: see tools/list.` };
  }
  try {
    const result = await executeTool(step.tool, step.args ?? {}, limit);
    return { ok: result.ok, detail: truncate(result.message, 1500) };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}

async function runStep(task: Task, step: Step, executeTool: CheckToolExecutor): Promise<StepOutcome> {
  step.status = "running";
  step.startedAt = new Date().toISOString();
  step.attempts += 1;
  saveTask(task);
  appendLog(task.id, { event: "step_start", step: step.id, tool: step.tool, args: step.args });

  let execution = await executeStep(step, executeTool);
  let check: CheckResult | null = execution.ok && step.verify ? await runCheck(step.verify, 2, executeTool) : null;
  let replays = 0;

  while (replays < step.retries && (!execution.ok || (check !== null && !check.ok))) {
    replays += 1;
    if (step.replay) {
      execution = await executeStep(step, executeTool);
      check = execution.ok && step.verify ? await runCheck(step.verify, 2, executeTool) : null;
    } else if (check !== null && !check.ok) {
      // Re-running is not always safe, so by default only the check is retried.
      check = await runCheck(step.verify as NonNullable<Step["verify"]>, 3, executeTool);
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
    return await withTaskToolExecutor(task, async (executeTool) => {
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
        const outcome = await runStep(task, next, executeTool);
        outcomes.push(outcome);
        heartbeat(task);
        if (outcome.step.status === "failed") {
          stopped = "failure";
          if (options.stopOnFailure !== false) break;
        }
      }

      if (outcomes.some((outcome) => outcome.step.status === "failed")) stopped = "failure";
      const summary = summarizeRun(task, outcomes, stopped);
      return {
        task,
        outcomes,
        stopped,
        message: stale.length
          ? `Re-queued ${stale.join(", ")}: the definition changed after those steps were verified.\n${summary}`
          : summary,
      };
    });
  } finally {
    clearInterval(heartbeatTimer);
    releaseLock(task);
  }
}

function summarizeRun(task: Task, outcomes: StepOutcome[], stopped: StopReason): string {
  const progress = progressOf(task);
  const lines: string[] = [];
  const headline: Record<StopReason, string> = {
    complete: "Every runnable step finished.",
    budget: "Step budget for this call is used up. Run again to continue.",
    failure: "One or more steps failed during this run.",
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
