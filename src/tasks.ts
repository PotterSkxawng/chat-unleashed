// Durable task plans.
//
// A task is one JSON file: explicit success criteria, steps with dependencies,
// a status per step, and the evidence that made it that status. Saving after
// every step is the checkpoint, so an interrupted conversation resumes from the
// last verified step instead of starting over.
import path from "node:path";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { appHome } from "./config.js";
import { describeCheck, runCheck, type CheckSpec } from "./checks.js";
import { appendJsonl, listJson, readJson, readJsonl, writeJsonAtomic, ensureDir } from "./store.js";

export type StepStatus = "pending" | "running" | "done" | "unverified" | "failed" | "skipped" | "blocked";
export type TaskStatus = "active" | "paused" | "blocked" | "done" | "failed";

export interface Step {
  id: string;
  text: string;
  /** Registered tool name, or the built-in "shell" and "sleep". */
  tool?: string;
  args?: Record<string, unknown>;
  verify?: CheckSpec;
  dependsOn: string[];
  /** How many times the verification is re-polled. The action itself only runs
   *  again when replay is true, because re-running is not always harmless. */
  retries: number;
  replay: boolean;
  timeoutSeconds: number;
  approval: boolean;
  approved: boolean;
  status: StepStatus;
  attempts: number;
  /** Hash of tool, args and verify: what the step actually asks for. */
  fingerprint?: string;
  /** The fingerprint at the moment the step was last proven. */
  verifiedFingerprint?: string;
  approvedAt?: string;
  note?: string;
  startedAt?: string;
  endedAt?: string;
  evidence?: string;
}

export interface Acceptance {
  id: string;
  text: string;
  check?: CheckSpec;
  met: boolean;
  evidence?: string;
  checkedAt?: string;
}

export interface Task {
  id: string;
  title: string;
  goal: string;
  status: TaskStatus;
  created: string;
  updated: string;
  closedAt?: string;
  closeReason?: string;
  acceptance: Acceptance[];
  steps: Step[];
  context: { apps: string[]; files: string[]; facts: Record<string, string> };
  budget: { maxSteps: number; maxMinutes: number };
}

export interface StepInput {
  text: string;
  tool?: string;
  args?: Record<string, unknown>;
  verify?: CheckSpec;
  dependsOn?: string[];
  retries?: number;
  replay?: boolean;
  timeoutSeconds?: number;
  approval?: boolean;
}

export interface AcceptanceInput {
  text: string;
  check?: CheckSpec;
}

export interface TaskInput {
  title: string;
  goal?: string;
  acceptance?: AcceptanceInput[];
  steps?: StepInput[];
  apps?: string[];
  files?: string[];
  /** Project root for scoped instructions, durable handoff and repo state. */
  root?: string;
  maxSteps?: number;
  maxMinutes?: number;
}

/** Commands that change things outside the project or cannot be undone. A step
 *  carrying one of these needs an explicit approval before it runs. */
const DESTRUCTIVE = [
  /\brm\b/i,
  /\bsudo\b/i,
  /git\s+push/i,
  /--force\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bkill(all)?\b/i,
  /diskutil/i,
  /\bmv\b.+\/(Library|System)\//i,
  /trash\b/i,
  /unlink/i,
];

export function tasksDir(): string {
  return path.join(appHome(), "tasks");
}

export function taskFile(id: string): string {
  return path.join(tasksDir(), `${id}.json`);
}

export function taskLogFile(id: string): string {
  return path.join(tasksDir(), `${id}.jsonl`);
}

function openTasksDir(): string {
  return path.join(tasksDir(), "open");
}

function openTaskMarker(id: string): string {
  return path.join(openTasksDir(), `${id}.json`);
}

function openMigrationMarker(): string {
  return path.join(openTasksDir(), ".migrated-v1");
}

function taskActivityFile(): string {
  return path.join(tasksDir(), "_activity.jsonl");
}

interface TaskActivity {
  id: string;
  updated: string;
  status: TaskStatus;
  title: string;
}

const activityLastWritten = new Map<string, number>();

function isOpenStatus(status: TaskStatus): boolean {
  return status !== "done" && status !== "failed";
}

function syncOpenMarker(task: Task): void {
  ensureDir(openTasksDir());
  if (isOpenStatus(task.status)) {
    // This is a rebuildable index, not authoritative task state. Avoid an
    // fsync+rename on every task heartbeat/save; the task JSON remains atomic.
    try {
      fs.writeFileSync(
        openTaskMarker(task.id),
        JSON.stringify({ id: task.id, updated: task.updated, status: task.status, title: task.title }),
        { mode: 0o600 },
      );
    } catch {
      /* exact task lookup still works even if the derived marker cannot write */
    }
  } else {
    try {
      fs.rmSync(openTaskMarker(task.id), { force: true });
    } catch {
      /* marker already absent */
    }
  }
}

function recordTaskActivity(task: Task, force = false): void {
  const nowMs = Date.now();
  const last = activityLastWritten.get(task.id) ?? 0;
  // A running step may save several times in a second. One activity record per
  // two seconds is enough to preserve recency without turning the index into a
  // write-amplification log. Terminal state is always recorded immediately.
  if (!force && isOpenStatus(task.status) && nowMs - last < 2_000) return;
  appendJsonl(taskActivityFile(), { id: task.id, updated: task.updated, status: task.status, title: task.title } satisfies TaskActivity);
  activityLastWritten.set(task.id, nowMs);
}

function ensureTaskIndexesMigrated(): void {
  ensureDir(openTasksDir());
  if (fs.existsSync(openMigrationMarker())) return;
  const tasks = listJson(tasksDir())
    .filter((file) => !file.endsWith(".lock.json"))
    .map((file) => readJson<Task>(file))
    .filter((task): task is Task => Boolean(task && task.id))
    .sort((a, b) => a.updated.localeCompare(b.updated));
  const activityLines: string[] = [];
  for (const task of tasks) {
    syncOpenMarker(task);
    activityLines.push(JSON.stringify({ id: task.id, updated: task.updated, status: task.status, title: task.title } satisfies TaskActivity));
    activityLastWritten.set(task.id, Date.parse(task.updated) || Date.now());
  }
  if (activityLines.length) {
    try {
      fs.appendFileSync(taskActivityFile(), `${activityLines.join("\n")}\n`, { mode: 0o600 });
    } catch {
      /* listing can still fall back to open markers and exact task ids */
    }
  }
  fs.writeFileSync(openMigrationMarker(), `${new Date().toISOString()}\n`, { mode: 0o600 });
}

function now(): string {
  return new Date().toISOString();
}

function stepId(index: number): string {
  return `s${index + 1}`;
}

export function isDestructive(step: Pick<Step, "tool" | "args" | "text">): boolean {
  const haystack = `${step.tool ?? ""} ${JSON.stringify(step.args ?? {})} ${step.text}`;
  return DESTRUCTIVE.some((pattern) => pattern.test(haystack));
}

export function fingerprintOf(step: Pick<Step, "tool" | "args" | "verify">): string {
  const payload = JSON.stringify({ tool: step.tool ?? null, args: step.args ?? null, verify: step.verify ?? null });
  return createHash("sha1").update(payload).digest("hex").slice(0, 12);
}

export function needsApproval(step: Step): boolean {
  return step.approval || isDestructive(step);
}

export function createTask(input: TaskInput): Task {
  if (!input.title?.trim()) throw new Error("a task needs a title");
  const stamp = now();
  const steps: Step[] = (input.steps ?? []).map((step, index) => ({
    id: stepId(index),
    text: step.text,
    tool: step.tool,
    args: step.args,
    verify: step.verify,
    dependsOn: step.dependsOn ?? (index > 0 ? [stepId(index - 1)] : []),
    retries: Math.max(0, Math.min(10, step.retries ?? 0)),
    replay: step.replay === true,
    timeoutSeconds: Math.max(5, Math.min(3600, step.timeoutSeconds ?? 300)),
    approval: step.approval === true,
    approved: false,
    status: "pending",
    attempts: 0,
    fingerprint: fingerprintOf(step),
  }));
  const task: Task = {
    id: `task_${randomUUID().replace(/-/g, "").slice(0, 10)}`,
    title: input.title.trim(),
    goal: (input.goal ?? "").trim(),
    status: "active",
    created: stamp,
    updated: stamp,
    acceptance: (input.acceptance ?? []).map((entry, index) => ({
      id: `a${index + 1}`,
      text: entry.text,
      check: entry.check,
      met: false,
    })),
    steps,
    context: { apps: input.apps ?? [], files: input.files ?? [], facts: input.root ? { root: input.root } : {} },
    budget: {
      maxSteps: Math.max(1, Math.min(10_000, input.maxSteps ?? 25)),
      maxMinutes: Math.max(1, Math.min(10_080, input.maxMinutes ?? 60)),
    },
  };
  saveTask(task);
  return task;
}

export function saveTask(task: Task): Task {
  ensureDir(tasksDir());
  task.updated = now();
  writeJsonAtomic(taskFile(task.id), task);
  syncOpenMarker(task);
  recordTaskActivity(task);
  return task;
}

export function loadTask(id: string): Task | null {
  return readJson<Task>(taskFile(id));
}

export function requireTask(id: string): Task {
  const task = loadTask(id);
  if (!task) throw new Error(`no task ${id}. task_list shows the ones that exist.`);
  return task;
}

export function listTasks(includeClosed = false, limit = 100): Task[] {
  ensureTaskIndexesMigrated();
  const wanted = Math.max(1, Math.min(limit, 1000));
  if (!includeClosed) {
    // Fast path: the activity tail is already newest-first information once
    // reversed, so listing recent open work does not need to parse every open
    // marker in a workspace with thousands of concurrent/dormant tasks.
    const recent = readJsonl<TaskActivity>(
      taskActivityFile(),
      Math.min(100_000, Math.max(2_000, wanted * 50)),
      16 * 1024 * 1024,
    );
    const seen = new Set<string>();
    const tasks: Task[] = [];
    for (let i = recent.length - 1; i >= 0 && tasks.length < wanted; i--) {
      const entry = recent[i];
      if (!entry?.id || seen.has(entry.id)) continue;
      seen.add(entry.id);
      const task = loadTask(entry.id);
      if (!task || !isOpenStatus(task.status)) continue;
      tasks.push(task);
    }
    if (tasks.length >= wanted) return tasks.sort((a, b) => b.updated.localeCompare(a.updated));

    // Rare fallback: activity history may have been manually truncated. Derived
    // open markers let us recover older open tasks without compromising exact
    // task-by-id state.
    const markers = listJson(openTasksDir())
      .map((file) => readJson<TaskActivity>(file))
      .filter((entry): entry is TaskActivity => Boolean(entry?.id))
      .sort((a, b) => b.updated.localeCompare(a.updated));
    for (const marker of markers) {
      if (tasks.length >= wanted || seen.has(marker.id)) continue;
      seen.add(marker.id);
      const task = loadTask(marker.id);
      if (!task || !isOpenStatus(task.status)) continue;
      tasks.push(task);
    }
    return tasks.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  // Bounded recent-history view: tail the compact activity log, dedupe newest
  // state per task, then load only the requested task records.
  const activity = readJsonl<TaskActivity>(taskActivityFile(), Math.min(100_000, Math.max(2_000, wanted * 50)), 16 * 1024 * 1024);
  const seen = new Set<string>();
  const tasks: Task[] = [];
  for (let i = activity.length - 1; i >= 0 && tasks.length < wanted; i--) {
    const entry = activity[i];
    if (!entry?.id || seen.has(entry.id)) continue;
    seen.add(entry.id);
    const task = loadTask(entry.id);
    if (task) tasks.push(task);
  }
  return tasks.sort((a, b) => b.updated.localeCompare(a.updated));
}

export interface Progress {
  total: number;
  done: number;
  unverified: number;
  failed: number;
  pending: number;
  blocked: number;
  acceptanceMet: number;
  acceptanceTotal: number;
  percent: number;
}

export function progressOf(task: Task): Progress {
  const count = (status: StepStatus) => task.steps.filter((step) => step.status === status).length;
  const total = task.steps.length;
  const done = count("done");
  return {
    total,
    done,
    unverified: count("unverified"),
    failed: count("failed"),
    pending: count("pending"),
    blocked: count("blocked"),
    acceptanceMet: task.acceptance.filter((entry) => entry.met).length,
    acceptanceTotal: task.acceptance.length,
    percent: total === 0 ? (task.acceptance.length && task.acceptance.every((a) => a.met) ? 100 : 0) : Math.round((done / total) * 100),
  };
}

export function stepById(task: Task, id: string): Step | undefined {
  return task.steps.find((step) => step.id === id);
}

export function dependenciesMet(task: Task, step: Step): boolean {
  return step.dependsOn.every((id) => {
    const dep = stepById(task, id);
    return dep ? dep.status === "done" || dep.status === "unverified" || dep.status === "skipped" : false;
  });
}

/** Why a step cannot start right now, or null when it can. */
export function blockReason(task: Task, step: Step): string | null {
  if (step.status === "done" || step.status === "skipped") return "already finished";
  const missing = step.dependsOn.filter((id) => {
    const dep = stepById(task, id);
    return !dep || (dep.status !== "done" && dep.status !== "unverified" && dep.status !== "skipped");
  });
  if (missing.length) return `waiting on ${missing.join(", ")}`;
  const failed = task.steps.find((other) => other.status === "failed" && other.dependsOn.includes(step.id));
  if (failed) return `${failed.id} failed and depends on this step`;
  if (needsApproval(step) && !step.approved) return "needs approval before it can run";
  return null;
}

/** Steps that can run now, in plan order. */
export function runnableSteps(task: Task): Step[] {
  return task.steps.filter((step) => blockReason(task, step) === null);
}

export function nextStep(task: Task): Step | null {
  return runnableSteps(task)[0] ?? null;
}

/** Steps that are waiting only for an approval. */
export function stepsNeedApproval(task: Task): Step[] {
  return task.steps.filter(
    (step) =>
      step.status !== "done" &&
      step.status !== "skipped" &&
      needsApproval(step) &&
      !step.approved,
  );
}

/** A step that was proven against one definition and has since been edited is
 *  not proven any more. This is what stops a resumed task from claiming credit
 *  for evidence that belongs to a different command. */
export function refreshStaleEvidence(task: Task): string[] {
  const stale: string[] = [];
  for (const step of task.steps) {
    const current = fingerprintOf(step);
    const proven = step.verifiedFingerprint;
    if (step.status === "done" && proven && proven !== current) {
      step.status = "pending";
      step.evidence = `re-check needed: the step changed after it was verified (${proven} -> ${current})`;
      step.verifiedFingerprint = undefined;
      stale.push(step.id);
    } else {
      step.fingerprint = current;
    }
  }
  if (stale.length) {
    saveTask(task);
    for (const id of stale) appendLog(task.id, { event: "stale", step: id });
  }
  return stale;
}

export function appendLog(taskId: string, entry: Record<string, unknown>): void {
  appendJsonl(taskLogFile(taskId), { at: now(), ...entry });
}

export function readLog(taskId: string, limit = 40): Array<Record<string, unknown>> {
  return readJsonl<Record<string, unknown>>(taskLogFile(taskId), limit);
}

/** Re-runs the acceptance criteria and records the evidence for each. */
export async function evaluateAcceptance(task: Task): Promise<Acceptance[]> {
  for (const entry of task.acceptance) {
    if (!entry.check) {
      entry.met = false;
      entry.evidence = "no check defined, so this criterion cannot be verified";
      entry.checkedAt = now();
      continue;
    }
    const result = await runCheck(entry.check);
    entry.met = result.ok;
    entry.evidence = result.ok ? result.detail : `failed: ${result.detail}`;
    entry.checkedAt = now();
    appendLog(task.id, {
      event: "acceptance",
      acceptance: entry.id,
      ok: result.ok,
      detail: result.detail,
      waitedMs: result.waitedMs,
    });
  }
  saveTask(task);
  return task.acceptance;
}

export function acceptanceBlockers(task: Task): string[] {
  return task.acceptance
    .filter((entry) => !entry.met)
    .map((entry) => `${entry.id} "${entry.text}"${entry.evidence ? ` (${entry.evidence})` : " not checked yet"}`);
}

export function summaryLine(task: Task): string {
  const progress = progressOf(task);
  const parts = [`${task.id}  ${task.status}  ${progress.done}/${progress.total} verified`];
  if (progress.unverified) parts.push(`${progress.unverified} unverified`);
  if (progress.failed) parts.push(`${progress.failed} failed`);
  if (progress.pending) parts.push(`${progress.pending} pending`);
  if (progress.blocked) parts.push(`${progress.blocked} blocked`);
  if (progress.acceptanceTotal) parts.push(`criteria ${progress.acceptanceMet}/${progress.acceptanceTotal}`);
  return `${parts.join("  ")}  ${task.title}`;
}

export function describeStep(step: Step): string {
  const bits = [`${step.id}  [${step.status}]  ${step.text}`];
  if (step.tool) bits.push(`tool=${step.tool}`);
  if (step.verify) bits.push(`verify: ${describeCheck(step.verify)}`);
  if (step.dependsOn.length) bits.push(`after ${step.dependsOn.join(",")}`);
  if (needsApproval(step)) bits.push(step.approved ? "approved" : "NEEDS APPROVAL");
  if (step.evidence) bits.push(`evidence: ${step.evidence.slice(0, 200)}`);
  if (step.note) bits.push(`note: ${step.note.slice(0, 160)}`);
  return bits.join("  ");
}
