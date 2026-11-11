import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { appHome, resolveUserPath } from "./config.js";
import { failed, good, run, sh, truncate, type Outcome } from "./exec.js";
import { loadTask, progressOf, readLog, summaryLine } from "./tasks.js";

export interface InstructionFile {
  file: string;
  scope: string;
  content: string;
}

export interface ProjectContextOptions {
  root: string;
  action: "instructions" | "snapshot" | "write" | "read" | "resume" | "clear";
  focus?: string;
  taskId?: string;
  summary?: string;
  decisions?: string[];
  next?: string[];
  risks?: string[];
  checks?: string[];
  maxChars?: number;
}

interface ProjectMemory {
  root: string;
  updatedAt: string;
  summary?: string;
  decisions: string[];
  next: string[];
  risks: string[];
  checks: string[];
  taskId?: string;
}

export interface ProjectReviewOptions {
  root: string;
  mode?: "quick" | "full";
  paths?: string[];
  commands?: string[];
  timeoutSeconds?: number;
  maxIssues?: number;
  includeDiff?: boolean;
  diffChars?: number;
}

function normRoot(value: string): string {
  return path.resolve(resolveUserPath(value));
}

async function repoRoot(value: string): Promise<{ root: string; git: boolean }> {
  const candidate = normRoot(value);
  const r = await run("/usr/bin/git", ["-C", candidate, "rev-parse", "--show-toplevel"], { timeoutMs: 8_000 });
  const root = r.ok && r.out.trim() ? path.resolve(r.out.trim()) : candidate;
  return { root, git: r.ok };
}

function inside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function readText(file: string, cap = 40_000): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    return fs.readFileSync(file, "utf8").slice(0, cap);
  } catch {
    return null;
  }
}

function preferredInstructions(dir: string): string | null {
  const override = path.join(dir, "AGENTS.override.md");
  if (fs.existsSync(override)) return override;
  const normal = path.join(dir, "AGENTS.md");
  return fs.existsSync(normal) ? normal : null;
}

/** Codex-compatible instruction discovery: global CODEX_HOME instructions, then
 * repo-root-to-leaf AGENTS.md / AGENTS.override.md. */
export async function discoverProjectInstructions(rootInput: string, focusInput?: string): Promise<{ root: string; files: InstructionFile[] }> {
  const { root } = await repoRoot(rootInput);
  const focusRaw = focusInput
    ? (focusInput.startsWith("~") ? resolveUserPath(focusInput) : focusInput)
    : root;
  const focus = path.isAbsolute(focusRaw) ? path.resolve(focusRaw) : path.resolve(root, focusRaw);
  const focusDir = fs.existsSync(focus) && fs.statSync(focus).isDirectory() ? focus : path.dirname(focus);
  if (!inside(root, focusDir)) throw new Error(`focus ${focusDir} is outside project root ${root}`);

  const files: InstructionFile[] = [];
  const codexHome = process.env.CODEX_HOME ? resolveUserPath(process.env.CODEX_HOME) : path.join(os.homedir(), ".codex");
  const globalFile = preferredInstructions(codexHome);
  if (globalFile) {
    const content = readText(globalFile);
    if (content !== null) files.push({ file: globalFile, scope: "global", content });
  }

  const chain: string[] = [];
  let cursor = focusDir;
  while (inside(root, cursor)) {
    chain.push(cursor);
    if (cursor === root) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  chain.reverse();
  for (const dir of chain) {
    const file = preferredInstructions(dir);
    if (!file) continue;
    const content = readText(file);
    if (content === null) continue;
    files.push({ file, scope: path.relative(root, dir) || ".", content });
  }
  return { root, files };
}

function memoryKey(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

function memoryFile(root: string): string {
  return path.join(appHome(), "project-state", `${memoryKey(root)}.json`);
}

function readMemory(root: string): ProjectMemory | null {
  try {
    return JSON.parse(fs.readFileSync(memoryFile(root), "utf8")) as ProjectMemory;
  } catch {
    return null;
  }
}

function saveMemory(memory: ProjectMemory): void {
  const file = memoryFile(memory.root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(memory, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

async function gitText(root: string, args: string[], maxBytes = 80_000, preserveLeading = false): Promise<string> {
  const r = await run("/usr/bin/git", ["-C", root, ...args], { timeoutMs: 15_000, maxBytes });
  if (!r.ok) return "";
  return preserveLeading ? r.out.trimEnd() : r.out.trim();
}

function packageChecks(root: string): string[] {
  const packageFile = path.join(root, "package.json");
  try {
    const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8")) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const out: string[] = [];
    if (scripts.typecheck) out.push("npm run typecheck");
    else if (fs.existsSync(path.join(root, "tsconfig.json"))) out.push("npx tsc -p tsconfig.json --noEmit");
    if (scripts.lint) out.push("npm run lint");
    if (scripts.test) out.push("npm test");
    if (scripts.build) out.push("npm run build");
    return [...new Set(out)];
  } catch {
    if (fs.existsSync(path.join(root, "Package.swift"))) return ["swift build", "swift test"];
    return [];
  }
}

async function liveSnapshot(root: string, taskId?: string): Promise<string[]> {
  const { git } = await repoRoot(root);
  const lines: string[] = [];
  if (git) {
    const branch = await gitText(root, ["branch", "--show-current"]);
    const status = await gitText(root, ["status", "--short", "--branch"]);
    const stat = await gitText(root, ["diff", "--stat"]);
    const staged = await gitText(root, ["diff", "--cached", "--stat"]);
    lines.push(`branch: ${branch || "(detached)"}`);
    lines.push("git status:");
    lines.push(status || "  clean");
    if (stat) lines.push("working diff:", stat);
    if (staged) lines.push("staged diff:", staged);
  } else {
    lines.push("git: not a repository");
  }
  const suggested = packageChecks(root);
  if (suggested.length) lines.push("suggested checks:", ...suggested.map((x) => `  ${x}`));
  if (taskId) {
    const task = loadTask(taskId);
    if (task) {
      const p = progressOf(task);
      lines.push("task:", `  ${summaryLine(task)}`, `  progress ${p.percent}%`);
      const recent = readLog(task.id, 8);
      if (recent.length) {
        lines.push("  recent events:");
        for (const e of recent.slice(-8)) lines.push(`    ${JSON.stringify(e).slice(0, 500)}`);
      }
    } else {
      lines.push(`task: ${taskId} not found`);
    }
  }
  return lines;
}

function memoryLines(memory: ProjectMemory | null): string[] {
  if (!memory) return ["saved project state: none"];
  const lines = [`saved project state: ${memory.updatedAt}`];
  if (memory.summary) lines.push("summary:", memory.summary);
  if (memory.decisions.length) lines.push("decisions:", ...memory.decisions.map((x) => `  - ${x}`));
  if (memory.next.length) lines.push("next:", ...memory.next.map((x) => `  - ${x}`));
  if (memory.risks.length) lines.push("risks:", ...memory.risks.map((x) => `  - ${x}`));
  if (memory.checks.length) lines.push("known checks:", ...memory.checks.map((x) => `  - ${x}`));
  if (memory.taskId) lines.push(`task id: ${memory.taskId}`);
  return lines;
}

export async function projectContext(opts: ProjectContextOptions): Promise<Outcome> {
  const { root } = await repoRoot(opts.root);
  const maxChars = Math.max(2_000, Math.min(100_000, opts.maxChars ?? 40_000));
  if (opts.action === "clear") {
    fs.rmSync(memoryFile(root), { force: true });
    return good(`Cleared saved project state for ${root}.`);
  }
  if (opts.action === "write") {
    const prior = readMemory(root);
    const memory: ProjectMemory = {
      root,
      updatedAt: new Date().toISOString(),
      summary: opts.summary ?? prior?.summary,
      decisions: opts.decisions ?? prior?.decisions ?? [],
      next: opts.next ?? prior?.next ?? [],
      risks: opts.risks ?? prior?.risks ?? [],
      checks: opts.checks ?? prior?.checks ?? [],
      taskId: opts.taskId ?? prior?.taskId,
    };
    saveMemory(memory);
    return good(memoryLines(memory).join("\n"));
  }
  if (opts.action === "read") return good(memoryLines(readMemory(root)).join("\n"));

  const instructions = await discoverProjectInstructions(root, opts.focus);
  if (opts.action === "instructions") {
    if (!instructions.files.length) return good(`No AGENTS.md instructions found for ${root}.`);
    const lines = [`instruction chain for ${root}:`];
    for (const file of instructions.files) {
      lines.push("", `--- ${file.scope} :: ${file.file} ---`, file.content);
    }
    return good(truncate(lines.join("\n"), maxChars));
  }

  const lines: string[] = [`project context: ${root}`];
  const memory = readMemory(root);
  if (opts.action === "resume") lines.push(...memoryLines(memory), "");
  if (instructions.files.length) {
    if (opts.action === "resume") {
      lines.push("scoped instructions:");
      for (const file of instructions.files) {
        lines.push("", `--- ${file.scope} :: ${file.file} ---`, file.content);
      }
    } else {
      lines.push("instruction files:");
      for (const file of instructions.files) lines.push(`  ${file.scope}: ${file.file}`);
    }
  } else {
    lines.push("instruction files: none");
  }
  lines.push("", ...(await liveSnapshot(root, opts.taskId ?? memory?.taskId)));
  return good(truncate(lines.join("\n"), maxChars));
}

function changedFilesFromStatus(root: string, status: string): string[] {
  const files: string[] = [];
  for (const line of status.split("\n")) {
    if (line.length < 4) continue;
    let name = line.slice(3).trim();
    const arrow = name.indexOf(" -> ");
    if (arrow >= 0) name = name.slice(arrow + 4);
    if (name && inside(root, path.resolve(root, name))) files.push(path.resolve(root, name));
  }
  return [...new Set(files)];
}

function looksBinary(file: string): boolean {
  try {
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(4096);
    const n = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    return buffer.subarray(0, n).includes(0);
  } catch {
    return false;
  }
}

function hasUnfinishedMarker(line: string): boolean {
  const marker = /\b(?:TODO|FIXME|HACK)\b/;
  const trimmed = line.trimStart();
  if (/^(?:TODO|FIXME|HACK)\b/.test(trimmed)) return true;
  if (/^(?:\/\/|\/\*|\*|#|<!--)/.test(trimmed)) return marker.test(trimmed);

  let quote: string | null = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '/' && (next === '/' || next === '*')) return marker.test(line.slice(i + 2));
    if (char === '#' && (i === 0 || /\s/.test(line[i - 1]))) return marker.test(line.slice(i + 1));
  }
  return false;
}

function scanFile(file: string, root: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { errors, warnings };
    const rel = path.relative(root, file);
    if (st.size > 5 * 1024 * 1024) warnings.push(`${rel}: large changed file (${Math.round(st.size / 1024 / 1024)} MiB)`);
    if (looksBinary(file)) return { errors, warnings };
    // git diff --check remains the authoritative conflict/whitespace gate.
    // Avoid loading giant generated/text artifacts into the MCP process just
    // for heuristic unfinished-marker and secret scanning.
    if (st.size > 8 * 1024 * 1024) {
      warnings.push(`${rel}: heuristic content scan skipped above 8 MiB; rely on diff/check-specific tooling`);
      return { errors, warnings };
    }
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (/^(<<<<<<<|=======|>>>>>>>)(\s|$)/.test(line)) errors.push(`${rel}:${i + 1}: unresolved merge-conflict marker`);
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(line)) errors.push(`${rel}:${i + 1}: private key material`);
      if (/\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["\x27][^"\x27]{12,}["\x27]/i.test(line) && !/example|dummy|test|placeholder/i.test(line)) {
        warnings.push(`${rel}:${i + 1}: possible hard-coded credential`);
      }
      if (hasUnfinishedMarker(line)) warnings.push(`${rel}:${i + 1}: ${line.trim().slice(0, 140)}`);
    });
  } catch {
    /* file may have been deleted */
  }
  return { errors, warnings };
}

export async function projectReview(opts: ProjectReviewOptions): Promise<Outcome> {
  const { root, git } = await repoRoot(opts.root);
  const maxIssues = Math.max(5, Math.min(200, opts.maxIssues ?? 60));
  const errors: string[] = [];
  const warnings: string[] = [];
  let files: string[] = [];
  let diffBundle = "";

  if (opts.paths?.length) {
    files = opts.paths.map((p) => path.resolve(root, p)).filter((p) => inside(root, p));
  } else if (git) {
    const status = await gitText(root, ["status", "--porcelain=v1", "-uall"], 200_000, true);
    files = changedFilesFromStatus(root, status);
    const diffCheck = await run("/usr/bin/git", ["-C", root, "diff", "--check"], { timeoutMs: 15_000 });
    if (!diffCheck.ok || diffCheck.out.trim()) errors.push(`git diff --check:\n${(diffCheck.out || diffCheck.err).trim()}`);
    const stagedCheck = await run("/usr/bin/git", ["-C", root, "diff", "--cached", "--check"], { timeoutMs: 15_000 });
    if (!stagedCheck.ok || stagedCheck.out.trim()) errors.push(`git diff --cached --check:\n${(stagedCheck.out || stagedCheck.err).trim()}`);
    if (opts.includeDiff) {
      const cap = Math.max(2_000, Math.min(80_000, opts.diffChars ?? 20_000));
      const working = await gitText(root, ["diff", "--no-ext-diff", "--unified=3"], cap);
      const staged = await gitText(root, ["diff", "--cached", "--no-ext-diff", "--unified=3"], cap);
      const pieces: string[] = [];
      if (staged) pieces.push("### staged diff", staged);
      if (working) pieces.push("### working diff", working);
      diffBundle = truncate(pieces.join("\n"), cap);
    }

  } else {
    warnings.push("not a git repository; pass paths to scan specific files");
  }

  for (const file of files) {
    const scan = scanFile(file, root);
    errors.push(...scan.errors);
    warnings.push(...scan.warnings);
    if (errors.length + warnings.length >= maxIssues) break;
  }

  const commands = opts.commands?.length ? opts.commands : opts.mode === "full" ? packageChecks(root) : [];
  const commandResults: string[] = [];
  for (const command of commands) {
    const result = await sh(command, { cwd: root, timeoutMs: Math.max(5, Math.min(3600, opts.timeoutSeconds ?? 300)) * 1000, maxBytes: 120_000 });
    const tail = truncate(`${result.out}${result.err ? `\n${result.err}` : ""}`.trim(), 4_000);
    commandResults.push(`${result.ok ? "PASS" : "FAIL"} ${command}${tail ? `\n${tail}` : ""}`);
    if (!result.ok) errors.push(`check failed: ${command}${result.timedOut ? " (timed out)" : ""}`);
  }

  const verdict = errors.length ? "FAIL" : warnings.length ? "WARN" : "PASS";
  const lines = [
    `${verdict}: project review for ${root}`,
    `changed files scanned: ${files.length}`,
    `errors: ${errors.length}   warnings: ${warnings.length}`,
  ];
  if (errors.length) lines.push("", "errors:", ...errors.slice(0, maxIssues).map((x) => `  - ${x}`));
  if (warnings.length) lines.push("", "warnings:", ...warnings.slice(0, maxIssues).map((x) => `  - ${x}`));
  if (commandResults.length) lines.push("", "checks:", ...commandResults);
  if (!commands.length) {
    const suggested = packageChecks(root);
    if (suggested.length) lines.push("", "suggested full-review checks:", ...suggested.map((x) => `  ${x}`));
  }
  if (opts.includeDiff) lines.push("", "diff for semantic review:", diffBundle || "(no staged or working-tree diff)");
  return errors.length ? failed(lines.join("\n")) : good(lines.join("\n"));

}
