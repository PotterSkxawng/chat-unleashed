// The skill registry.
//
// A skill is a workflow that was worth keeping: when to use it, the steps that did
// the work, the checks that proved it, and how it has actually performed. Routing
// uses the measured success rate, not just keywords, so a route that has failed
// before ranks below one that has worked. A skill compiles into a task, which means
// it inherits retries, checkpoints, approval gates and evidence from the
// orchestrator instead of reimplementing them.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appHome } from "./config.js";
import { loadTask } from "./tasks.js";
import type { CheckSpec } from "./checks.js";
import type { StepInput, TaskInput } from "./tasks.js";
import { writeJsonAtomic } from "./store.js";

export interface SkillStats {
  runs: number;
  passed: number;
  failed: number;
  totalMs: number;
  lastRunAt?: string;
  lastOutcome?: "passed" | "failed";
}

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  when: string[];
  apps?: string[];
  steps: StepInput[];
  acceptance?: Array<{ text: string; check?: CheckSpec }>;
  notes?: string;
  /** builtin skills ship with the tool; learned ones were saved by a run. */
  source?: "builtin" | "learned";
  createdAt: string;
  updatedAt: string;
  stats: SkillStats;
}

export function skillsDir(): string {
  return path.join(appHome(), "skills");
}

function skillFile(id: string): string {
  return path.join(skillsDir(), `${id}.json`);
}

interface CachedSkill {
  mtimeMs: number;
  size: number;
  skill: SkillRecord;
}

const skillCache = new Map<string, CachedSkill>();
const MAX_SKILL_BYTES = 8 * 1024 * 1024;
const SKILL_LIST_CACHE_MS = 2_000;
let skillListCache: SkillRecord[] | undefined;
let skillListCacheAt = 0;

function readSkillFile(file: string): SkillRecord | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) return undefined;
    const cached = skillCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.skill;
    const skill = JSON.parse(fs.readFileSync(file, "utf8")) as SkillRecord;
    if (!skill?.id || !skill?.name) return undefined;
    skillCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, skill });
    return skill;
  } catch {
    skillCache.delete(file);
    return undefined;
  }
}

function cacheSavedSkill(file: string, skill: SkillRecord): void {
  try {
    const stat = fs.statSync(file);
    skillCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, skill });
  } catch {
    skillCache.delete(file);
  }
  skillListCache = undefined;
  skillListCacheAt = 0;
}

function emptyStats(): SkillStats {
  return { runs: 0, passed: 0, failed: 0, totalMs: 0 };
}

/** Laplace smoothed so a brand new skill is not punished for having no history,
 *  and a skill that failed once does not read as perfect. */
export function successRate(stats: SkillStats): number {
  return (stats.passed + 1) / (stats.runs + 2);
}

export function normalizeSkill(input: Partial<SkillRecord> & { name: string }): SkillRecord {
  const now = new Date().toISOString();
  return {
    id: input.id ?? `skill_${randomUUID().slice(0, 8)}`,
    name: input.name.trim(),
    description: input.description?.trim() ?? "",
    when: (input.when ?? []).map((phrase) => phrase.trim().toLowerCase()).filter(Boolean),
    apps: input.apps,
    steps: input.steps ?? [],
    acceptance: input.acceptance,
    notes: input.notes,
    source: input.source ?? "learned",
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    stats: input.stats ?? emptyStats(),
  };
}

export function saveSkill(input: Partial<SkillRecord> & { name: string }): SkillRecord {
  const skill = normalizeSkill(input);
  const file = skillFile(skill.id);
  const encoded = JSON.stringify(skill);
  if (Buffer.byteLength(encoded) > MAX_SKILL_BYTES) throw new Error(`skill ${skill.name} exceeds the 8 MiB persisted-skill limit`);
  writeJsonAtomic(file, skill);
  cacheSavedSkill(file, skill);
  return skill;
}

export function loadSkill(idOrName: string): SkillRecord | undefined {
  const direct = path.join(skillsDir(), `${idOrName}.json`);
  if (fs.existsSync(direct)) return readSkillFile(direct);
  const wanted = idOrName.toLowerCase();
  return listSkills().find((skill) => skill.name.toLowerCase() === wanted);
}

export function listSkills(): SkillRecord[] {
  if (skillListCache && Date.now() - skillListCacheAt < SKILL_LIST_CACHE_MS) return [...skillListCache];
  let dir: fs.Dir;
  try {
    dir = fs.opendirSync(skillsDir());
  } catch {
    return [];
  }
  const out: SkillRecord[] = [];
  try {
    for (;;) {
      const entry = dir.readSync();
      if (!entry) break;
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const skill = readSkillFile(path.join(skillsDir(), entry.name));
      if (skill) out.push(skill);
    }
  } finally {
    try { dir.closeSync(); } catch { /* already closed */ }
  }
  out.sort((a, b) => successRate(b.stats) - successRate(a.stats) || a.name.localeCompare(b.name));
  skillListCache = out;
  skillListCacheAt = Date.now();
  return [...out];
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+.#]+/)
    .filter((token) => token.length > 2);
}

export interface SkillMatch {
  skill: SkillRecord;
  score: number;
  reasons: string[];
}

/** Route by what the skill says it is for, weighted by it having worked. A skill
 *  whose trigger phrases do not appear at all is not returned, however good its
 *  history is. */
export function matchSkills(text: string, skills: SkillRecord[], limit = 5): SkillMatch[] {
  const wanted = new Set(tokens(text));
  const matches: SkillMatch[] = [];
  for (const skill of skills) {
    const reasons: string[] = [];
    let score = 0;
    let phraseHits = 0;
    for (const phrase of skill.when) {
      const phraseTokens = tokens(phrase);
      if (!phraseTokens.length) continue;
      const hit = phraseTokens.every((token) => wanted.has(token));
      if (hit) {
        phraseHits += 1;
        score += 40 + phraseTokens.length * 4;
        reasons.push(`"${phrase}" appears in the request`);
      }
    }
    const nameTokens = tokens(skill.name).filter((token) => wanted.has(token));
    if (nameTokens.length) {
      score += nameTokens.length * 10;
      reasons.push(`name matches ${nameTokens.join(", ")}`);
    }
    if (!phraseHits && !nameTokens.length) continue;
    const rate = successRate(skill.stats);
    score += Math.round(rate * 20);
    reasons.push(`${skill.stats.passed}/${skill.stats.runs} runs passed`);
    if (skill.apps?.length) {
      const appHits = skill.apps.filter((app) => text.toLowerCase().includes(app.toLowerCase()));
      if (appHits.length) {
        score += appHits.length * 6;
        reasons.push(`works with ${appHits.join(", ")}`);
      }
    }
    matches.push({ skill, score, reasons });
  }
  return matches.sort((a, b) => b.score - a.score).slice(0, limit);
}

export type SkillVariables = Record<string, string | number | boolean>;

const VARIABLE = /\{\{([a-zA-Z0-9_.-]+)\}\}/g;

function collectVariables(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(VARIABLE)) out.add(match[1]);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectVariables(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectVariables(item, out);
  }
  return out;
}

export function skillVariables(skill: SkillRecord): string[] {
  return [...collectVariables({ steps: skill.steps, acceptance: skill.acceptance, apps: skill.apps })].sort();
}

function renderTemplate(value: unknown, variables: SkillVariables): unknown {
  if (typeof value === "string") {
    const exact = /^\{\{([a-zA-Z0-9_.-]+)\}\}$/.exec(value);
    if (exact && variables[exact[1]] !== undefined) return variables[exact[1]];
    return value.replace(VARIABLE, (_whole, name: string) =>
      variables[name] === undefined ? `{{${name}}}` : String(variables[name]),
    );
  }
  if (Array.isArray(value)) return value.map((item) => renderTemplate(item, variables));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, renderTemplate(item, variables)]),
    );
  }
  return value;
}

/** A skill becomes a task plan. Templates may contain {{variable}} placeholders.
 *  A compile with missing inputs fails loudly rather than creating a hollow task.
 *  The steps keep their checks, so a compiled skill still cannot mark work done
 *  without evidence. */
export function compileSkill(
  skill: SkillRecord,
  overrides: Partial<TaskInput> = {},
  variables: SkillVariables = {},
): TaskInput {
  const source: TaskInput = {
    title: overrides.title ?? skill.name,
    goal: overrides.goal ?? skill.description ?? skill.name,
    acceptance: overrides.acceptance ?? skill.acceptance,
    steps: overrides.steps ?? skill.steps,
    apps: overrides.apps ?? skill.apps,
    files: overrides.files,
    maxSteps: overrides.maxSteps,
    maxMinutes: overrides.maxMinutes,
  };
  const required = [...collectVariables(source)].sort();
  const missing = required.filter((name) => variables[name] === undefined);
  if (missing.length) {
    throw new Error(
      `${skill.name} needs variables before it can run: ${missing.join(", ")}. Pass them to skill action=compile in vars.`,
    );
  }
  // Preserve the original arrays for ordinary, non-templated skills. Besides
  // avoiding needless copying, this keeps compatibility with callers that use
  // object identity to tell whether compile introduced overrides.
  const rendered = required.length ? (renderTemplate(source, variables) as TaskInput) : source;
  if (skill.source === "builtin" && !rendered.steps?.length) {
    throw new Error(
      `${skill.name} is a builtin skill but has no executable steps. Builtins must be runnable workflows, not guidance-only cards.`,
    );
  }
  return rendered;
}

export function recordSkillRun(id: string, passed: boolean, durationMs: number): SkillRecord | undefined {
  const skill = loadSkill(id);
  if (!skill) return undefined;
  skill.stats.runs += 1;
  if (passed) skill.stats.passed += 1;
  else skill.stats.failed += 1;
  skill.stats.totalMs += durationMs;
  skill.stats.lastRunAt = new Date().toISOString();
  skill.stats.lastOutcome = passed ? "passed" : "failed";
  skill.updatedAt = skill.stats.lastRunAt;
  const file = skillFile(skill.id);
  writeJsonAtomic(file, skill);
  cacheSavedSkill(file, skill);
  return skill;
}

/** Learn from a finished task when the caller says which skill produced it. The
 *  task's own verdict is the measurement, not the caller's impression. */
export function recordTaskForSkill(skillId: string, taskId: string): SkillRecord | undefined {
  const task = loadTask(taskId);
  if (!task) return undefined;
  const started = task.created ? Date.parse(task.created) : Date.now();
  return recordSkillRun(skillId, task.status === "done", Math.max(0, Date.now() - started));
}

export function describeSkill(skill: SkillRecord): string {
  const rate = Math.round(successRate(skill.stats) * 100);
  const lines = [
    `${skill.id}  ${skill.name}  ${rate}% success over ${skill.stats.runs} run(s)`,
    skill.description ? `  ${skill.description}` : "",
    skill.when.length ? `  use when: ${skill.when.join(" | ")}` : "  use when: (no trigger phrases)",
    `  steps: ${skill.steps.length}${skill.acceptance?.length ? `, ${skill.acceptance.length} acceptance criteria` : ""}`,
  ];
  const variables = skillVariables(skill);
  if (variables.length) lines.push(`  variables: ${variables.join(", ")}`);
  if (skill.stats.lastRunAt) lines.push(`  last run: ${skill.stats.lastRunAt} ${skill.stats.lastOutcome ?? ""}`);
  return lines.filter(Boolean).join("\n");
}

// --- builtin skills --------------------------------------------------------

/** Skills that ship with the tool. They are guidance with trigger phrases, not
 *  recorded runs, so routing finds them and the notes say how to measure. A
 *  learned skill with the same name is never overwritten. */
const BUILTIN_SKILLS: Array<Partial<SkillRecord> & { name: string }> = [
  {
    name: "swift-package acceptance loop",
    description: "Make a Swift package build and test clean, with the compiler and test output as the verdict.",
    when: ["swift package", "swift build", "swift test", "swiftpm", "spm"],
    steps: [
      {
        text: "Inspect the Swift package before changing it",
        tool: "code_index",
        args: { action: "summary", root: "{{root}}" },
        verify: { kind: "tool", tool: "code_index", args: { action: "summary", root: "{{root}}" }, expect: "stack: swift" },
      },
      {
        text: "Run swift build and swift test as one acceptance iteration",
        tool: "code_loop",
        args: {
          action: "run",
          root: "{{root}}",
          goal: "Swift package acceptance",
          acceptance: [
            { name: "swift build", cmd: "swift build" },
            { name: "swift test", cmd: "swift test" },
          ],
        },
        verify: { kind: "shell", cwd: "{{root}}", cmd: "swift build && swift test" },
      },
    ],
    acceptance: [
      { text: "The package builds and all Swift tests pass", check: { kind: "shell", cwd: "{{root}}", cmd: "swift build && swift test" } },
    ],
    notes:
      "Pass vars.root as the package root. The code_loop iteration preserves the compiler/test failure output; the task only closes when the same build-and-test check passes.",
    source: "builtin",
  },
  {
    name: "metal kernel benchmark",
    description: "Measure a Metal kernel separately from the app that calls it and keep a comparable regression history.",
    when: ["metal", "kernel", "shader", "gpu", "mtlcompute"],
    steps: [
      {
        text: "Refuse to benchmark while the Apple silicon machine is under noisy memory or load pressure",
        tool: "code_loop",
        args: { action: "resources" },
        verify: { kind: "tool", tool: "code_loop", args: { action: "resources" }, expect: "Load|free|swap" },
      },
      {
        text: "Run the kernel benchmark command, extract its numeric metric and record the sample",
        tool: "bench",
        args: {
          action: "measure",
          root: "{{root}}",
          cmd: "{{bench_cmd}}",
          pattern: "{{pattern}}",
          name: "{{benchmark_name}}",
          channel: "kernel",
          metric: "{{metric}}",
          unit: "{{unit}}",
          device: "{{device}}",
        },
        verify: { kind: "tool", tool: "bench", args: { action: "list" }, expect: "{{benchmark_name}}" },
      },
      {
        text: "Compare the new kernel sample with the previous like-for-like sample",
        tool: "bench",
        args: { action: "compare", name: "{{benchmark_name}}", tolerancePct: 5 },
        verify: { kind: "tool", tool: "bench", args: { action: "compare", name: "{{benchmark_name}}", tolerancePct: 5 } },
      },
    ],
    acceptance: [
      { text: "The benchmark sample is recorded and shows no >5% kernel regression", check: { kind: "tool", tool: "bench", args: { action: "compare", name: "{{benchmark_name}}", tolerancePct: 5 } } },
    ],
    notes:
      "pattern must contain a numeric capture group, for example '([0-9.]+) ms/token'. Pass root, bench_cmd, benchmark_name, metric, unit and device. Kernel, end-to-end and memory measurements remain separate channels.",
    source: "builtin",
  },
  {
    name: "mlx model benchmark",
    description: "Measure whole-model MLX inference separately from kernels and memory, with recorded comparable samples.",
    when: ["mlx", "model", "inference", "tokens per second", "quantized"],
    steps: [
      {
        text: "Check resource pressure before measuring the MLX model",
        tool: "code_loop",
        args: { action: "resources" },
        verify: { kind: "tool", tool: "code_loop", args: { action: "resources" }, expect: "Load|free|swap" },
      },
      {
        text: "Run the MLX benchmark command, extract its model metric and record the sample",
        tool: "bench",
        args: {
          action: "measure",
          root: "{{root}}",
          cmd: "{{bench_cmd}}",
          pattern: "{{pattern}}",
          name: "{{benchmark_name}}",
          channel: "model",
          metric: "{{metric}}",
          unit: "{{unit}}",
          device: "{{device}}",
        },
        verify: { kind: "tool", tool: "bench", args: { action: "list" }, expect: "{{benchmark_name}}" },
      },
      {
        text: "Compare the model result only with prior samples in the same channel/metric/device",
        tool: "bench",
        args: { action: "compare", name: "{{benchmark_name}}", tolerancePct: 5 },
        verify: { kind: "tool", tool: "bench", args: { action: "compare", name: "{{benchmark_name}}", tolerancePct: 5 } },
      },
    ],
    acceptance: [
      { text: "The MLX model sample is recorded and has no >5% regression", check: { kind: "tool", tool: "bench", args: { action: "compare", name: "{{benchmark_name}}", tolerancePct: 5 } } },
    ],
    notes:
      "pattern must capture the numeric model result, such as '([0-9.]+) tok/s'. Pass root, bench_cmd, benchmark_name, metric, unit and device. Use a separate skill/sample name for kernel or memory measurements.",
    source: "builtin",
  },
  {
    name: "apple silicon measurement discipline",
    description: "Gate performance work on machine state and collect a profile before optimizing a hot process.",
    when: ["apple silicon", "m-series", "m1", "m2", "m3", "m4", "m5", "m6", "thermal", "benchmark", "regression", "profiling"],
    steps: [
      {
        text: "Check load, free memory and swap before trusting a performance result",
        tool: "code_loop",
        args: { action: "resources" },
        verify: { kind: "tool", tool: "code_loop", args: { action: "resources" }, expect: "Load|free|swap" },
      },
      {
        text: "Profile the target process so optimization follows measured hot frames",
        tool: "code_loop",
        args: { action: "profile", target: "{{profile_target}}", seconds: 3, top: 20 },
        verify: { kind: "tool", tool: "code_loop", args: { action: "profile", target: "{{profile_target}}", seconds: 1, top: 10 }, expect: "frames by sample count|Call graph" },
      },
    ],
    acceptance: [
      { text: "The machine is in a usable measurement state", check: { kind: "tool", tool: "code_loop", args: { action: "resources" }, expect: "Load|free|swap" } },
    ],
    notes:
      "Pass vars.profile_target as a pid or process name. If the resource gate fails, fix load/swap pressure first instead of recording a noisy benchmark.",
    source: "builtin",
  },
];

function sameBuiltinDefinition(skill: SkillRecord, seed: Partial<SkillRecord> & { name: string }): boolean {
  const left = {
    name: skill.name,
    description: skill.description,
    when: skill.when,
    apps: skill.apps,
    steps: skill.steps,
    acceptance: skill.acceptance,
    notes: skill.notes,
    source: skill.source,
  };
  const right = {
    name: seed.name.trim(),
    description: seed.description?.trim() ?? "",
    when: (seed.when ?? []).map((phrase) => phrase.trim().toLowerCase()).filter(Boolean),
    apps: seed.apps,
    steps: seed.steps ?? [],
    acceptance: seed.acceptance,
    notes: seed.notes,
    source: "builtin",
  };
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Write missing builtin skills and refresh copies that are still owned by the
 *  builtin registry. Learned/user-authored skills with the same name are never
 *  overwritten. A builtin upgrade preserves its id, creation time and measured
 *  run statistics so better workflow definitions do not erase evidence. */
export function seedBuiltinSkills(): { created: string[]; updated: string[]; existing: string[] } {
  const current = listSkills();
  const created: string[] = [];
  const updated: string[] = [];
  const existing: string[] = [];
  for (const seed of BUILTIN_SKILLS) {
    const match = current.find((skill) => skill.name.toLowerCase() === seed.name.toLowerCase());
    if (match) {
      if (match.source === "builtin" && !sameBuiltinDefinition(match, seed)) {
        const saved = saveSkill({
          ...seed,
          id: match.id,
          createdAt: match.createdAt,
          stats: match.stats,
          source: "builtin",
        });
        updated.push(saved.name);
      } else {
        existing.push(match.name);
      }
      continue;
    }
    const saved = saveSkill(seed);
    created.push(saved.name);
  }
  return { created, updated, existing };
}

export function builtinSkillNames(): string[] {
  return BUILTIN_SKILLS.map((seed) => seed.name);
}
