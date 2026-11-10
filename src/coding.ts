// Coding workflows around the shell.
//
// The shell can already compile and test. What it cannot do by itself is remember
// what a symbol is, keep work on a branch isolated, prove a performance claim, or
// notice that the machine is too hot to run a benchmark honestly. This module adds
// those, and the goal loop that reruns acceptance commands until they pass or the
// budget or the resources run out.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { appHome, resolveUserPath } from "./config.js";
import { run, sh, truncate } from "./exec.js";

export interface SymbolHit {
  name: string;
  kind: string;
  file: string;
  line: number;
  signature: string;
}

const EXT_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".swift": "swift",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".m": "objc",
  ".mm": "objc",
  ".metal": "metal",
  ".java": "java",
  ".kt": "kotlin",
  ".rb": "ruby",
};

export function languageOf(file: string): string | undefined {
  return EXT_LANG[path.extname(file).toLowerCase()];
}

const PATTERNS: Record<string, Array<{ kind: string; re: RegExp }>> = {
  typescript: [
    { kind: "function", re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
    { kind: "class", re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: "interface", re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
    { kind: "type", re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/ },
    { kind: "enum", re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
    { kind: "const", re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*[:=]/ },
  ],
  swift: [
    { kind: "func", re: /^\s*(?:@\w+\s+)*(?:public\s+|private\s+|internal\s+|fileprivate\s+|open\s+|static\s+|class\s+)*func\s+([A-Za-z_]\w*)/ },
    { kind: "struct", re: /^\s*(?:@\w+\s+)*(?:public\s+|private\s+|internal\s+)*struct\s+([A-Za-z_]\w*)/ },
    { kind: "class", re: /^\s*(?:@\w+\s+)*(?:public\s+|private\s+|internal\s+|final\s+)*class\s+([A-Za-z_]\w*)/ },
    { kind: "enum", re: /^\s*(?:@\w+\s+)*(?:public\s+|private\s+|internal\s+)*enum\s+([A-Za-z_]\w*)/ },
    { kind: "protocol", re: /^\s*(?:public\s+|private\s+|internal\s+)*protocol\s+([A-Za-z_]\w*)/ },
    { kind: "extension", re: /^\s*(?:public\s+|private\s+|internal\s+)*extension\s+([A-Za-z_][\w.]*)/ },
  ],
  python: [
    { kind: "function", re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
    { kind: "class", re: /^\s*class\s+([A-Za-z_]\w*)/ },
  ],
  rust: [
    { kind: "fn", re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/ },
    { kind: "struct", re: /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/ },
    { kind: "enum", re: /^\s*(?:pub\s+)?enum\s+([A-Za-z_]\w*)/ },
    { kind: "trait", re: /^\s*(?:pub\s+)?trait\s+([A-Za-z_]\w*)/ },
    { kind: "impl", re: /^\s*impl(?:<[^>]*>)?\s+([A-Za-z_][\w<>, ]*)/ },
  ],
  go: [
    { kind: "func", re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/ },
    { kind: "type", re: /^type\s+([A-Za-z_]\w*)/ },
  ],
  java: [
    { kind: "class", re: /^\s*(?:public\s+|private\s+|protected\s+)?(?:final\s+|abstract\s+)?class\s+([A-Za-z_]\w*)/ },
    { kind: "interface", re: /^\s*(?:public\s+)?interface\s+([A-Za-z_]\w*)/ },
    { kind: "method", re: /^\s*(?:public|private|protected)\s+[\w<>\[\]]+\s+([A-Za-z_]\w*)\s*\(/ },
  ],
  metal: [
    { kind: "kernel", re: /^\s*kernel\s+void\s+([A-Za-z_]\w*)/ },
    { kind: "function", re: /^\s*(?:inline\s+)?[\w<>]+\s+([A-Za-z_]\w*)\s*\(/ },
  ],
};

/** Symbols by declaration, without a parser dependency. Declarations are what a
 *  refactor needs to find; expressions are what code search is for. */
export function parseSymbols(text: string, language: string | undefined, file = ""): SymbolHit[] {
  if (!language) return [];
  const patterns = PATTERNS[language] ?? PATTERNS[language === "javascript" ? "typescript" : ""] ?? [];
  const hits: SymbolHit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
    for (const { kind, re } of patterns) {
      const match = re.exec(line);
      if (match?.[1]) {
        hits.push({ name: match[1].trim(), kind, file, line: i + 1, signature: truncate(line.trim(), 140) });
        break;
      }
    }
  }
  return hits;
}

export interface StackGuess {
  language: string;
  frameworks: string[];
  testCommand?: string;
  buildCommand?: string;
  benchmarkCommand?: string;
}

const MANIFESTS: Array<{ file: string; language: string; framework?: string; test?: string; build?: string; bench?: string }> = [
  { file: "package.json", language: "javascript", test: "npm test", build: "npm run build" },
  { file: "Package.swift", language: "swift", test: "swift test", build: "swift build", bench: "swift test --filter Benchmark" },
  { file: "pyproject.toml", language: "python", test: "pytest -q" },
  { file: "requirements.txt", language: "python", test: "pytest -q" },
  { file: "Cargo.toml", language: "rust", test: "cargo test", build: "cargo build", bench: "cargo bench" },
  { file: "go.mod", language: "go", test: "go test ./...", build: "go build ./..." },
  { file: "Makefile", language: "make", build: "make" },
];

/** Read the project the way a new contributor would: manifests first. */
export function detectStack(files: string[], readManifest?: (file: string) => string | undefined): StackGuess {
  const lower = files.map((file) => file.toLowerCase());
  const guess: StackGuess = { language: "unknown", frameworks: [] };
  for (const manifest of MANIFESTS) {
    if (!lower.includes(manifest.file.toLowerCase())) continue;
    if (guess.language === "unknown") {
      guess.language = manifest.language;
      guess.testCommand = manifest.test;
      guess.buildCommand = manifest.build;
      guess.benchmarkCommand = manifest.bench;
    }
  }
  const pkg = readManifest?.("package.json");
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const scripts = parsed.scripts ?? {};
      const deps = { ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) };
      for (const name of ["next", "react", "vue", "svelte", "@angular/core", "express", "hono", "fastify", "vite", "electron"]) {
        if (deps[name]) guess.frameworks.push(name);
      }
      if (scripts.test) guess.testCommand = "npm test";
      if (scripts.build) guess.buildCommand = "npm run build";
      const bench = Object.keys(scripts).find((name) => /bench|perf/i.test(name));
      if (bench) guess.benchmarkCommand = `npm run ${bench}`;
    } catch {
      // A package.json that does not parse is a finding of its own, reported later.
    }
  }
  if (lower.some((file) => file.endsWith(".metal")) && !guess.frameworks.includes("metal")) guess.frameworks.push("metal");
  if (lower.some((file) => file.endsWith(".swift"))) guess.language = guess.language === "unknown" ? "swift" : guess.language;
  return guess;
}

export interface IndexRecord {
  root: string;
  createdAt: string;
  files: number;
  symbols: number;
  languages: Record<string, number>;
  skipped: number;
  bytesIndexed?: number;
  limited?: boolean;
}

function canonicalRoot(root: string): string {
  try {
    return fs.realpathSync.native(root);
  } catch {
    return path.resolve(root);
  }
}

function indexFile(root: string): string {
  const canonical = canonicalRoot(root);
  const base = path.basename(canonical).replace(/[^a-zA-Z0-9._-]+/g, "-") || "repo";
  const hash = createHash("sha1").update(canonical).digest("hex").slice(0, 10);
  return path.join(appHome(), "index", `${base}-${hash}.json`);
}

type StoredIndex = { record: IndexRecord; symbols: SymbolHit[] };
type CachedIndex = { mtimeMs: number; size: number; value: StoredIndex; usedAt: number };
const INDEX_CACHE = new Map<string, CachedIndex>();
const INDEX_CACHE_MAX_BYTES = Math.max(8 * 1024 * 1024, Math.min(Number(process.env.LOCAL_AGENT_INDEX_CACHE_BYTES ?? 96 * 1024 * 1024), 512 * 1024 * 1024));

function trimIndexCache(): void {
  let total = [...INDEX_CACHE.values()].reduce((n, item) => n + item.size, 0);
  if (total <= INDEX_CACHE_MAX_BYTES) return;
  const oldest = [...INDEX_CACHE.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt);
  for (const [key, item] of oldest) {
    INDEX_CACHE.delete(key);
    total -= item.size;
    if (total <= INDEX_CACHE_MAX_BYTES) break;
  }
}

function readStoredIndex(file: string): StoredIndex | undefined {
  try {
    const stat = fs.statSync(file);
    const cached = INDEX_CACHE.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      cached.usedAt = Date.now();
      return cached.value;
    }
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as StoredIndex;
    INDEX_CACHE.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value, usedAt: Date.now() });
    trimIndexCache();
    return value;
  } catch {
    INDEX_CACHE.delete(file);
    return undefined;
  }
}

function writeStoredIndex(file: string, value: StoredIndex): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* renamed */ }
  }
  const stat = fs.statSync(file);
  INDEX_CACHE.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value, usedAt: Date.now() });
  trimIndexCache();
}

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".build", "DerivedData", "target", ".next", "__pycache__", ".venv", "venv", ".idea", ".vscode"]);

function walk(root: string, limit: number): string[] {
  const out: string[] = [];
  const queue = [root];
  let cursor = 0;
  // Index into the queue rather than Array.shift(): shift makes a large tree
  // walk accidentally O(n²) because every dequeue moves the remaining array.
  while (cursor < queue.length && out.length < limit) {
    const dir = queue[cursor++];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(full);
      } else if (entry.isFile()) {
        out.push(full);
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

export interface IndexOptions {
  root?: string;
  maxFiles?: number;
  maxFileSize?: number;
  maxBytes?: number;
  maxSymbols?: number;
}

/** Build or refresh the symbol index for a repository. */
export async function indexRepo(options: IndexOptions = {}): Promise<IndexRecord & { file: string }> {
  const root = canonicalRoot(resolveUserPath(options.root ?? process.cwd()));
  const started = Date.now();
  const limit = Math.min(Math.max(options.maxFiles ?? 10_000, 10), 250_000);
  const maxSize = Math.min(Math.max(options.maxFileSize ?? 512 * 1024, 4 * 1024), 32 * 1024 * 1024);
  const maxBytes = Math.min(Math.max(options.maxBytes ?? 128 * 1024 * 1024, 1024 * 1024), 4 * 1024 * 1024 * 1024);
  const maxSymbols = Math.min(Math.max(options.maxSymbols ?? 250_000, 1000), 2_000_000);
  const files = walk(root, limit);
  const languages: Record<string, number> = {};
  const symbols: SymbolHit[] = [];
  let skipped = 0;
  let bytesIndexed = 0;
  let limited = files.length >= limit;
  for (const file of files) {
    const language = languageOf(file);
    if (!language) {
      skipped += 1;
      continue;
    }
    let stats: fs.Stats;
    try {
      stats = fs.statSync(file);
    } catch {
      skipped += 1;
      continue;
    }
    if (stats.size > maxSize) {
      skipped += 1;
      continue;
    }
    if (bytesIndexed + stats.size > maxBytes) {
      limited = true;
      skipped += 1;
      break;
    }
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      skipped += 1;
      continue;
    }
    bytesIndexed += stats.size;
    languages[language] = (languages[language] ?? 0) + 1;
    const hits = parseSymbols(text, language, path.relative(root, file));
    const room = maxSymbols - symbols.length;
    if (hits.length > room) {
      if (room > 0) symbols.push(...hits.slice(0, room));
      limited = true;
      break;
    }
    symbols.push(...hits);
  }
  const record: IndexRecord = {
    root,
    createdAt: new Date().toISOString(),
    files: files.length,
    symbols: symbols.length,
    languages,
    skipped,
    bytesIndexed,
    limited,
  };
  const file = indexFile(root);
  writeStoredIndex(file, { record, symbols });
  return { ...record, file };
}

export interface SymbolQuery {
  root?: string;
  query: string;
  kind?: string;
  limit?: number;
  rebuild?: boolean;
  maxFiles?: number;
  maxFileSize?: number;
  maxBytes?: number;
  maxSymbols?: number;
}

export async function findSymbols(options: SymbolQuery): Promise<{ record: IndexRecord; hits: SymbolHit[]; rebuildMs: number }> {
  const root = canonicalRoot(resolveUserPath(options.root ?? process.cwd()));
  const file = indexFile(root);
  let stored: StoredIndex | undefined;
  let rebuildMs = 0;
  if (!options.rebuild && fs.existsSync(file)) stored = readStoredIndex(file);
  if (!stored) {
    const started = Date.now();
    const built = await indexRepo({ root, maxFiles: options.maxFiles, maxFileSize: options.maxFileSize, maxBytes: options.maxBytes, maxSymbols: options.maxSymbols });
    rebuildMs = Date.now() - started;
    stored = readStoredIndex(built.file);
  }
  if (!stored) throw new Error(`index build succeeded but ${file} could not be read`);
  const needle = options.query.toLowerCase();
  const hits = stored.symbols
    .filter((hit) => (!options.kind || hit.kind === options.kind) && (hit.name.toLowerCase().includes(needle) || hit.file.toLowerCase().includes(needle)))
    .sort((a, b) => {
      const aExact = a.name.toLowerCase() === needle ? 0 : 1;
      const bExact = b.name.toLowerCase() === needle ? 0 : 1;
      return aExact - bExact || a.name.length - b.name.length;
    })
    .slice(0, Math.min(options.limit ?? 20, 200));
  return { record: stored.record, hits, rebuildMs };
}

export interface ProjectSummary {
  root: string;
  stack: StackGuess;
  files: number;
  tests: number;
  git?: { branch?: string; dirty?: number; lastCommit?: string };
  todos: number;
  entryPoints: string[];
}

export async function projectSummary(root?: string): Promise<ProjectSummary> {
  const base = resolveUserPath(root ?? process.cwd());
  const files = walk(base, 6000).map((file) => path.relative(base, file));
  const readManifest = (name: string): string | undefined => {
    try {
      const file = path.join(base, name);
      const stat = fs.statSync(file);
      if (stat.size > 2 * 1024 * 1024) return undefined;
      return fs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  };
  const stack = detectStack(files, readManifest);
  const tests = files.filter((file) => /(^|\/)(test|tests|spec|__tests__)\//i.test(file) || /\.(test|spec)\.[a-z]+$/i.test(file)).length;
  const entryPoints = files.filter((file) => /(^|\/)(index|main|app|server|cli)\.(ts|js|tsx|swift|py)$/i.test(file)).slice(0, 8);
  let todos = 0;
  for (const file of files.slice(0, 1200)) {
    if (!languageOf(file)) continue;
    try {
      const full = path.join(base, file);
      const stat = fs.statSync(full);
      if (stat.size > 2 * 1024 * 1024) continue;
      const text = fs.readFileSync(full, "utf8");
      todos += (text.match(/(TODO|FIXME|XXX)/g) ?? []).length;
    } catch {
      // Unreadable files are skipped, not counted.
    }
  }
  const git = await (async () => {
    const branch = await run("/usr/bin/git", ["-C", base, "rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 10_000 });
    const status = await run("/usr/bin/git", ["-C", base, "status", "--porcelain"], { timeoutMs: 15_000 });
    const last = await run("/usr/bin/git", ["-C", base, "log", "-1", "--pretty=%h %s"], { timeoutMs: 10_000 });
    if (!branch.ok) return undefined;
    return {
      branch: branch.out.trim(),
      dirty: status.out.trim() ? status.out.trim().split("\n").length : 0,
      lastCommit: last.ok ? last.out.trim().slice(0, 140) : undefined,
    };
  })();
  return { root: base, stack, files: files.length, tests, git, todos, entryPoints };
}

// --- git operations --------------------------------------------------------

export type GitAction =
  | "status"
  | "diff"
  | "stage"
  | "unstage"
  | "commit"
  | "checkpoint"
  | "checkpoints"
  | "restore_checkpoint"
  | "worktree_create"
  | "worktree_list"
  | "worktree_remove";

interface TreeSnapshot {
  ok: boolean;
  /** Commit that wraps the snapshot tree, when one was made. */
  commit?: string;
  tree?: string;
  files: number;
  detail: string;
}

/** Snapshot the whole working tree, untracked files included, without touching
 *  the real index or the files on disk: staging happens in a throwaway index and
 *  the result goes into a commit that a checkpoint ref keeps alive. */
async function snapshotTree(root: string, label: string, message: string): Promise<TreeSnapshot> {
  const tmp = path.join(os.tmpdir(), `lap-index-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const env = {
    ...process.env,
    GIT_INDEX_FILE: tmp,
    GIT_AUTHOR_NAME: "local-agent-mcp checkpoint",
    GIT_AUTHOR_EMAIL: "checkpoint@localhost",
    GIT_COMMITTER_NAME: "local-agent-mcp checkpoint",
    GIT_COMMITTER_EMAIL: "checkpoint@localhost",
  };
  const call = (argv: string[]) => run("/usr/bin/git", ["-C", root, ...argv], { cwd: root, env, timeoutMs: 120_000 });
  try {
    const added = await call(["add", "-A"]);
    if (!added.ok) return { ok: false, files: 0, detail: `Could not read the working tree: ${added.err || added.out}` };
    const written = await call(["write-tree"]);
    const tree = written.out.trim();
    if (!written.ok || !tree) return { ok: false, files: 0, detail: `Could not write the snapshot: ${written.err || written.out}` };
    const head = (await run("/usr/bin/git", ["-C", root, "rev-parse", "HEAD"], { timeoutMs: 20_000 })).out.trim();
    const argv = ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", message];
    const committed = await call(argv);
    const commit = committed.out.trim();
    if (!committed.ok || !commit) return { ok: true, tree, files: 0, detail: `snapshot tree ${tree.slice(0, 10)}` };
    const ref = await run("/usr/bin/git", ["-C", root, "update-ref", `refs/checkpoints/${label}`, commit], { timeoutMs: 20_000 });
    if (!ref.ok) return { ok: false, files: 0, detail: `Could not keep the checkpoint ref: ${ref.err || ref.out}` };
    const listed = await call(["ls-tree", "-r", "--name-only", tree]);
    const files = listed.ok ? listed.out.trim().split("\n").filter(Boolean).length : 0;
    return { ok: true, commit, tree, files, detail: `snapshot ${commit.slice(0, 10)} with ${files} file(s)` };
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // A leftover temp index is harmless.
    }
  }
}

export interface GitArgs {
  root?: string;
  action: GitAction;
  paths?: string[];
  message?: string;
  name?: string;
  base?: string;
  stat?: boolean;
  stage?: boolean;
  /** For restore_checkpoint: the id printed by checkpoint. */
  id?: string;
}

export interface GitCheckpoint {
  id: string;
  root: string;
  sha: string;
  branch: string;
  message: string;
  createdAt: string;
}

function checkpointStore(): string {
  return path.join(appHome(), "git-checkpoints.json");
}

export function readCheckpoints(): GitCheckpoint[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(checkpointStore(), "utf8")) as GitCheckpoint[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function recordCheckpoint(entry: GitCheckpoint): void {
  try {
    fs.mkdirSync(path.dirname(checkpointStore()), { recursive: true });
    const kept = readCheckpoints().filter((item) => item.id !== entry.id).slice(-99);
    kept.push(entry);
    fs.writeFileSync(checkpointStore(), JSON.stringify(kept, null, 2), { mode: 0o600 });
  } catch {
    // The checkpoint commit still exists in the repository; only the label is lost.
  }
}

export async function gitWork(args: GitArgs): Promise<{ ok: boolean; message: string }> {
  const root = resolveUserPath(args.root ?? process.cwd());
  const git = (argv: string[], timeoutMs = 60_000) => run("/usr/bin/git", ["-C", root, ...argv], { timeoutMs });
  switch (args.action) {
    case "status": {
      const res = await git(["status", "--short", "--branch"]);
      return { ok: res.ok, message: res.ok ? res.out.trim() || "Working tree clean." : res.err };
    }
    case "diff": {
      const argv = ["diff", ...(args.stat ? ["--stat"] : []), ...(args.stage ? ["--cached"] : []), ...(args.paths ?? [])];
      const res = await git(argv);
      if (!res.ok) return { ok: false, message: res.err };
      const body = res.out.trim();
      return { ok: true, message: body ? truncate(body, 12_000) : "No differences for that selection." };
    }
    case "stage": {
      const res = await git(["add", ...(args.paths?.length ? args.paths : ["-A"])]);
      return { ok: res.ok, message: res.ok ? `Staged ${args.paths?.length ? args.paths.join(", ") : "all changes"}.` : res.err };
    }
    case "unstage": {
      const res = await git(["restore", "--staged", ...(args.paths?.length ? args.paths : ["."])]);
      return { ok: res.ok, message: res.ok ? "Unstaged." : res.err };
    }
    case "commit": {
      if (!args.message) return { ok: false, message: "commit needs a message." };
      const res = await git(["commit", "-m", args.message]);
      return { ok: res.ok, message: res.ok ? res.out.trim() : res.err || res.out };
    }
    case "checkpoint": {
      const id = `cp_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 6)}`;
      const message = args.message ?? "manual checkpoint";
      const snapshot = await snapshotTree(root, id, message);
      if (!snapshot.ok || !snapshot.commit) return { ok: false, message: snapshot.detail };
      const headTree = (await git(["rev-parse", "HEAD^{tree}"], 20_000)).out.trim();
      if (snapshot.tree && snapshot.tree === headTree) {
        return { ok: true, message: "Nothing to checkpoint: the working tree matches HEAD." };
      }
      const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], 20_000)).out.trim() || "detached";
      recordCheckpoint({
        id,
        root,
        sha: snapshot.commit,
        branch,
        message,
        createdAt: new Date().toISOString(),
      });
      return {
        ok: true,
        message: `Checkpoint ${id} on ${branch}, ${snapshot.files} file(s), untracked included.\nRestore it with action=restore_checkpoint id=${id}.`,
      };
    }
    case "checkpoints": {
      const all = readCheckpoints().filter((item) => !args.root || item.root === root);
      if (!all.length) return { ok: true, message: `No checkpoints recorded for ${root}.` };
      const lines = all.slice(-20).map((item) => `${item.id}\t${item.createdAt}\t${item.branch}\t${item.message}`);
      return { ok: true, message: lines.join("\n") };
    }
    case "restore_checkpoint": {
      if (!args.id) return { ok: false, message: "restore_checkpoint needs id (from action=checkpoints)." };
      const entry = readCheckpoints().find((item) => item.id === args.id);
      if (!entry) return { ok: false, message: `No checkpoint ${args.id} was recorded.` };
      // Save what is on disk now, so a restore can never be the thing that loses work.
      const guardId = `cp_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 6)}`;
      const guard = await snapshotTree(root, guardId, `before restoring ${entry.id}`);
      if (guard.ok && guard.commit) {
        recordCheckpoint({ id: guardId, root, sha: guard.commit, branch: entry.branch, message: `before restoring ${entry.id}`, createdAt: new Date().toISOString() });
      }
      const tree = (await git(["rev-parse", `${entry.sha}^{tree}`], 20_000)).out.trim() || entry.sha;
      // read-tree --reset -u makes the working tree match the tree exactly, which
      // also removes files that were created after the checkpoint.
      const applied = await git(["read-tree", "--reset", "-u", tree], 120_000);
      if (!applied.ok) {
        return {
          ok: false,
          message: `Could not restore ${entry.id}: ${applied.err || applied.out}\nThe current tree was checkpointed first${guard.commit ? ` as ${guardId}` : ""}, so nothing was lost.`,
        };
      }
      return { ok: true, message: `Restored the working tree to ${entry.id} (${entry.createdAt}).` };
    }
    case "worktree_create": {
      const name = (args.name ?? "").replace(/[^a-zA-Z0-9._-]+/g, "-");
      if (!name) return { ok: false, message: "worktree_create needs a name." };
      const target = path.join(os.tmpdir(), `lap-worktree-${name}`);
      const base = args.base ?? "HEAD";
      const res = await git(["worktree", "add", "-b", `lap/${name}`, target, base], 120_000);
      return { ok: res.ok, message: res.ok ? `Worktree for branch lap/${name} at ${target}` : res.err || res.out };
    }
    case "worktree_list": {
      const res = await git(["worktree", "list", "--porcelain"]);
      if (!res.ok) return { ok: false, message: res.err };
      const blocks = res.out.trim().split("\n\n").filter(Boolean);
      const lines = blocks.map((block) => {
        const dir = /worktree (.+)/.exec(block)?.[1] ?? "?";
        const branch = /branch refs\/heads\/(.+)/.exec(block)?.[1] ?? "(detached)";
        return `${branch}\t${dir}`;
      });
      return { ok: true, message: lines.join("\n") || "No worktrees." };
    }
    case "worktree_remove": {
      const name = (args.name ?? "").replace(/[^a-zA-Z0-9._-]+/g, "-");
      const target = args.paths?.[0] ?? path.join(os.tmpdir(), `lap-worktree-${name}`);
      const res = await git(["worktree", "remove", "--force", target], 60_000);
      if (!res.ok) return { ok: false, message: res.err || res.out };
      await git(["branch", "-D", `lap/${name}`], 20_000);
      return { ok: true, message: `Removed worktree ${target} and branch lap/${name}.` };
    }
    default:
      return { ok: false, message: `Unknown git action ${String(args.action)}.` };
  }
}

// --- resources -------------------------------------------------------------

export interface ResourceState {
  ok: boolean;
  load: number;
  cores: number;
  memoryFreeMB: number;
  swapUsedMB: number;
  note: string;
}

async function swapUsedMB(): Promise<number> {
  const res = await run("/usr/sbin/sysctl", ["-n", "vm.swapusage"], { timeoutMs: 8000 });
  const used = /used = ([\d.]+)M/.exec(res.out)?.[1];
  return used ? Number(used) : 0;
}

function freeMemoryMB(): number {
  return Math.round(os.freemem() / (1024 * 1024));
}

/** A fanless machine throttles under sustained load, so a benchmark taken while the
 *  load average is far above the core count is not a measurement of the code. */
export async function assessResources(): Promise<ResourceState> {
  const load = os.loadavg()[0];
  const cores = os.cpus().length;
  const free = freeMemoryMB();
  const swap = await swapUsedMB();
  const busy = load > cores * 1.5;
  const tight = free < 800 || swap > 2048;
  return {
    ok: !busy && !tight,
    load: Math.round(load * 100) / 100,
    cores,
    memoryFreeMB: free,
    swapUsedMB: swap,
    note: busy
      ? `Load ${load.toFixed(1)} on ${cores} cores. Results taken now are about the machine, not the code.`
      : tight
        ? `Only ${free} MB free and ${swap} MB of swap in use. A memory measurement now would be noise.`
        : `Load ${load.toFixed(2)} on ${cores} cores, ${free} MB free, ${swap} MB swap.`,
  };
}

// --- goal loop ---------------------------------------------------------------

export interface AcceptanceCommand {
  name: string;
  cmd: string;
  expect?: string;
  timeoutSeconds?: number;
}

export interface CommandOutcome {
  name: string;
  cmd: string;
  ok: boolean;
  exitCode: number;
  ms: number;
  output: string;
}

export interface GoalRun {
  id: string;
  root: string;
  goal: string;
  iteration: number;
  createdAt: string;
  outcomes: CommandOutcome[];
  passed: boolean;
  resources: ResourceState;
}

function goalsDir(): string {
  return path.join(appHome(), "goals");
}

export function recordGoal(runRecord: GoalRun): void {
  fs.mkdirSync(goalsDir(), { recursive: true });
  const file = path.join(goalsDir(), `${runRecord.id}.json`);
  let history: GoalRun[] = [];
  if (fs.existsSync(file)) {
    try {
      history = JSON.parse(fs.readFileSync(file, "utf8")) as GoalRun[];
    } catch {
      history = [];
    }
  }
  history.push({ ...runRecord, outcomes: runRecord.outcomes });
  fs.writeFileSync(file, JSON.stringify(history.slice(-50), null, 2), { mode: 0o600 });
}

export function goalHistory(id: string): GoalRun[] {
  const file = path.join(goalsDir(), `${id}.json`);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as GoalRun[];
  } catch {
    return [];
  }
}

export interface GoalOptions {
  root?: string;
  goal: string;
  id?: string;
  acceptance: AcceptanceCommand[];
  iteration?: number;
  skipResourceCheck?: boolean;
}

/** Run the acceptance commands and say exactly which ones failed. This is the
 *  measure the whole coding loop is judged by, so it refuses to call a run passed
 *  when any command failed or a resource warning made the numbers unreliable. */
export async function runGoal(options: GoalOptions): Promise<GoalRun> {
  const root = resolveUserPath(options.root ?? process.cwd());
  const resources = await assessResources();
  const outcomes: CommandOutcome[] = [];
  for (const command of options.acceptance) {
    const started = Date.now();
    const result = await sh(command.cmd, { cwd: root, timeoutMs: (command.timeoutSeconds ?? 600) * 1000 });
    const output = `${result.out}\n${result.err}`.trim();
    const pattern = command.expect ? new RegExp(command.expect, "i") : undefined;
    const matched = pattern ? pattern.test(output) : true;
    outcomes.push({
      name: command.name,
      cmd: command.cmd,
      ok: result.ok && matched,
      exitCode: result.code ?? -1,
      ms: Date.now() - started,
      output: truncate(output, 1200),
    });
  }
  const runRecord: GoalRun = {
    id: options.id ?? `goal-${Date.now().toString(36)}`,
    root,
    goal: options.goal,
    iteration: options.iteration ?? 1,
    createdAt: new Date().toISOString(),
    outcomes,
    passed: outcomes.every((outcome) => outcome.ok),
    resources,
  };
  recordGoal(runRecord);
  return runRecord;
}

// --- benchmarks --------------------------------------------------------------

export interface BenchSample {
  name: string;
  /** kernel, model or memory: they are not comparable to each other. */
  channel: "kernel" | "model" | "memory" | "end_to_end";
  metric: string;
  value: number;
  unit?: string;
  device?: string;
  at?: string;
  note?: string;
}

function benchFile(): string {
  return path.join(appHome(), "benchmarks.json");
}

export function readBenchmarks(): BenchSample[] {
  try {
    return JSON.parse(fs.readFileSync(benchFile(), "utf8")) as BenchSample[];
  } catch {
    return [];
  }
}

export function recordBenchmark(sample: BenchSample): BenchSample {
  const all = readBenchmarks();
  const stamped: BenchSample = { ...sample, at: sample.at ?? new Date().toISOString() };
  all.push(stamped);
  fs.mkdirSync(path.dirname(benchFile()), { recursive: true });
  fs.writeFileSync(benchFile(), JSON.stringify(all.slice(-500), null, 2), { mode: 0o600 });
  return stamped;
}

export interface BenchComparison {
  name: string;
  channel: BenchSample["channel"];
  metric: string;
  baseline?: number;
  current?: number;
  changePct?: number;
  verdict: "regression" | "improvement" | "unchanged" | "no-baseline";
}

/** Which direction is better for a metric, read from its name. Getting this
 *  backwards turns every regression into a reported improvement, so the defaults
 *  are explicit: anything that measures a cost is lower-is-better. */
export function isLowerBetter(metric: string): boolean {
  const name = metric.toLowerCase();
  if (/throughput|tokens_per|fps|speedup|ops_per|score|accuracy/.test(name)) return false;
  return /time|latency|ms|duration|elapsed|memory|mb|peak|rss|energy|joule|watt|cost|size|allocs/.test(name);
}

/** Compare like with like: same channel, metric and device. A kernel time and a
 *  full model time in the same table is how performance claims go wrong. */
export function compareBenchmarks(samples: BenchSample[], name: string, tolerancePct = 5): BenchComparison[] {
  const mine = samples.filter((sample) => sample.name === name);
  const groups = new Map<string, BenchSample[]>();
  for (const sample of mine) {
    const key = `${sample.channel}|${sample.metric}|${sample.device ?? "default"}`;
    const list = groups.get(key) ?? [];
    list.push(sample);
    groups.set(key, list);
  }
  const out: BenchComparison[] = [];
  for (const [, list] of groups) {
    const ordered = [...list].sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const current = ordered[ordered.length - 1];
    const baseline = ordered[ordered.length - 2];
    if (!baseline) {
      out.push({ name, channel: current.channel, metric: current.metric, current: current.value, verdict: "no-baseline" });
      continue;
    }
    const delta = ((current.value - baseline.value) / (baseline.value || 1)) * 100;
    const lowerIsBetter = isLowerBetter(current.metric);
    const regression = lowerIsBetter ? delta > tolerancePct : delta < -tolerancePct;
    const improvement = lowerIsBetter ? delta < -tolerancePct : delta > tolerancePct;
    out.push({
      name,
      channel: current.channel,
      metric: current.metric,
      baseline: baseline.value,
      current: current.value,
      changePct: Math.round(delta * 10) / 10,
      verdict: regression ? "regression" : improvement ? "improvement" : "unchanged",
    });
  }
  return out;
}

// --- profiling and crash reports -------------------------------------------

export interface ProfileOptions {
  /** A pid, or a process name the sampler can resolve. */
  target: string;
  seconds?: number;
  top?: number;
}

export interface ProfileResult {
  ok: boolean;
  message: string;
  file?: string;
}

/** Read the useful part of an Apple sampler report: the header, then the frames
 *  that carry the most samples, which is where a hot loop actually is. */
export function summarizeSample(text: string, top = 12): string {
  const lines = text.split("\n");
  const out: string[] = [];
  const header = lines.find((line) => /Sampling process/i.test(line));
  if (header) out.push(header.trim());
  const sorted = lines.findIndex((line) => /Sort by top of stack/i.test(line));
  if (sorted >= 0) {
    out.push("frames by sample count, deepest first:");
    let collected = 0;
    for (const line of lines.slice(sorted + 1)) {
      if (!line.trim()) {
        if (collected) break;
        else continue;
      }
      if (collected >= top) break;
      out.push(line.replace(/\s+$/, ""));
      collected += 1;
    }
  }
  if (out.length <= 1) {
    const graph = lines.findIndex((line) => /Call graph/i.test(line));
    if (graph >= 0) out.push(...lines.slice(graph + 1, graph + top + 1));
  }
  return out.join("\n") || "The sampler produced no stack summary.";
}

export async function profileProcess(options: ProfileOptions): Promise<ProfileResult> {
  const target = options.target.trim();
  if (!target) return { ok: false, message: "profile needs a pid or a process name." };
  const seconds = Math.min(Math.max(options.seconds ?? 5, 1), 60);
  const top = Math.min(Math.max(options.top ?? 12, 3), 60);
  const dir = path.join(appHome(), "profiles");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    return { ok: false, message: `Could not create ${dir}: ${(error as Error).message}` };
  }
  const file = path.join(dir, `sample-${Date.now()}.txt`);
  const res = await run("/usr/bin/sample", [target, String(seconds), "-file", file], { timeoutMs: (seconds + 25) * 1000 });
  if (!res.ok) {
    const detail = truncate(`${res.err || res.out}`.trim(), 600);
    return {
      ok: false,
      message: `The sampler could not profile ${target}: ${detail}\nProfiling another account's process needs elevated rights, and a hardened runtime app can refuse sampling entirely. Profiling a process this tool started always works.`,
    };
  }
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : res.out;
  return { ok: true, message: `sampled ${target} for ${seconds}s, full report ${file}\n${summarizeSample(text, top)}`, file };
}

export interface CrashReport {
  name: string;
  file: string;
  at: string;
  reason?: string;
  topFrames: string[];
}

function parseCrashFile(file: string): { reason?: string; topFrames: string[] } {
  let text = "";
  try {
    const fd = fs.openSync(file, "r");
    try {
      const stat = fs.fstatSync(fd);
      const take = Math.min(stat.size, 8 * 1024 * 1024);
      const buffer = Buffer.allocUnsafe(take);
      const n = fs.readSync(fd, buffer, 0, take, 0);
      text = buffer.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { topFrames: [] };
  }
  const lines = text.split("\n");
  // .ips files are two JSON documents: a header line, then the payload.
  for (const candidate of [lines[1], lines[0]]) {
    if (!candidate || !candidate.trim().startsWith("{")) continue;
    try {
      const payload = JSON.parse(candidate) as {
        exception?: { type?: string; signal?: string };
        termination?: { reason?: string };
        threads?: Array<{ frames?: Array<{ symbol?: string; imageIndex?: number }> }>;
        usedImages?: Array<{ name?: string }>;
      };
      const images = payload.usedImages ?? [];
      const frames = (payload.threads?.[0]?.frames ?? [])
        .map((frame) => frame.symbol || images[frame.imageIndex ?? -1]?.name)
        .filter((symbol): symbol is string => Boolean(symbol))
        .slice(0, 6);
      const type = payload.exception?.type;
      const signal = payload.exception?.signal;
      const reason = [type, signal, payload.termination?.reason].filter(Boolean).join(", ");
      return { reason: reason || undefined, topFrames: frames };
    } catch {
      // Not the JSON shape this reader knows; fall back to the text scan below.
    }
  }
  const reasonLine = lines.find((line) => /Exception Type|Termination Reason/i.test(line));
  const frames = lines.filter((line) => /^\s*\d+\s+\S+/.test(line)).slice(0, 6).map((line) => line.trim());
  return { reason: reasonLine?.trim(), topFrames: frames };
}

/** Recent crash reports for one app, newest first. Only the newest requested
 * reports are parsed; directory traversal remains constant-memory. */
export async function recentCrashes(options: { app?: string; limit?: number } = {}): Promise<{ ok: boolean; message: string; reports: CrashReport[] }> {
  const dir = path.join(os.homedir(), "Library", "Logs", "DiagnosticReports");
  const needle = options.app?.toLowerCase();
  const keep = Math.min(Math.max(options.limit ?? 5, 1), 30);
  let handle: fs.Dir;
  try {
    handle = fs.opendirSync(dir);
  } catch {
    return { ok: true, message: `No crash reports directory at ${dir}.`, reports: [] };
  }
  const candidates: Array<{ name: string; file: string; at: string }> = [];
  try {
    for (;;) {
      const entry = handle.readSync();
      if (!entry) break;
      const name = entry.name;
      if (!entry.isFile() || !/\.(crash|ips|diag)$/i.test(name)) continue;
      if (needle && !name.toLowerCase().includes(needle)) continue;
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file);
        candidates.push({ name, file, at: stat.mtime.toISOString() });
        candidates.sort((a, b) => b.at.localeCompare(a.at));
        if (candidates.length > keep) candidates.length = keep;
      } catch {
        /* report disappeared */
      }
    }
  } finally {
    try { handle.closeSync(); } catch { /* already closed */ }
  }
  const kept: CrashReport[] = candidates.map((candidate) => {
    const parsed = parseCrashFile(candidate.file);
    return { ...candidate, reason: parsed.reason, topFrames: parsed.topFrames };
  });
  if (!kept.length) {
    return { ok: true, message: `No crash reports${needle ? ` for ${options.app}` : ""} in ${dir}.`, reports: [] };
  }
  const lines = [`${kept.length} crash report(s)${needle ? ` for ${options.app}` : ""}, newest first:`];
  for (const report of kept) {
    lines.push(`  ${report.at}  ${report.name}${report.reason ? `  ${report.reason}` : ""}`);
    for (const frame of report.topFrames) lines.push(`      ${frame}`);
  }
  return { ok: true, message: lines.join("\n"), reports: kept };
}

