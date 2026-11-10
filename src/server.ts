import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { audit } from "./audit.js";
import { acquireToolSlot } from "./capacity.js";
import { BoundedCapture } from "./bounded-capture.js";
import {
  appControl,
  keyboard,
  mouse,
  screenCapture,
  uiAct,
  uiFind,
  uiTree,
  windowControl,
  windowList,
} from "./computer.js";
import {
  APP_VERSION,
  configPath,
  defaultConfig,
  getPath,
  loadConfig,
  patchConfig,
  redactConfig,
  resetConfig,
  resolveUserPath,
  setPath,
  unsetPath,
} from "./config.js";
import { CUA_TOOLS, callCuaTool } from "./cua.js";
import { sh } from "./exec.js";
import { readTextLines } from "./large-text.js";
import { audio, media, networkInfo, power, processControl, processList, speak, systemInfo } from "./harness.js";
import { diagnose, openPane, requestPermissions, type PermKind } from "./permissions.js";
import { browser, calendar, contacts, notes, reminders } from "./pim.js";
import { noteToolCall, registerHandler } from "./registry.js";
import {
  acceptanceBlockers,
  appendLog,
  createTask,
  describeStep,
  evaluateAcceptance,
  listTasks,
  loadTask,
  progressOf,
  readLog,
  refreshStaleEvidence,
  requireTask,
  runnableSteps,
  saveTask,
  stepsNeedApproval,
  summaryLine,
  type StepInput,
  type Task,
  type TaskInput,
} from "./tasks.js";
import { isRunning, runTask } from "./orchestrator.js";
import { observe, summarizeScreen, uiDo } from "./planner.js";
import { backupDocument, comparePdf, listBackups, qaPdf, restoreBackup } from "./docqa.js";
import {
  assessResources,
  compareBenchmarks,
  findSymbols,
  gitWork,
  goalHistory,
  indexRepo,
  profileProcess,
  projectSummary,
  readBenchmarks,
  recentCrashes,
  recordBenchmark,
  runGoal,
} from "./coding.js";
import { compileSkill, describeSkill, listSkills, loadSkill, matchSkills, recordSkillRun, recordTaskForSkill, saveSkill, seedBuiltinSkills } from "./skills.js";
import { projectContext, projectReview } from "./project-guard.js";
import { runWeb } from "./web.js";
import { fileOps, recentFiles, shellSession, spotlight, waitFor } from "./workflow.js";
import {
  iworkApps,
  iworkDocument,
  iworkExport,
  iworkScript,
  iworkShapes,
} from "./iwork.js";
import { iworkItems } from "./iwork-items.js";
import {
  keynoteContent,
  keynoteDocument,
  keynoteNotes,
  keynoteShow,
  keynoteSlideFormat,
  keynoteSlides,
  keynoteTransition,
} from "./keynote.js";
import {
  semanticArrange,
  semanticChoose,
  semanticInspect,
  semanticPress,
  semanticSet,
  semanticToggle,
} from "./iwork-ui.js";
import { pagesDocumentLayout, pagesSectionLayout, pagesTextLayout } from "./pages-ui.js";
import { macApps, macFinder, macShortcuts, macSystem, macUi } from "./mac.js";
import { numbersCells, numbersSheets, numbersTables } from "./numbers.js";
import { numbersCreate, numbersFind, numbersInspect, numbersStats, numbersVerify } from "./numbers-deep.js";
import { keynoteCharts, keynoteCreate, keynoteFind, keynoteImageSlides, keynoteInspect, keynoteStats, keynoteVerify } from "./keynote-deep.js";
import {
  pagesCreate,
  pagesDuplicate,
  pagesEdit,
  pagesExport,
  pagesFind,
  pagesFormat,
  pagesInspect,
  pagesInsertImage,
  pagesInsertTextbox,
  pagesObjects,
  pagesRead,
  pagesReplace,
  pagesStats,
  pagesStatus,
  pagesStyles,
  pagesTable,
  pagesVerify,
  type PageBlock,
} from "./pages.js";

const HOME = os.homedir();
const MAX_CAPTURE = 200_000; // bytes captured per stream in run_command
const MAX_DOWNLOAD = 2 * 1024 * 1024 * 1024; // 2 GiB
const MAX_READ = 5 * 1024 * 1024; // bytes read by read_file
const MAX_IMAGE = 25 * 1024 * 1024;
const SEARCH_VISIT_CAP = 200_000;
const SEARCH_TIME_BUDGET_MS = 20_000;
const SEARCH_MAX_RESULTS_CAP = 500;

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "heic"]);

// GUI-launched MCP clients often inherit a smaller PATH than an interactive
// shell. Add only directories that exist, including the active Node runtime,
// common package-manager prefixes and user-local Python/bin directories.
function discoveredPathDirs(): string[] {
  const dirs = new Set<string>();
  const add = (dir: string) => {
    if (dir && fs.existsSync(dir)) dirs.add(dir);
  };

  add(path.dirname(process.execPath));
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) add(dir);
  for (const dir of [
    path.join(HOME, ".local", "bin"),
    path.join(HOME, "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/opt/local/bin",
    "/opt/local/sbin",
  ]) add(dir);

  const pythonRoot = path.join(HOME, "Library", "Python");
  try {
    for (const version of fs.readdirSync(pythonRoot)) add(path.join(pythonRoot, version, "bin"));
  } catch {
    // Python user scripts are optional.
  }
  return [...dirs];
}

function augmentedEnv(extra?: Record<string, string>): Record<string, string | undefined> {
  const base = { ...process.env, ...extra };
  const inherited = String(base.PATH ?? "").split(path.delimiter).filter(Boolean);
  base.PATH = [...new Set([...discoveredPathDirs(), ...inherited])].join(path.delimiter);
  return base;
}

type TextBlock = { type: "text"; text: string };
type ImageBlock = { type: "image"; data: string; mimeType: string };
type ToolResult = { content: Array<TextBlock | ImageBlock>; isError?: boolean };

function text(value: string, isError = false): ToolResult {
  return isError
    ? { content: [{ type: "text", text: value }], isError: true }
    : { content: [{ type: "text", text: value }] };
}

function resolvePath(p: string): string {
  let out = p;
  if (out === "~") out = HOME;
  else if (out.startsWith("~/")) out = path.join(HOME, out.slice(2));
  return path.resolve(out);
}

function summarize(res: ToolResult): string {
  const first = res.content.find((c): c is TextBlock => c.type === "text");
  const value = first ? first.text : `${res.content.length} content block(s)`;
  return value.length > 300 ? `${value.slice(0, 300)}...` : value;
}

/** Run a tool body, capturing outcome + duration into the audit log. Never throws.
 * A global execution semaphore provides backpressure under burst load. */
async function audited(name: string, args: unknown, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  const started = Date.now();
  let release: (() => void) | undefined;
  try {
    release = await acquireToolSlot();
    const res = await fn();
    audit({
      event: "tool",
      tool: name,
      args,
      ok: !res.isError,
      summary: summarize(res),
      durationMs: Date.now() - started,
    });
    return res;
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    audit({ event: "tool", tool: name, args, ok: false, summary: message, durationMs: Date.now() - started });
    return text(`ERROR: ${message}`, true);
  } finally {
    release?.();
  }
}

function makeCollector(maxBytes = MAX_CAPTURE) {
  const capture = new BoundedCapture(maxBytes);
  return {
    push(buf: Buffer) { capture.push(buf); },
    get text() { return capture.text; },
    get truncated() { return capture.truncated; },
  };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

function isProbablyBinary(buf: Buffer): boolean {
  const window = buf.subarray(0, 8192);
  return window.includes(0);
}

function globToRegex(pattern: string): RegExp {
  let body = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        body += ".*";
        i++;
      } else {
        body += "[^/]*";
      }
    } else if (ch === "?") {
      body += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      body += `\\${ch}`;
    } else {
      body += ch;
    }
  }
  return new RegExp(`^${body}$`);
}

function nameMatcher(query: string, caseSensitive: boolean): RegExp {
  const flags = caseSensitive ? "" : "i";
  if (/[*?[\]]/.test(query)) return new RegExp(globToRegex(query).source, flags);
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped, flags);
}

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".npm",
  ".yarn",
  ".pnpm-store",
  ".gradle",
  ".Trash",
  ".Spotlight-V100",
  ".fseventsd",
  "Library",
]);

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "local-agent-mcp", version: APP_VERSION },
    {
      instructions:
        "Full-access tools for the host Mac. Every tool call is written to the per-user audit log. " +
        "Use run_command for anything a dedicated tool does not cover, and pass cwd to carry working-directory state between commands. " +
        "Paths accept ~; relative paths resolve against the server's working directory. " +
        "Resolve optional developer tools from PATH instead of assuming a Homebrew prefix, Python version or package version. " +
        "MLX and Metal workflows are available when their dependencies are installed. " +
        "For tunnel connection errors, first inspect the server and tunnel health without restarting either. " +
        "A terminated ChatGPT session may need connector reconnection even when local processes are healthy; " +
        "an uninitialized stdio MCP session may indicate a missing initialized notification. " +
        "For HTTP 503 follow Retry-After or reduce concurrent work; for 413 reduce request size. " +
        "The optional Computer Use compatibility bridge uses the installed unified-computer-use plugin when present. " +
        "Native UI, mouse, keyboard and screen tools do not require that plugin. " +
        "Pages documents are handled natively by the pages_* tools (Apple Events into the real Pages app, " +
        "no Word or docx step): pages_create writes a .pages file from blocks, pages_read returns text plus a " +
        "size/font outline and any tables, pages_inspect reports how everything is formatted, pages_replace " +
        "does scoped find-and-replace, pages_styles manages the default type scale, pages_edit appends/" +
        "rewrites/sets cells, pages_export writes PDF/txt/rtf/epub. `style` selects a type scale and palette " +
        "(classic/serif/modern/compact) or overrides it; `table` blocks become real Pages tables with header " +
        "rows, fills and column alignment. " +
        "If a pages_* call reports a permission error, run pages_status for the exact System Settings path.",
    },
  );

  server.registerTool(
    "run_command",
    {
      title: "Run shell command",
      description:
        "Run a shell command on this Mac and return stdout, stderr and the exit code. " +
        "Full terminal access: pipes, redirects, git, npm, curl, etc. work. " +
        "Use cwd to choose the working directory and timeoutSeconds (default 60, max 600) for long jobs.",
      inputSchema: {
        command: z.string().describe("Shell command to run, e.g. 'ls -la ~/Downloads' or 'npm test'"),
        cwd: z
          .string()
          .optional()
          .describe("Working directory (absolute or ~ relative). Defaults to the server's working directory."),
        timeoutSeconds: z
          .number()
          .int()
          .positive()
          .max(3600)
          .optional()
          .describe("Kill the command after this many seconds (default 60, max 3600)."),
        env: z.record(z.string()).optional().describe("Extra environment variables for this command."),
        maxOutputKB: z.number().int().min(16).max(5120).optional().describe("Per stdout/stderr capture budget in KiB (default 200). Head and tail are preserved when truncated."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ command, cwd, timeoutSeconds, env, maxOutputKB }) =>
      audited("run_command", { command, cwd, timeoutSeconds, env, maxOutputKB }, async () => {
        const workDir = cwd ? resolvePath(cwd) : process.cwd();
        const timeoutMs = (timeoutSeconds ?? 60) * 1000;
        const captureBytes = Math.min(Math.max(maxOutputKB ?? 200, 16), 5120) * 1024;

        return await new Promise<ToolResult>((resolve) => {
          const grouped = process.platform !== "win32";
          const child = spawn(command, {
            shell: true,
            cwd: workDir,
            env: augmentedEnv(env),
            stdio: ["ignore", "pipe", "pipe"],
            detached: grouped,
          });
          const signalTree = (signal: NodeJS.Signals) => {
            try {
              if (grouped && child.pid) process.kill(-child.pid, signal);
              else child.kill(signal);
            } catch {
              try { child.kill(signal); } catch { /* already gone */ }
            }
          };
          const out = makeCollector(captureBytes);
          const errOut = makeCollector(captureBytes);
          let timedOut = false;

          child.stdout?.on("data", (buf: Buffer) => out.push(buf));
          child.stderr?.on("data", (buf: Buffer) => errOut.push(buf));

          const timer = setTimeout(() => {
            timedOut = true;
            signalTree("SIGTERM");
            const kill = setTimeout(() => signalTree("SIGKILL"), 3000);
            kill.unref();
          }, timeoutMs);

          child.on("error", (err) => {
            clearTimeout(timer);
            resolve(text(`failed to start command: ${err.message}`, true));
          });

          child.on("close", (code, signal) => {
            clearTimeout(timer);
            const head =
              `exit code: ${code ?? "null"}${signal ? ` (signal ${signal})` : ""}` +
              `${timedOut ? ` - TIMED OUT after ${timeoutMs / 1000}s and was killed` : ""}\ncwd: ${workDir}`;
            const parts = [head];
            const stdout = out.text;
            const stderr = errOut.text;
            if (stdout) parts.push(`--- stdout${out.truncated ? ` (truncated to head+tail within ${formatBytes(captureBytes)})` : ""} ---\n${stdout}`);
            if (stderr) parts.push(`--- stderr${errOut.truncated ? ` (truncated to head+tail within ${formatBytes(captureBytes)})` : ""} ---\n${stderr}`);
            if (!stdout && !stderr) parts.push("(no output)");
            resolve(text(parts.join("\n"), Boolean(timedOut) || code !== 0));
          });
        });
      }),
  );

  server.registerTool(
    "write_file",
    {
      title: "Write file",
      description:
        "Create or overwrite a text file on this Mac, creating parent directories as needed. " +
        "Use this to write scripts (e.g. MLX kernel test files) without shell-quoting pain; " +
        "for binary output or appends use run_command.",
      inputSchema: {
        path: z.string().describe("Destination file path (~ or absolute; relative resolves to server cwd)"),
        content: z.string().describe("Full text contents of the file"),
        overwrite: z.boolean().optional().describe("Replace an existing file (default false)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ path: filePath, content, overwrite }) =>
      audited("write_file", { path: filePath, overwrite, bytes: content.length }, async () => {
        const full = resolvePath(filePath);
        if (fs.existsSync(full) && !overwrite) {
          return text(`ERROR: ${full} already exists. Pass overwrite=true to replace it.`, true);
        }
        await fsp.mkdir(path.dirname(full), { recursive: true });
        await fsp.writeFile(full, content, "utf8");
        return text(`Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${full}`);
      }),
  );

  server.registerTool(
    "download_file",
    {
      title: "Download file",
      description:
        "Download an http(s) URL to a file on this Mac. Defaults to ~/Downloads using the URL's filename. " +
        "Returns the saved path, size and content type.",
      inputSchema: {
        url: z.string().url().describe("http:// or https:// URL to fetch"),
        destPath: z
          .string()
          .optional()
          .describe("Destination file path (~ or absolute). Defaults to ~/Downloads/<filename>."),
        overwrite: z.boolean().optional().describe("Replace an existing file at destPath (default false)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ url, destPath, overwrite }) =>
      audited("download_file", { url, destPath, overwrite }, async () => {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return text(`ERROR: only http/https URLs are supported (got ${parsed.protocol})`, true);
        }

        let dest: string;
        if (destPath) {
          dest = resolvePath(destPath);
        } else {
          const base = path.basename(parsed.pathname).replace(/[^A-Za-z0-9._-]/g, "_");
          const name = base && base !== "." ? base : `download-${Date.now()}`;
          dest = path.join(HOME, "Downloads", name);
        }

        if (fs.existsSync(dest) && !overwrite) {
          return text(`ERROR: ${dest} already exists. Pass overwrite=true or a different destPath.`, true);
        }
        await fsp.mkdir(path.dirname(dest), { recursive: true });

        const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
        if (!res.ok || !res.body) {
          return text(`ERROR: HTTP ${res.status} ${res.statusText} for ${url}`, true);
        }
        const declared = Number(res.headers.get("content-length") ?? "0");
        if (declared > MAX_DOWNLOAD) {
          return text(`ERROR: remote file is ${formatBytes(declared)}, over the ${formatBytes(MAX_DOWNLOAD)} limit`, true);
        }

        const tmp = `${dest}.part`;
        let written = 0;
        try {
          const source = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
          const counter = async function* (src: AsyncIterable<Buffer>) {
            for await (const chunk of src) {
              written += chunk.length;
              if (written > MAX_DOWNLOAD) throw new Error(`download exceeded ${formatBytes(MAX_DOWNLOAD)}`);
              yield chunk;
            }
          };
          await pipeline(source, counter, fs.createWriteStream(tmp));
          await fsp.rename(tmp, dest);
        } catch (err) {
          await fsp.rm(tmp, { force: true });
          return text(`ERROR: download failed: ${(err as Error).message}`, true);
        }

        const finalUrl = res.url && res.url !== url ? `\nfinal URL (after redirects): ${res.url}` : "";
        const type = res.headers.get("content-type") ?? "unknown";
        return text(
          `Downloaded ${written} bytes to ${dest}\ncontent-type: ${type}${finalUrl}` +
            `\nNote: downloaded files are not executable yet - chmod +x via run_command if needed.`,
        );
      }),
  );

  server.registerTool(
    "search_files",
    {
      title: "Search files",
      description:
        "Search this Mac for files by name (substring or * glob) and/or by text inside files. " +
        "Skips heavy/irrelevant trees (node_modules, .git, caches, ~/Library) and returns partial results if it hits its time budget.",
      inputSchema: {
        query: z.string().min(1).describe("Text to find, or a glob like *.log or report-*.pdf"),
        root: z.string().optional().describe("Directory to search (default: home directory)"),
        mode: z
          .enum(["name", "content", "both"])
          .optional()
          .describe("name = match file names, content = grep file contents, both (default)"),
        caseSensitive: z.boolean().optional().describe("Default false"),
        maxResults: z.number().int().positive().max(SEARCH_MAX_RESULTS_CAP).optional().describe("Default 50"),
        includeSystem: z
          .boolean()
          .optional()
          .describe("Also search ~/Library and other skipped system trees (default false)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, root, mode, caseSensitive, maxResults, includeSystem }) =>
      audited("search_files", { query, root, mode, caseSensitive, maxResults, includeSystem }, async () => {
        const start = Date.now();
        const searchRoot = resolvePath(root ?? HOME);
        if (!fs.existsSync(searchRoot)) return text(`ERROR: no such directory: ${searchRoot}`, true);

        const wantName = mode === "name" || mode === "both" || mode === undefined;
        const wantContent = mode === "content" || mode === "both";
        const limit = Math.min(maxResults ?? 50, SEARCH_MAX_RESULTS_CAP);
        const matcher = nameMatcher(query, Boolean(caseSensitive));
        const contentNeedle = caseSensitive ? query : query.toLowerCase();

        const nameHits: string[] = [];
        const contentHits: string[] = [];
        let visited = 0;
        let truncatedByLimit = false;
        let timedOut = false;
        const stack: string[] = [searchRoot];

        while (stack.length > 0) {
          if (nameHits.length + contentHits.length >= limit) {
            truncatedByLimit = true;
            break;
          }
          if (visited >= SEARCH_VISIT_CAP || Date.now() - start > SEARCH_TIME_BUDGET_MS) {
            timedOut = true;
            break;
          }
          const dir = stack.pop()!;
          let handle: fs.Dir;
          try {
            handle = await fsp.opendir(dir);
          } catch {
            continue;
          }
          try {
            for (;;) {
              if (nameHits.length + contentHits.length >= limit) {
                truncatedByLimit = true;
                break;
              }
              if (visited >= SEARCH_VISIT_CAP || Date.now() - start > SEARCH_TIME_BUDGET_MS) {
                timedOut = true;
                break;
              }
              const entry = await handle.read();
              if (!entry) break;
              visited++;
              const full = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                if (!includeSystem && (SKIP_DIR_NAMES.has(entry.name) || full === path.join(HOME, "Library"))) continue;
                stack.push(full);
                continue;
              }
              if (!entry.isFile()) continue;

              if (wantName && (matcher.test(entry.name) || matcher.test(full))) {
                nameHits.push(full);
                continue;
              }
              if (!wantContent) continue;

              let stat: fs.Stats;
              try {
                stat = await fsp.stat(full);
              } catch {
                continue;
              }
              if (stat.size > 2 * 1024 * 1024) continue;
              let buf: Buffer;
              try {
                buf = await fsp.readFile(full);
              } catch {
                continue;
              }
              if (isProbablyBinary(buf)) continue;
              const lines = buf.toString("utf8").split("\n");
              let fileHits = 0;
              for (let i = 0; i < lines.length && fileHits < 3; i++) {
                const hay = caseSensitive ? lines[i] : lines[i].toLowerCase();
                if (hay.includes(contentNeedle)) {
                  contentHits.push(`${full}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
                  fileHits++;
                }
              }
            }
          } finally {
            try { await handle.close(); } catch { /* already closed */ }
          }
        }

        const parts: string[] = [];
        parts.push(`root: ${searchRoot}`);
        if (wantName) {
          parts.push(`\nname matches (${nameHits.length}${truncatedByLimit ? "+" : ""}):`);
          parts.push(...(nameHits.length ? nameHits.map((h) => `  ${h}`) : ["  (none)"]));
        }
        if (wantContent) {
          parts.push(`\ncontent matches (${contentHits.length}${truncatedByLimit ? "+" : ""}):`);
          parts.push(...(contentHits.length ? contentHits.map((h) => `  ${h}`) : ["  (none)"]));
        }
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        const notes: string[] = [];
        if (truncatedByLimit) notes.push(`result limit reached (${limit}) - narrow the query`);
        if (timedOut) notes.push("time budget reached (20s) - search the results above or pass a tighter root");
        if (notes.length) parts.push(`\nnote: ${notes.join("; ")}`);
        parts.push(`scanned ${visited} entries in ${elapsed}s`);
        return text(parts.join("\n"));
      }),
  );

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description:
        "Read a text file (with line offset/limit) or return an image as an image so it can be viewed. " +
        "Binary files return their metadata instead.",
      inputSchema: {
        path: z.string().describe("File path (~ or absolute, relative paths resolve to the server cwd)"),
        offset: z.number().int().positive().optional().describe("1-based line number to start at (default 1)"),
        limit: z.number().int().positive().max(20_000).optional().describe("Max lines to return (default 2000)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path: filePath, offset, limit }) =>
      audited("read_file", { path: filePath, offset, limit }, async () => {
        const full = resolvePath(filePath);
        let stat: fs.Stats;
        try {
          stat = await fsp.stat(full);
        } catch {
          return text(`ERROR: cannot read ${full} (missing or no permission)`, true);
        }
        if (stat.isDirectory()) return text(`ERROR: ${full} is a directory - use list_directory`, true);

        const ext = path.extname(full).slice(1).toLowerCase();
        if (IMAGE_EXT.has(ext)) {
          if (stat.size > MAX_IMAGE) {
            return text(`ERROR: image is ${formatBytes(stat.size)}, over the ${formatBytes(MAX_IMAGE)} view limit`, true);
          }
          const buf = await fsp.readFile(full);
          return {
            content: [
              { type: "text", text: `${full} - image, ${formatBytes(stat.size)}` },
              { type: "image", data: buf.toString("base64"), mimeType: mimeFor(ext) },
            ],
          };
        }

        // Probe only a tiny prefix for binary data, then stream requested lines.
        const probeHandle = await fsp.open(full, "r");
        try {
          const probeSize = Math.min(stat.size, 8192);
          const probe = Buffer.alloc(probeSize);
          if (probeSize) await probeHandle.read(probe, 0, probeSize, 0);
          if (isProbablyBinary(probe)) {
            return text(
              full + " - binary file, " + formatBytes(stat.size) + " (ext ." + (ext || "none") + "). " +
                "Inspect it with run_command or file(1).",
            );
          }
        } finally {
          await probeHandle.close();
        }

        const startLine = offset ?? 1;
        const lineLimit = limit ?? 2000;
        const slice = await readTextLines(full, startLine, lineLimit, MAX_READ);
        if (!slice.rows.length && slice.linesSeen < startLine) {
          return text(
            full + " - requested line " + startLine + " is past EOF (file has " + slice.linesSeen + " line(s), " + formatBytes(stat.size) + ")",
          );
        }
        const notes: string[] = [];
        if (slice.hasMore) notes.push("more lines available; raise offset");
        if (slice.capped) notes.push("response capped at " + formatBytes(MAX_READ));
        const total = slice.hasMore ? "" : " of " + slice.linesSeen;
        const header =
          full + " - lines " + slice.startLine + "-" + slice.endLine + total + " - " + formatBytes(stat.size) +
          (notes.length ? " (" + notes.join("; ") + ")" : "");
        return text(header + "\n" + slice.rows.join("\n"));
      }),
  );

  server.registerTool(
    "list_directory",
    {
      title: "List directory",
      description: "List a directory's entries (type, size, modified time). Directories first, hidden files included.",
      inputSchema: {
        path: z.string().optional().describe("Directory path (default: home directory)"),
        maxEntries: z.number().int().positive().max(5000).optional().describe("Cap entries returned (default 2000)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path: dirPath, maxEntries }) =>
      audited("list_directory", { path: dirPath, maxEntries }, async () => {
        const full = resolvePath(dirPath ?? HOME);
        const cap = Math.min(maxEntries ?? 2000, 5000);
        const scanCap = Math.min(100_000, Math.max(10_000, cap * 10));
        const entries: fs.Dirent[] = [];
        let scanCapped = false;
        try {
          const dir = await fsp.opendir(full);
          for await (const entry of dir) {
            entries.push(entry);
            if (entries.length >= scanCap) {
              scanCapped = true;
              break;
            }
          }
        } catch (err) {
          return text(`ERROR: cannot list ${full}: ${(err as Error).message}`, true);
        }
        // Sort only the bounded sample, then stat only entries that will be returned.
        entries.sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        const selected = entries.slice(0, cap);
        const shown: Array<{ kind: string; size: number; mtime: string; name: string }> = [];
        const statBatch = 64;
        for (let i = 0; i < selected.length; i += statBatch) {
          const batch = await Promise.all(
            selected.slice(i, i + statBatch).map(async (entry) => {
              let size = 0;
              let mtime = "";
              try {
                const st = await fsp.stat(path.join(full, entry.name));
                size = st.size;
                mtime = st.mtime.toISOString();
              } catch {
                /* broken symlink or no permission */
              }
              const kind = entry.isDirectory() ? "dir " : entry.isSymbolicLink() ? "link" : "file";
              return { kind, size, mtime, name: entry.name };
            }),
          );
          shown.push(...batch);
        }
        const lines = shown.map(
          (r) =>
            `${r.kind}  ${r.kind === "dir" ? "-" : formatBytes(r.size).padStart(9)}  ` +
            `${r.mtime.replace("T", " ").slice(0, 19)}  ${r.name}${r.kind === "dir" ? "/" : ""}`,
        );
        const note = scanCapped
          ? `\n... directory scan capped at ${scanCap} entries; use a tighter path for exhaustive listing`
          : entries.length > cap
            ? `\n... ${entries.length - cap} more entries (raise maxEntries)`
            : "";
        const dirCount = entries.filter((entry) => entry.isDirectory()).length;
        const countLabel = scanCapped ? `${entries.length}+ scanned entries` : `${entries.length} entries`;
        return text(
          `${full}  (${countLabel}, ${dirCount}${scanCapped ? "+" : ""} directories in scanned set)\n\n` +
            `type       size        modified              name\n` +
            lines.join("\n") +
            note,
        );
      }),
  );

  // --- Pages (native, via Apple Events) -------------------------------------
  // No Word, no docx, no converters: these drive the real Pages app, so the
  // output is a normal .pages file the user can keep editing by hand.
  const PAGE_BLOCK_TYPES = [
    "title",
    "subtitle",
    "h1",
    "h2",
    "h3",
    "body",
    "bullet",
    "numbered",
    "quote",
    "caption",
    "code",
    "spacer",
    "table",
  ] as const;

  const pageTable = z
    .object({
      header: z
        .array(z.string())
        .optional()
        .describe("Header row labels. Supplying them creates a real header row (bold, tinted, repeated across pages)."),
      rows: z.array(z.array(z.string())).describe("Body rows. Every row must have the same number of cells."),
      headerColumn: z.boolean().optional().describe("Also treat the first column as a header column (bold, tinted)."),
      align: z
        .array(z.enum(["left", "center", "right"]))
        .optional()
        .describe("Per-column horizontal alignment, left to right."),
      columnWidths: z.array(z.number()).optional().describe("Per-column width in points."),
      zebra: z.boolean().optional().describe("Tint every other body row."),
    })
    .describe("A real Pages table.");

  const pageBlocks = z
    .array(
      z.object({
        type: z
          .enum(PAGE_BLOCK_TYPES)
          .describe("Block kind. It decides the font/size/color applied to that paragraph, or builds a table."),
        text: z.string().optional().describe("Paragraph text. Omit or pass '' for a blank line."),
        table: pageTable.optional().describe("Required when type is 'table'. Tables must be the last blocks."),
      }),
    )
    .describe(
      "Content in reading order, one block per paragraph. A 'table' block creates a real table " +
        "and must come last, because Pages cannot insert an inline table mid-flow.",
    );

  server.registerTool(
    "pages_status",
    {
      title: "Pages status",
      description:
        "Diagnose the Pages integration: where the app is, whether it is running, whether macOS has granted " +
        "automation permission, which documents are open, and (optionally) the available template names. " +
        "Call this first if a Pages tool fails with a permission error.",
      inputSchema: {
        includeTemplates: z
          .boolean()
          .optional()
          .describe("Also list template names usable with pages_create (slower - loads the template library)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ includeTemplates }) =>
      audited("pages_status", { includeTemplates }, async () => {
        const r = await pagesStatus({ includeTemplates });
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "pages_create",
    {
      title: "Create Pages document",
      description:
        "Create a real .pages document from structured blocks and save it to disk. Works natively in Pages - " +
        "no Word, no docx, no conversion step. Use `format: 'styled'` (default) for a clean typographic " +
        "hierarchy driven by the block types, or `plain` to keep the chosen template's own paragraph styles. " +
        "`style` picks the type scale and palette (classic, serif, modern, compact) or overrides any of its " +
        "parts. `table` blocks become real Pages tables with header rows, fills and column alignment. " +
        "The document is saved and left open in Pages; this server never closes documents or quits Pages. " +
        "Returns the saved path.",
      inputSchema: {
        path: z.string().describe("Destination path ending in .pages (~ allowed). Parent folders are created."),
        blocks: pageBlocks,
        template: z
          .string()
          .optional()
          .describe("Pages template name (e.g. 'Essay', 'Report'). Use pages_status to list valid names."),
        format: z
          .enum(["styled", "plain"])
          .optional()
          .describe("styled = apply the block typography (default for blank docs); plain = keep template styles."),
        style: z
          .union([
            z.enum(["classic", "serif", "modern", "compact"]),
            z.object({
              preset: z.enum(["classic", "serif", "modern", "compact"]).optional(),
              family: z
                .enum(["helvetica-neue", "georgia", "avenir-next", "palatino", "times"])
                .optional()
                .describe("Font family override."),
              baseSize: z.number().optional().describe("Body size in points; every other size scales from it."),
              accent: z.string().optional().describe("Title colour, #RRGGBB."),
              muted: z.string().optional().describe("Caption/quote colour, #RRGGBB."),
              headerFill: z.string().optional().describe("Table header fill, #RRGGBB."),
              headerText: z.string().optional().describe("Table header text colour, #RRGGBB."),
              zebra: z.string().optional().describe("Alternating row tint, #RRGGBB."),
            }),
          ])
          .optional()
          .describe("Style preset name, or an object of overrides. Default 'classic'."),
        overwrite: z.boolean().optional().describe("Replace an existing file (default false)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ path: destPath, blocks, template, format, style, overwrite }) =>
      audited("pages_create", { path: destPath, blocks: blocks.length, template, format, style, overwrite }, async () => {
        const r = await pagesCreate({
          path: destPath,
          blocks: blocks as PageBlock[],
          template,
          format,
          style,
          overwrite,
        });
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "pages_read",
    {
      title: "Read Pages document",
      description:
        "Read a .pages document: full text plus an outline showing each paragraph's index, point size and font, " +
        "so you can see the structure before editing it. Opens the file in Pages if it is not already open; " +
        "documents are never closed afterwards.",
      inputSchema: {
        path: z.string().optional().describe("Path to the .pages file. Omit to read the frontmost open document."),
        maxParagraphs: z
          .number()
          .int()
          .positive()
          .max(2000)
          .optional()
          .describe("Cap on paragraphs returned (default 400)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path: filePath, maxParagraphs }) =>
      audited("pages_read", { path: filePath, maxParagraphs }, async () => {
        const r = await pagesRead({ path: filePath, maxParagraphs });
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "pages_inspect",
    {
      title: "Inspect Pages formatting",
      description:
        "Report how a .pages document is actually formatted before you change it: every paragraph's point size, " +
        "PostScript face, bold/italic flags and colour, plus each table's dimensions, header rows, header fill, " +
        "the faces in use and a header-marked cell grid. Use this to decide what to edit; pages_read is the " +
        "lighter text-only view.",
      inputSchema: {
        path: z.string().optional().describe("Path to the .pages file. Omit to inspect the frontmost document."),
        maxParagraphs: z.number().int().positive().max(2000).optional().describe("Cap on paragraphs (default 200)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path: filePath, maxParagraphs }) =>
      audited("pages_inspect", { path: filePath, maxParagraphs }, async () => {
        const r = await pagesInspect({ path: filePath, maxParagraphs });
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "pages_verify",
    {
      title: "Verify Pages document",
      description:
        "Run a full integrity check on a .pages document - the tool for confirming that a long document (20+ " +
        "pages) survived an edit. Reports paragraph, word and character counts, the typography actually in use, " +
        "table structure, and flags problems: implausible point sizes, missing fonts, empty or ragged tables, " +
        "runs of blank paragraphs, and merged cells that cannot be addressed directly. Pass expectParagraphs / " +
        "expectTables to assert an exact structure. Reads the whole document in a handful of Apple Events, so " +
        "it stays fast on long files.",
      inputSchema: {
        path: z.string().optional().describe("Path to the .pages file. Omit to check the frontmost document."),
        maxParagraphs: z
          .number()
          .int()
          .positive()
          .max(5000)
          .optional()
          .describe("Cap on paragraphs scanned (default 5000, effectively all)."),
        expectParagraphs: z.number().int().positive().optional().describe("Report a problem if the count differs."),
        expectTables: z.number().int().min(0).optional().describe("Report a problem if the table count differs."),
        maxIssues: z.number().int().positive().max(200).optional().describe("Cap on reported items (default 20)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      audited("pages_verify", args, async () => {
        const r = await pagesVerify(args);
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "pages_styles",
    {
      title: "Pages default styles",
      description:
        "Inspect and edit the style defaults. `list` shows presets and font families; `get` shows the stored " +
        "default plus the resolved type scale (every role's face, size and colour); `set` persists a new " +
        "default that pages_create uses when no style is passed; `apply` restyles an existing document in " +
        "place - it infers each paragraph's role from its size relative to the body size and rewrites font, " +
        "size and colour, leaving the text alone.",
      inputSchema: {
        action: z.enum(["list", "get", "set", "apply"]).describe("What to do with the style defaults."),
        path: z.string().optional().describe("action=apply: the .pages file to restyle."),
        style: z
          .union([
            z.enum(["classic", "serif", "modern", "compact"]),
            z.object({
              preset: z.enum(["classic", "serif", "modern", "compact"]).optional(),
              family: z.enum(["helvetica-neue", "georgia", "avenir-next", "palatino", "times"]).optional(),
              baseSize: z.number().optional().describe("Body size in points; every other size scales from it."),
              accent: z.string().optional().describe("#RRGGBB"),
              muted: z.string().optional().describe("#RRGGBB"),
              headerFill: z.string().optional().describe("#RRGGBB"),
              headerText: z.string().optional().describe("#RRGGBB"),
              zebra: z.string().optional().describe("#RRGGBB"),
            }),
          ])
          .optional()
          .describe("action=set/apply: preset name or override object."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ action, path: filePath, style }) =>
      audited("pages_styles", { action, path: filePath, style }, async () => {
        const r = await pagesStyles({ action, path: filePath, style });
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "pages_replace",
    {
      title: "Replace text in Pages",
      description:
        "Find and replace text with an explicit scope, so a change can be aimed at one paragraph, one table " +
        "cell, a row, a column, a whole table, or the whole document. " +
        "`keepFormat: true` (default) restores the paragraph's own face/size/colour after the rewrite; " +
        "`keepFormat: false` lets the paragraph's style default take over. Table cells keep their formatting " +
        "either way, because only the cell value is set. `all: false` replaces just the first hit per unit.",
      inputSchema: {
        path: z.string().describe("Path to the .pages file."),
        find: z.string().min(1).describe("Text to search for."),
        replace: z.string().optional().describe("Replacement text (default: empty, i.e. delete)."),
        scope: z
          .enum(["document", "paragraph", "table", "row", "column", "cell"])
          .optional()
          .describe("Where to look. Default 'document' (all paragraphs and all table cells)."),
        paragraph: z.number().int().positive().optional().describe("scope=paragraph: 1-based paragraph index."),
        table: z.number().int().positive().optional().describe("scope=table/row/column/cell: table index (default 1)."),
        row: z.number().int().positive().optional().describe("scope=row/cell: 1-based row."),
        col: z.number().int().positive().optional().describe("scope=column/cell: 1-based column."),
        all: z.boolean().optional().describe("Replace every occurrence (default true)."),
        keepFormat: z.boolean().optional().describe("Reapply the paragraph's own formatting (default true)."),
        save: z.boolean().optional().describe("Save after editing (default true)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      audited("pages_replace", args, async () => {
        const r = await pagesReplace(args);
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "pages_edit",
    {
      title: "Edit Pages text",
      description:
        "Edit the words and paragraph structure of an existing .pages document natively, keeping the document's " +
        "formatting. Ops: `append` adds blocks at the end (safest, never touches existing paragraphs); " +
        "`prepend` adds blocks at the top; `insertParagraph` splices blocks before/after an existing paragraph; " +
        "`replaceParagraph` rewrites a paragraph range and keeps its formatting unless you pass blocks plus " +
        "format='styled'; `insertText` and `deleteText` do character-level surgery inside one paragraph; " +
        "`splitParagraph`, `mergeParagraphs`, `duplicateParagraph`, `moveParagraph` (reorder), " +
        "`deleteParagraph`, and `setBody` (replace the whole body). " +
        "Block-driven ops take `blocks` (title/subtitle/h1/h2/h3/body/bullet/numbered/quote/caption/code/spacer/table). " +
        "Run pages_inspect first to see paragraph indices and current formatting. " +
        "Find-and-replace lives in pages_replace, typography in pages_format, tables in pages_table.",
      inputSchema: {
        path: z.string().describe("Path to the .pages file to modify."),
        op: z
          .enum([
            "append",
            "prepend",
            "setBody",
            "insertParagraph",
            "replaceParagraph",
            "insertText",
            "deleteText",
            "splitParagraph",
            "mergeParagraphs",
            "duplicateParagraph",
            "moveParagraph",
            "deleteParagraph",
          ])
          .describe("Operation to perform."),
        blocks: pageBlocks
          .optional()
          .describe("append/prepend/setBody/insertParagraph/replaceParagraph: content to write."),
        text: z
          .string()
          .optional()
          .describe("insertText/replaceParagraph: raw text. A newline starts a new paragraph."),
        anchor: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("insertParagraph: 1-based paragraph to insert next to."),
        position: z
          .enum(["before", "after"])
          .optional()
          .describe("insertParagraph/duplicateParagraph: which side of the anchor (default 'after')."),
        paragraph: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("insertText/deleteText/splitParagraph/duplicateParagraph: 1-based paragraph index."),
        from: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("deleteParagraph/mergeParagraphs/moveParagraph/replaceParagraph: first paragraph (1-based)."),
        to: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("deleteParagraph/mergeParagraphs/moveParagraph/replaceParagraph: last paragraph (inclusive)."),
        after: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("moveParagraph: place the block after this paragraph index; 0 moves it to the top."),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "insertText: character position to insert before (0 or omitted = append at the end). " +
              "splitParagraph: character where the new paragraph starts (>= 2).",
          ),
        charFrom: z.number().int().positive().optional().describe("deleteText: first character to remove (1-based)."),
        charTo: z.number().int().positive().optional().describe("deleteText: last character to remove (inclusive)."),
        separator: z
          .string()
          .optional()
          .describe("mergeParagraphs: text placed between the joined paragraphs (default a single space)."),
        format: z
          .enum(["styled", "plain"])
          .optional()
          .describe("Block-driven ops: 'styled' applies block typography, 'plain' keeps the document's own style."),
        style: z
          .union([
            z.enum(["classic", "serif", "modern", "compact"]),
            z.object({
              preset: z.enum(["classic", "serif", "modern", "compact"]).optional(),
              family: z.enum(["helvetica-neue", "georgia", "avenir-next", "palatino", "times"]).optional(),
              baseSize: z.number().optional(),
              accent: z.string().optional(),
              muted: z.string().optional(),
              headerFill: z.string().optional(),
              headerText: z.string().optional(),
              zebra: z.string().optional(),
            }),
          ])
          .optional()
          .describe("Block-driven ops: style preset or overrides for the new content."),
        save: z.boolean().optional().describe("Save after editing (default true)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      audited("pages_edit", { ...args, blocks: args.blocks?.length }, async () => {
        const r = await pagesEdit({ ...args, blocks: args.blocks as PageBlock[] | undefined });
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "pages_format",
    {
      title: "Format Pages text",
      description:
        "Change typography and colour in a .pages document without touching the words. Ops: " +
        "`paragraphs` restyles whole paragraphs (default); `characters` formats a character range inside each " +
        "paragraph, so you can bold one phrase; `matches` formats every occurrence of a string, which is how you " +
        "highlight a term everywhere at once. Pass any combination of bold, italic, font, size and color. " +
        "Bold and italic work by swapping the face inside the paragraph's own family, so a Georgia heading stays " +
        "Georgia. Note: Pages' scripting dictionary exposes no paragraph alignment, line spacing or text " +
        "highlight for body text - only font, size and colour are scriptable there.",
      inputSchema: {
        path: z.string().describe("Path to the .pages file to modify."),
        op: z
          .enum(["paragraphs", "characters", "matches"])
          .optional()
          .describe("What to format. Default 'paragraphs'."),
        from: z.number().int().positive().optional().describe("First paragraph (1-based, default 1)."),
        to: z.number().int().positive().optional().describe("Last paragraph (inclusive, default = from)."),
        paragraph: z.number().int().positive().optional().describe("Alias for `from` when formatting one paragraph."),
        charFrom: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("op=characters: first character of the range (1-based, default 1)."),
        charTo: z.number().int().positive().optional().describe("op=characters: last character of the range."),
        find: z.string().min(1).optional().describe("op=matches: the text to format."),
        all: z.boolean().optional().describe("op=matches: format every occurrence (default true)."),
        bold: z.boolean().optional().describe("Toggle bold within the paragraph's existing family."),
        italic: z.boolean().optional().describe("Toggle italic within the paragraph's existing family."),
        font: z.string().optional().describe("Explicit PostScript face, e.g. 'Georgia-Bold'. Overrides bold/italic."),
        size: z.number().optional().describe("Point size."),
        color: z.string().optional().describe("Text colour, #RRGGBB."),
        save: z.boolean().optional().describe("Save after editing (default true)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      audited("pages_format", args, async () => {
        const r = await pagesFormat(args);
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "pages_table",
    {
      title: "Edit Pages table",
      description:
        "Read and change a real table inside a .pages document. Ops: `setCell` writes one cell's value and/or " +
        "font, size, colour, fill or alignment (the cell's own typography is restored around the write, so a " +
        "value edit does not reset the look); `setCells` writes a rectangular grid of values at once; " +
        "`format` styles a rectangle or the whole table (header rows/columns, footer rows, fill, alignment, " +
        "vertical alignment, wrap, column widths, row heights); `insertRows` / `deleteRows` / `insertColumns` / " +
        "`deleteColumns` change the grid; `merge` / `unmerge` combine cells; `sort` reorders rows by a column; " +
        "`clear` empties a range including formatting; `resize` sets the row and column counts. " +
        "Inserting or deleting rows shifts values, not cell formatting - the cell keeps its own styling. " +
        "Set a cell value starting with '=' to write a formula.",
      inputSchema: {
        path: z.string().describe("Path to the .pages file to modify."),
        op: z
          .enum([
            "setCell",
            "setCells",
            "format",
            "insertRows",
            "deleteRows",
            "insertColumns",
            "deleteColumns",
            "merge",
            "unmerge",
            "sort",
            "clear",
            "resize",
          ])
          .describe("Operation to perform."),
        table: z.number().int().positive().optional().describe("Table index (1-based, default 1)."),
        row: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-based row: the cell, the first row of a rectangle, or the row to delete."),
        col: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-based column: the cell, the first column of a rectangle, or the column to delete."),
        rows: z.number().int().positive().optional().describe("Rectangle height in rows (default 1)."),
        cols: z.number().int().positive().optional().describe("Rectangle width in columns (default 1)."),
        value: z.string().optional().describe("op=setCell: new cell text. Start with '=' for a formula."),
        values: z
          .array(z.array(z.string()))
          .optional()
          .describe("op=setCells: 2D grid of values written from row/col, one inner array per row."),
        count: z.number().int().positive().optional().describe("insert/delete ops: how many rows or columns (default 1)."),
        at: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("insertRows/insertColumns: insert before this index (default: at the end)."),
        by: z.number().int().positive().optional().describe("op=sort: the column to sort by (1-based)."),
        direction: z.enum(["ascending", "descending"]).optional().describe("op=sort: sort direction."),
        font: z.string().optional().describe("PostScript face, e.g. 'HelveticaNeue-Bold'."),
        size: z.number().optional().describe("Point size."),
        color: z.string().optional().describe("Text colour, #RRGGBB."),
        fill: z.string().optional().describe("Cell background, #RRGGBB."),
        bold: z.boolean().optional().describe("Toggle bold within the table's existing family."),
        italic: z.boolean().optional().describe("Toggle italic within the table's existing family."),
        align: z.enum(["left", "center", "right"]).optional().describe("Horizontal alignment."),
        verticalAlign: z.enum(["top", "center", "bottom"]).optional().describe("Vertical alignment."),
        wrap: z.boolean().optional().describe("Whether text wraps in the cell."),
        headerRows: z.number().int().min(0).optional().describe("Number of header rows."),
        headerCols: z.number().int().min(0).optional().describe("Number of header columns."),
        footerRows: z.number().int().min(0).optional().describe("Number of footer rows."),
        columnWidths: z.array(z.number()).optional().describe("Per-column widths in points, from column 1."),
        rowHeights: z.array(z.number()).optional().describe("Per-row heights in points, from row 1."),
        save: z.boolean().optional().describe("Save after editing (default true)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      audited("pages_table", args, async () => {
        const r = await pagesTable(args);
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "pages_export",
    {
      title: "Export Pages document",
      description:
        "Export a .pages document with Pages' own exporter to PDF, plain text, RTF, EPUB or Word. " +
        "Nothing is converted through an external tool - this is Pages' built-in export.",
      inputSchema: {
        path: z.string().describe("Path to the .pages file."),
        format: z.enum(["pdf", "txt", "rtf", "epub", "docx"]).describe("Target format."),
        destPath: z.string().optional().describe("Output path (default: alongside the source, same base name)."),
        overwrite: z.boolean().optional().describe("Replace an existing output file (default false)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ path: srcPath, format, destPath, overwrite }) =>
      audited("pages_export", { path: srcPath, format, destPath, overwrite }, async () => {
        const r = await pagesExport({ path: srcPath, format, destPath, overwrite });
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "pages_find",
    {
      title: "Find text in Pages",
      description:
        "Search a .pages document's paragraphs and table cells and report where each match lives (paragraph " +
        "number, or table/row/column), with a short snippet. Use it to locate something before editing it. " +
        "Case-insensitive by default. For actually changing the text use pages_replace.",
      inputSchema: {
        path: z.string().optional().describe("Path to the .pages file. Omit to search the frontmost document."),
        query: z.string().min(1).describe("Text to search for."),
        caseSensitive: z.boolean().optional().describe("Match case exactly (default false)."),
        maxResults: z.number().int().positive().max(500).optional().describe("Cap on matches returned (default 50)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      audited("pages_find", args, async () => {
        const r = await pagesFind(args);
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "pages_stats",
    {
      title: "Pages document stats",
      description:
        "Summarise a .pages document: page count, sections, paragraphs, words, characters, tables and cell " +
        "counts, plus how many images, text boxes and shapes it holds. Useful for a quick overview or to check " +
        "a document after a big edit.",
      inputSchema: {
        path: z.string().optional().describe("Path to the .pages file. Omit to use the frontmost document."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path: filePath }) =>
      audited("pages_stats", { path: filePath }, async () => {
        const r = await pagesStats({ path: filePath });
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "pages_insert_image",
    {
      title: "Insert image into Pages",
      description:
        "Place an image file into a .pages document as a real Pages image object, optionally setting its size, " +
        "position, alt text and opacity. The document is saved and left open; nothing is closed.",
      inputSchema: {
        path: z.string().describe("Path to the .pages document."),
        imagePath: z.string().describe("Path to the image file (png, jpg, pdf, heic...)."),
        width: z.number().optional().describe("Width in points."),
        height: z.number().optional().describe("Height in points."),
        x: z.number().optional().describe("Horizontal position in points (needs y too)."),
        y: z.number().optional().describe("Vertical position in points (needs x too)."),
        description: z.string().optional().describe("Alt text for accessibility."),
        opacity: z.number().min(0).max(100).optional().describe("Opacity percentage."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      audited("pages_insert_image", args, async () => {
        const r = await pagesInsertImage(args);
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "pages_insert_textbox",
    {
      title: "Insert text box into Pages",
      description:
        "Add a floating text box to a .pages document, with optional position, size, font, size and colour. " +
        "Text boxes are the right tool for labels, pull quotes and captions that should not reflow with the " +
        "body text. The document is saved and left open.",
      inputSchema: {
        path: z.string().describe("Path to the .pages document."),
        text: z.string().min(1).describe("Text to put in the box."),
        x: z.number().optional().describe("Horizontal position in points (needs y too)."),
        y: z.number().optional().describe("Vertical position in points (needs x too)."),
        width: z.number().optional().describe("Box width in points."),
        height: z.number().optional().describe("Box height in points."),
        size: z.number().optional().describe("Font size in points."),
        font: z.string().optional().describe("PostScript face, e.g. 'Georgia-Bold'."),
        color: z.string().optional().describe("Text colour, #RRGGBB."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      audited("pages_insert_textbox", args, async () => {
        const r = await pagesInsertTextbox(args);
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "pages_objects",
    {
      title: "List or delete Pages objects",
      description:
        "List the floating objects in a .pages document (images, text boxes, shapes) with their index, size and " +
        "position, or delete one by kind and index. Use the listing to find the index first - deleting takes the " +
        "1-based index from that listing.",
      inputSchema: {
        path: z.string().describe("Path to the .pages document."),
        action: z.enum(["list", "delete"]).describe("List the objects, or delete one."),
        kind: z.enum(["image", "textbox", "shape"]).optional().describe("action=delete: which kind to remove."),
        index: z.number().int().positive().optional().describe("action=delete: 1-based index from the listing."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      audited("pages_objects", args, async () => {
        const r = await pagesObjects(args);
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "pages_duplicate",
    {
      title: "Duplicate Pages document",
      description:
        "Copy a .pages document to a new path by copying the package on disk - Pages is not involved at all, so " +
        "the original stays untouched and nothing is opened or closed. Use it to branch a document before making " +
        "large changes.",
      inputSchema: {
        path: z.string().describe("Source .pages file."),
        destPath: z.string().describe("Destination path ending in .pages."),
        overwrite: z.boolean().optional().describe("Replace the destination if it exists (default false)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      audited("pages_duplicate", args, async () => {
        const r = await pagesDuplicate(args);
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "pages_layout",
    {
      title: "Pages layout controls",
      description:
        "UI-backed layout commands for Pages Creator Studio features that its AppleScript dictionary does not expose reliably: page/section breaks, page numbers, paragraph alignment/indent, and object ordering/grouping/locking. " +
        "Uses semantic Accessibility menu items rather than coordinates. Pass dryRun=true to verify the command is present without changing the document.",
      inputSchema: {
        action: z.enum([
          "page_break",
          "section_break",
          "page_number",
          "align_left",
          "align_center",
          "align_right",
          "justify",
          "indent_increase",
          "indent_decrease",
          "bring_front",
          "send_back",
          "group",
          "ungroup",
          "lock",
          "unlock",
        ]).describe("Layout command to invoke on the current Pages selection/caret."),
        dryRun: z.boolean().optional().describe("Resolve the real Pages menu command but do not invoke it."),
        verify: z.boolean().optional().describe("After acting, verify an observable UI change when possible (default true)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      audited("pages_layout", args, async () => {
        const labels: Record<string, string> = {
          page_break: "Page Break",
          section_break: "Section Break",
          page_number: "Page Number",
          align_left: "Align Left",
          align_center: "Align Centre",
          align_right: "Align Right",
          justify: "Justify",
          indent_increase: "Increase Indent Level",
          indent_decrease: "Decrease Indent Level",
          bring_front: "Bring to Front",
          send_back: "Send to Back",
          group: "Group",
          ungroup: "Ungroup",
          lock: "Lock",
          unlock: "Unlock",
        };
        const label = labels[args.action];
        const r = await uiDo({
          app: "Pages Creator Studio",
          name: label,
          role: "AXMenuItem",
          action: "press",
          intent: label,
          dryRun: args.dryRun === true,
          verify: args.verify !== false,
          depth: 9,
          maxNodes: 1200,
        });
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "pages_text_layout",
    {
      title: "Pages text layout inspector",
      description:
        "Read or set the current Pages selection in Format > Text > Style using real Accessibility controls: font family/typeface/size, bold/italic/underline/strikethrough, paragraph alignment, paragraph spacing and line spacing. No coordinates. Use windowTitle to target one open document and dryRun to resolve controls without changing anything.",
      inputSchema: {
        action: z.enum(["get", "set"]),
        windowTitle: z.string().optional(),
        dryRun: z.boolean().optional(),
        font: z.string().optional(),
        typeface: z.string().optional(),
        size: z.number().positive().optional(),
        bold: z.boolean().optional(),
        italic: z.boolean().optional(),
        underline: z.boolean().optional(),
        strikethrough: z.boolean().optional(),
        align: z.enum(["left", "center", "right", "justify"]).optional(),
        beforeParagraph: z.string().optional().describe("Inspector value, for example 6 pt."),
        afterParagraph: z.string().optional().describe("Inspector value, for example 8 pt."),
        lineSpacing: z.string().optional().describe("Inspector value, for example 1.15."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => audited("pages_text_layout", args, async () => {
      const r = await pagesTextLayout(args);
      return text(r.message, !r.ok);
    }),
  );

  server.registerTool(
    "pages_document_layout",
    {
      title: "Pages document layout inspector",
      description:
        "Read or set Pages Document inspector controls that AppleScript does not expose reliably: paper size/orientation, headers/footers and their offsets, all four document margins, facing pages, hyphenation and ligatures. Margin and offset values may include units such as 1.5 cm or 42 pt.",
      inputSchema: {
        action: z.enum(["get", "set"]),
        windowTitle: z.string().optional(),
        dryRun: z.boolean().optional(),
        paperSize: z.string().optional(),
        orientation: z.enum(["portrait", "landscape"]).optional(),
        header: z.boolean().optional(),
        footer: z.boolean().optional(),
        headerDistance: z.string().optional(),
        footerDistance: z.string().optional(),
        topMargin: z.string().optional(),
        bottomMargin: z.string().optional(),
        leftMargin: z.string().optional(),
        rightMargin: z.string().optional(),
        facingPages: z.boolean().optional(),
        hyphenate: z.boolean().optional(),
        ligatures: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => audited("pages_document_layout", args, async () => {
      const r = await pagesDocumentLayout(args);
      return text(r.message, !r.ok);
    }),
  );

  server.registerTool(
    "pages_section_layout",
    {
      title: "Pages section layout and numbering",
      description:
        "Read or set the current section in the Pages Section inspector: hide header/footer on the first page, match the preceding section, number format, continue numbering or start a new sequence at an exact page number.",
      inputSchema: {
        action: z.enum(["get", "set"]),
        windowTitle: z.string().optional(),
        dryRun: z.boolean().optional(),
        hideFirstPageHeaderFooter: z.boolean().optional(),
        matchPreviousSection: z.boolean().optional(),
        numbering: z.enum(["continue", "start"]).optional(),
        startAt: z.number().int().min(0).optional(),
        numberFormat: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => audited("pages_section_layout", args, async () => {
      const r = await pagesSectionLayout(args);
      return text(r.message, !r.ok);
    }),
  );

  // --- cross-app iWork -------------------------------------------------------

  server.registerTool(
    "iwork_ui_control",
    {
      title: "Semantic iWork inspector control",
      description:
        "Coordinate-free long-tail control for Pages, Numbers and Keynote Creator Studio. Resolve a real Accessibility control by role/title/description/text and inspect, press, set, toggle or choose a pop-up option. Use app-specific structured tools first; use this for inspector controls the native scripting dictionaries do not expose. dryRun resolves the exact control without mutating it.",
      inputSchema: {
        app: z.enum(["pages", "numbers", "keynote"]),
        action: z.enum(["inspect", "press", "set", "toggle", "choose"]),
        role: z.string().optional().describe("Exact AX role, e.g. AXTextField, AXCheckBox, AXPopUpButton, AXMenuItem."),
        title: z.string().optional(),
        description: z.string().optional(),
        text: z.string().optional().describe("Substring match across title/description/value/identifier."),
        identifier: z.string().optional(),
        ancestorText: z.string().optional().describe("Require an ancestor container whose label contains this text."),
        windowTitle: z.string().optional().describe("Target one open document window by title."),
        index: z.number().int().min(0).optional().describe("0-based match index when several controls match."),
        allowDisabled: z.boolean().optional(),
        value: z.string().optional().describe("action=set: new AX value."),
        desired: z.boolean().optional().describe("action=toggle: target on/off state."),
        option: z.string().optional().describe("action=choose: exact menu option."),
        dryRun: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => audited("iwork_ui_control", args, async () => {
      const base = {
        app: args.app,
        role: args.role,
        title: args.title,
        description: args.description,
        text: args.text,
        identifier: args.identifier,
        ancestorText: args.ancestorText,
        windowTitle: args.windowTitle,
        index: args.index,
        allowDisabled: args.allowDisabled,
        dryRun: args.dryRun,
      };
      let r;
      if (args.action === "inspect") r = await semanticInspect(base);
      else if (args.action === "press") r = await semanticPress(base);
      else if (args.action === "set") {
        if (args.value === undefined) return text("ERROR: action=set needs value.", true);
        r = await semanticSet({ ...base, newValue: args.value });
      } else if (args.action === "toggle") {
        if (args.desired === undefined) return text("ERROR: action=toggle needs desired.", true);
        r = await semanticToggle({ ...base, desired: args.desired });
      } else {
        if (!args.option) return text("ERROR: action=choose needs option.", true);
        r = await semanticChoose({ ...base, option: args.option });
      }
      return text(r.message, !r.ok);
    }),
  );

  server.registerTool(
    "iwork_arrange",
    {
      title: "Arrange selected iWork objects",
      description:
        "Shared object-arrangement commands for Pages, Numbers and Keynote: layer ordering, six-way alignment, distribution, flips, lock/unlock and group/ungroup. Uses exact semantic menu items rather than coordinates and works on the current object selection.",
      inputSchema: {
        app: z.enum(["pages", "numbers", "keynote"]),
        action: z.enum(["bring_forward", "bring_front", "send_backward", "send_back", "align_left", "align_center", "align_right", "align_top", "align_middle", "align_bottom", "distribute_horizontal", "distribute_vertical", "distribute_evenly", "flip_horizontal", "flip_vertical", "lock", "unlock", "group", "ungroup"]),
        dryRun: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => audited("iwork_arrange", args, async () => {
      const r = await semanticArrange(args.app, args.action, args.dryRun === true);
      return text(r.message, !r.ok);
    }),
  );

  server.registerTool(
    "iwork_items",
    {
      title: "Native iWork items",
      description:
        "List, add, format or delete native iWork items across Pages, Numbers and Keynote. Supports shapes, text items, images, tables, charts, movies, lines and groups with exact position/size/rotation/opacity/lock state; addText/addImage also support typography and image accessibility descriptions. Use sheet for Numbers and slide for Keynote.",
      inputSchema: {
        app: z.enum(["pages", "numbers", "keynote"]).optional(),
        path: z.string().describe("Path to the Pages/Numbers/Keynote document."),
        action: z.enum(["list", "format", "delete", "addText", "addImage"]),
        kind: z.enum(["shape", "text", "image", "table", "chart", "movie", "line", "group"]).optional(),
        slide: z.number().int().positive().optional(),
        sheet: z.number().int().positive().optional(),
        index: z.number().int().positive().optional(),
        text: z.string().optional(),
        imagePath: z.string().optional(),
        description: z.string().optional().describe("Image accessibility description where supported."),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
        rotation: z.number().min(0).max(359).optional(),
        opacity: z.number().min(0).max(100).optional(),
        locked: z.boolean().optional(),
        font: z.string().optional(),
        size: z.number().positive().optional(),
        color: z.string().optional().describe("#RRGGBB for text."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => audited("iwork_items", args, async () => {
      const r = await iworkItems(args);
      return text(r.message, !r.ok);
    }),
  );

  server.registerTool(
    "iwork_apps",
    {
      title: "iWork apps and open documents",
      description:
        "Report which iWork apps are installed and running (Pages, Numbers, Keynote), their versions, and every " +
        "document each one currently has open. Only queries apps that are already running, so calling this never " +
        "launches anything. Start here when you do not know which app owns a file.",
      inputSchema: {
        includeDocuments: z.boolean().optional().describe("List open documents too (default true)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      audited("iwork_apps", args, async () => {
        const r = await iworkApps(args);
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "iwork_document",
    {
      title: "iWork document overview",
      description:
        "Summarise any Pages, Numbers or Keynote document: name, path, and counts of paragraphs, pages, sections, " +
        "sheets, slides, tables, shapes, images, text boxes, charts, movies and lines. Pass `path` and the app is " +
        "inferred from the extension; pass `app` to use the frontmost document.",
      inputSchema: {
        path: z.string().optional().describe("Document path (.pages, .numbers or .key)."),
        app: z.enum(["pages", "numbers", "keynote"]).optional().describe("Which app, when no path is given."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      audited("iwork_document", args, async () => {
        const r = await iworkDocument(args);
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "iwork_shapes",
    {
      title: "iWork shapes",
      description:
        "List, add, restyle or delete shapes in Pages, Numbers or Keynote. `list` reports each shape's index, " +
        "size, position, rotation, opacity, locked state and text. `add` creates a shape (optionally with text " +
        "and typography). `format` moves, resizes, rotates, recolours or relabels an existing shape by index. " +
        "`delete` removes one. In Keynote pass `slide`, in Numbers pass `sheet` - that is the container the " +
        "shapes live in.",
      inputSchema: {
        path: z.string().optional().describe("Document path; the app is inferred from the extension."),
        app: z.enum(["pages", "numbers", "keynote"]).optional().describe("Which app, when no path is given."),
        action: z.enum(["list", "add", "format", "delete"]).describe("What to do."),
        slide: z.number().int().positive().optional().describe("Keynote: 1-based slide (default 1)."),
        sheet: z.number().int().positive().optional().describe("Numbers: 1-based sheet (default 1)."),
        index: z.number().int().positive().optional().describe("format/delete: 1-based shape index from `list`."),
        text: z.string().optional().describe("Shape text (add/format)."),
        x: z.number().optional().describe("Left position in points."),
        y: z.number().optional().describe("Top position in points."),
        width: z.number().optional().describe("Width in points."),
        height: z.number().optional().describe("Height in points."),
        rotation: z.number().optional().describe("Rotation in degrees (0-359)."),
        opacity: z.number().min(0).max(100).optional().describe("Opacity percentage."),
        locked: z.boolean().optional().describe("Lock the shape against accidental moves."),
        font: z.string().optional().describe("PostScript face for the shape's text."),
        size: z.number().optional().describe("Point size for the shape's text."),
        color: z.string().optional().describe("Text colour, #RRGGBB."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      audited("iwork_shapes", args, async () => {
        const r = await iworkShapes(args);
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "iwork_export",
    {
      title: "Export any iWork document",
      description:
        "Export a Pages, Numbers or Keynote document with that app's own exporter. Formats depend on the app: " +
        "Pages -> pdf/txt/rtf/epub/docx, Numbers -> pdf/xlsx/csv, Keynote -> pdf/pptx/html/movie/images. " +
        "Nothing is converted through an external tool. The source document is never modified.",
      inputSchema: {
        path: z.string().describe("Document path (.pages, .numbers or .key)."),
        format: z
          .enum(["pdf", "txt", "rtf", "epub", "docx", "xlsx", "csv", "pptx", "html", "movie", "images"])
          .describe("Target format; the error lists what the app supports if you pick the wrong one."),
        destPath: z.string().optional().describe("Output path (default: alongside the source, same base name)."),
        overwrite: z.boolean().optional().describe("Replace an existing output file (default false)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      audited("iwork_export", args, async () => {
        const r = await iworkExport(args);
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "iwork_script",
    {
      title: "Run AppleScript against an iWork app",
      description:
        "Escape hatch for anything the structured tools do not cover: runs your AppleScript inside the target " +
        "app with the document already bound to the variable `doc`. For example `return count of tables of doc`. " +
        "Scripts may not contain `close` or `quit` - this server never closes documents or quits apps. " +
        "Prefer the structured tools when they fit; use this for the long tail.",
      inputSchema: {
        app: z.enum(["pages", "numbers", "keynote"]).describe("Which app to talk to."),
        path: z.string().optional().describe("Document to bind as `doc`. Omit to use the frontmost document."),
        script: z.string().min(1).describe("AppleScript body, run inside `tell application` with `doc` bound."),
        timeoutSeconds: z.number().int().min(5).max(600).optional().describe("Timeout (default 120)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      audited("iwork_script", { ...args, script: args.script.slice(0, 80) }, async () => {
        const r = await iworkScript(args);
        return text(r.message, !r.ok);
      }),
  );

  // --- Numbers ---------------------------------------------------------------

  server.registerTool(
    "numbers_sheets",
    {
      title: "Numbers sheets",
      description:
        "List, add, delete, rename or activate sheets in a .numbers document. `list` shows each sheet's index, " +
        "name, table count and the first table's dimensions.",
      inputSchema: {
        path: z.string().describe("Path to the .numbers document."),
        action: z.enum(["list", "add", "delete", "rename", "activate"]).describe("What to do."),
        sheet: z.number().int().positive().optional().describe("1-based sheet index (delete/rename/activate)."),
        name: z.string().optional().describe("Sheet name (add/rename)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      audited("numbers_sheets", args, async () => {
        const r = await numbersSheets(args);
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "numbers_tables",
    {
      title: "Numbers tables",
      description:
        "Work with tables inside a .numbers document. `list` reports each table's index, name, size and header " +
        "counts. `add`/`delete`/`resize` change the table itself. `addRow`/`addColumn` use Numbers' native " +
        "insert commands (above/below, before/after), so data and formulas shift correctly. `deleteRow`/" +
        "`deleteColumn`, `transpose`, `sort`, `merge`/`unmerge` and `format` cover the rest.",
      inputSchema: {
        path: z.string().describe("Path to the .numbers document."),
        action: z
          .enum([
            "list",
            "add",
            "delete",
            "resize",
            "addRow",
            "addColumn",
            "deleteRow",
            "deleteColumn",
            "transpose",
            "sort",
            "merge",
            "unmerge",
            "format",
          ])
          .describe("What to do."),
        sheet: z.number().int().positive().optional().describe("1-based sheet (default 1)."),
        table: z.number().int().positive().optional().describe("1-based table on that sheet (default 1)."),
        row: z.number().int().positive().optional().describe("Row anchor for addRow/deleteRow."),
        col: z.number().int().positive().optional().describe("Column anchor for addColumn/deleteColumn."),
        rows: z.number().int().positive().optional().describe("add: row count. resize: target row count."),
        cols: z.number().int().positive().optional().describe("add: column count. resize: target column count."),
        position: z
          .enum(["above", "below", "before", "after"])
          .optional()
          .describe("addRow: above/below (default below). addColumn: before/after (default after)."),
        by: z.number().int().positive().optional().describe("sort: column to sort by."),
        direction: z.enum(["ascending", "descending"]).optional().describe("sort: direction."),
        range: z.string().optional().describe('A1 range like "A1:C10" (merge/unmerge/format).'),
        headerRows: z.number().int().min(0).optional().describe("format: number of header rows."),
        headerCols: z.number().int().min(0).optional().describe("format: number of header columns."),
        font: z.string().optional().describe("format: PostScript face."),
        size: z.number().optional().describe("format: point size."),
        color: z.string().optional().describe("format: text colour #RRGGBB."),
        fill: z.string().optional().describe("format: cell background #RRGGBB."),
        align: z.enum(["left", "center", "right"]).optional().describe("format: horizontal alignment."),
        columnWidths: z.array(z.number()).optional().describe("format: per-column widths in points."),
        rowHeights: z.array(z.number()).optional().describe("format: per-row heights in points."),
        footerRows: z.number().int().min(0).optional().describe("format: number of footer rows."),
        freezeHeaderRows: z.boolean().optional().describe("format: freeze or unfreeze header rows."),
        freezeHeaderCols: z.boolean().optional().describe("format: freeze or unfreeze header columns."),
        filtered: z.boolean().optional().describe("format: turn the table filtered state on/off."),
        textWrap: z.boolean().optional().describe("format: wrap text in the target range."),
        verticalAlign: z.enum(["top", "center", "bottom"]).optional().describe("format: vertical alignment."),
        cellFormat: z.enum(["automatic", "checkbox", "currency", "date and time", "fraction", "number", "percent", "pop up menu", "scientific", "slider", "stepper", "text", "duration", "rating", "numeral system"]).optional().describe("format: native Numbers data format/control type."),
        name: z.string().optional().describe("format: table name."),
        x: z.number().optional().describe("format: table left position in points (use with y)."),
        y: z.number().optional().describe("format: table top position in points (use with x)."),
        width: z.number().positive().optional().describe("format: table width in points."),
        height: z.number().positive().optional().describe("format: table height in points."),
        rotation: z.number().min(0).max(359).optional().describe("format: table rotation in degrees."),
        opacity: z.number().min(0).max(100).optional().describe("format: table opacity percentage."),
        locked: z.boolean().optional().describe("format: lock/unlock the table."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      audited("numbers_tables", args, async () => {
        const r = await numbersTables(args);
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "numbers_cells",
    {
      title: "Numbers cells",
      description:
        "Read and write cell values in a .numbers document using A1 references. `get` returns a grid (pass " +
        "`formatted: true` for display strings); `set` writes one cell; `setRange` writes a 2D grid starting at " +
        "a cell or range; `clear` empties a range including formatting. Values that look numeric are stored as " +
        "numbers, `true`/`false` as booleans, and anything starting with `=` becomes a live formula.",
      inputSchema: {
        path: z.string().describe("Path to the .numbers document."),
        action: z.enum(["get", "inspect", "formula", "set", "setRange", "clear"]).describe("What to do. inspect returns raw/display/formula/format/alignment/wrap metadata; formula returns formula text only."),
        sheet: z.number().int().positive().optional().describe("1-based sheet (default 1)."),
        table: z.number().int().positive().optional().describe("1-based table on that sheet (default 1)."),
        cell: z.string().optional().describe('Single cell like "B4".'),
        range: z.string().optional().describe('Range like "A1:C10".'),
        value: z.string().optional().describe("set: the value to write. Start with '=' for a formula."),
        values: z.array(z.array(z.string())).optional().describe("setRange: 2D grid of values."),
        formatted: z.boolean().optional().describe("get: return formatted (display) values instead of raw."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      audited("numbers_cells", args, async () => {
        const r = await numbersCells(args);
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "numbers_create",
    {
      title: "Create a native Numbers spreadsheet",
      description:
        "Create and save a real .numbers document from structured sheets/tables. Supports optional Numbers template, table names, values/formulas, header/footer rows, frozen headers and exact row/column sizing. This is the spreadsheet equivalent of pages_create and does not use Excel conversion.",
      inputSchema: {
        path: z.string().describe("Destination path ending in .numbers."),
        template: z.string().optional().describe("Installed Numbers template name."),
        sheets: z.array(z.object({
          name: z.string().optional(),
          tables: z.array(z.object({
            name: z.string().optional(),
            values: z.array(z.array(z.string())).describe("2D values. Strings starting with '=' become formulas."),
            headerRows: z.number().int().min(0).optional(),
            headerCols: z.number().int().min(0).optional(),
            footerRows: z.number().int().min(0).optional(),
            freezeHeaderRows: z.boolean().optional(),
            freezeHeaderCols: z.boolean().optional(),
            columnWidths: z.array(z.number().positive()).optional(),
            rowHeights: z.array(z.number().positive()).optional(),
          })).min(1),
        })).min(1),
        overwrite: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => audited("numbers_create", args, async () => {
      const r = await numbersCreate(args);
      return text(r.message, !r.ok);
    }),
  );

  server.registerTool(
    "numbers_inspect",
    {
      title: "Inspect Numbers structure and formatting",
      description:
        "Deep-read a .numbers document: sheets, tables, dimensions, headers/footers, frozen state, filtering, geometry, rotation/opacity/locks, plus populated cells with raw/display/formula/data-format/font/alignment/wrap metadata. Use before editing or when reproducing a spreadsheet.",
      inputSchema: {
        path: z.string().describe("Path to the .numbers document."),
        maxCells: z.number().int().positive().max(5000).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => audited("numbers_inspect", args, async () => {
      const r = await numbersInspect(args);
      return text(r.message, !r.ok);
    }),
  );

  server.registerTool(
    "numbers_verify",
    {
      title: "Verify Numbers spreadsheet integrity",
      description:
        "Run an integrity pass over a .numbers document: validates sheet/table structure and scans cells for spreadsheet error display values such as #REF!/#DIV/0!, with optional expected sheet/table counts. Designed as the post-edit acceptance check for larger spreadsheets.",
      inputSchema: {
        path: z.string().describe("Path to the .numbers document."),
        expectSheets: z.number().int().positive().optional(),
        expectTables: z.number().int().min(0).optional(),
        maxCells: z.number().int().positive().max(20000).optional(),
        maxIssues: z.number().int().positive().max(200).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => audited("numbers_verify", args, async () => {
      const r = await numbersVerify(args);
      return text(r.message, !r.ok);
    }),
  );

  server.registerTool(
    "numbers_find",
    {
      title: "Find values or formulas in Numbers",
      description:
        "Search every cell across every sheet/table and report exact sheet/table/A1 locations. Search formatted display values by default or formulas with formulas=true.",
      inputSchema: {
        path: z.string().describe("Path to the .numbers document."),
        text: z.string().min(1),
        formulas: z.boolean().optional(),
        maxResults: z.number().int().positive().max(500).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => audited("numbers_find", args, async () => {
      const r = await numbersFind(args);
      return text(r.message, !r.ok);
    }),
  );

  server.registerTool(
    "numbers_stats",
    {
      title: "Numbers document statistics",
      description:
        "Count sheets, tables, total cells, non-empty cells and formula cells in a .numbers document. Fast structural summary for planning and verification.",
      inputSchema: { path: z.string().describe("Path to the .numbers document.") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => audited("numbers_stats", args, async () => {
      const r = await numbersStats(args);
      return text(r.message, !r.ok);
    }),
  );

  // --- Keynote ---------------------------------------------------------------

  server.registerTool(
    "keynote_slides",
    {
      title: "Keynote slides",
      description:
        "Manage slides in a .key document. `list` shows each slide's number, layout, skipped flag, title text " +
        "and whether it has presenter notes. `layouts` lists the named layouts available in the document. " +
        "`add` appends a slide (optionally with a layout), `delete`, `duplicate`, and `move` (toIndex = the " +
        "position the slide should end up in) cover restructuring.",
      inputSchema: {
        path: z.string().describe("Path to the .key document."),
        action: z.enum(["list", "layouts", "add", "delete", "duplicate", "move"]).describe("What to do."),
        slide: z.number().int().positive().optional().describe("1-based slide for delete/duplicate/move."),
        toIndex: z.number().int().positive().optional().describe("move: the position the slide should occupy."),
        layout: z.string().optional().describe("add: layout name (see action=layouts)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      audited("keynote_slides", args, async () => {
        const r = await keynoteSlides(args);
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "keynote_content",
    {
      title: "Keynote slide content",
      description:
        "Put content on a slide. `setTitle` and `setBody` write through the slide's own title/body placeholders, " +
        "so the theme's typography is preserved - that is almost always what you want. `addTextBox` drops a free " +
        "text box at a position, `addImage` places an image file, `addTable` creates a table. Pass font, size and " +
        "color to override the theme for that one item.",
      inputSchema: {
        path: z.string().describe("Path to the .key document."),
        action: z.enum(["setTitle", "setBody", "addTextBox", "addImage", "addTable"]).describe("What to add."),
        slide: z.number().int().positive().describe("1-based slide."),
        text: z.string().optional().describe("setTitle/setBody/addTextBox: the text."),
        imagePath: z.string().optional().describe("addImage: path to the image file."),
        x: z.number().optional().describe("Left position in points."),
        y: z.number().optional().describe("Top position in points."),
        width: z.number().optional().describe("Width in points."),
        height: z.number().optional().describe("Height in points."),
        font: z.string().optional().describe("PostScript face."),
        size: z.number().optional().describe("Point size."),
        color: z.string().optional().describe("Text colour #RRGGBB."),
        rows: z.number().int().positive().optional().describe("addTable: rows (default 3)."),
        cols: z.number().int().positive().optional().describe("addTable: columns (default 3)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      audited("keynote_content", args, async () => {
        const r = await keynoteContent(args);
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "keynote_notes",
    {
      title: "Keynote presenter notes",
      description: "Read or write the presenter notes attached to a slide.",
      inputSchema: {
        path: z.string().describe("Path to the .key document."),
        action: z.enum(["get", "set"]).describe("Read or write the notes."),
        slide: z.number().int().positive().describe("1-based slide."),
        text: z.string().optional().describe("set: the notes text."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      audited("keynote_notes", args, async () => {
        const r = await keynoteNotes(args);
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "keynote_document",
    {
      title: "Keynote document settings",
      description:
        "Read or set native Keynote presentation settings: loop, autoplay on open, idle restart and timeout, slide width/height, document theme, and slide-number visibility. Uses Keynote AppleScript directly rather than UI automation.",
      inputSchema: {
        path: z.string().describe("Path to the .key document."),
        action: z.enum(["get", "set"]),
        autoLoop: z.boolean().optional(),
        autoPlay: z.boolean().optional(),
        autoRestart: z.boolean().optional(),
        maximumIdleDuration: z.number().int().min(0).optional().describe("Idle restart delay in seconds."),
        width: z.number().int().positive().optional().describe("Slide width in points."),
        height: z.number().int().positive().optional().describe("Slide height in points."),
        theme: z.string().optional().describe("Installed Keynote theme name."),
        slideNumbersShowing: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => audited("keynote_document", args, async () => {
      const r = await keynoteDocument(args);
      return text(r.message, !r.ok);
    }),
  );

  server.registerTool(
    "keynote_slide_format",
    {
      title: "Keynote slide layout and visibility",
      description:
        "Inspect or change one slide without rebuilding it: switch its named base layout, skip/unskip it, and show/hide the theme title and body placeholders. Native Keynote scripting preserves theme behavior.",
      inputSchema: {
        path: z.string().describe("Path to the .key document."),
        action: z.enum(["get", "set"]),
        slide: z.number().int().positive(),
        layout: z.string().optional().describe("Named layout from keynote_slides action=layouts."),
        skipped: z.boolean().optional(),
        titleShowing: z.boolean().optional(),
        bodyShowing: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => audited("keynote_slide_format", args, async () => {
      const r = await keynoteSlideFormat(args);
      return text(r.message, !r.ok);
    }),
  );

  server.registerTool(
    "keynote_transition",
    {
      title: "Keynote slide transitions",
      description:
        "Inspect, set or clear the native transition record on one slide. Supports Keynote transition effect, duration, delay and automatic-vs-click start. Effect names are validated against the complete Creator Studio 15.4 scripting dictionary, including Magic Move, dissolve, wipe, cube, page flip, object effects and more.",
      inputSchema: {
        path: z.string().describe("Path to the .key document."),
        action: z.enum(["get", "set", "clear"]),
        slide: z.number().int().positive(),
        effect: z.string().optional().describe("Native Keynote effect name, e.g. dissolve, magic move, wipe, object push, page flip."),
        duration: z.number().min(0).optional().describe("Transition duration in seconds."),
        delay: z.number().min(0).optional().describe("Delay before the transition in seconds."),
        automatic: z.boolean().optional().describe("true = automatic; false = on click."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => audited("keynote_transition", args, async () => {
      const r = await keynoteTransition(args);
      return text(r.message, !r.ok);
    }),
  );

  server.registerTool(
    "keynote_create",
    {
      title: "Create a native Keynote presentation",
      description:
        "Create and save a real .key presentation from structured slides. Supports theme/slide size, named layouts, title/body placeholders, presenter notes, skipped slides, all native transition settings, free text boxes, positioned images and real tables. No PowerPoint conversion.",
      inputSchema: {
        path: z.string().describe("Destination path ending in .key."),
        theme: z.string().optional().describe("Installed Keynote theme name."),
        width: z.number().positive().optional().describe("Slide width in points."),
        height: z.number().positive().optional().describe("Slide height in points."),
        slides: z.array(z.object({
          layout: z.string().optional(),
          title: z.string().optional(),
          body: z.string().optional(),
          notes: z.string().optional(),
          skipped: z.boolean().optional(),
          transition: z.object({
            effect: z.string().optional(),
            duration: z.number().min(0).optional(),
            delay: z.number().min(0).optional(),
            automatic: z.boolean().optional(),
          }).optional(),
          textBoxes: z.array(z.object({
            text: z.string(),
            x: z.number().optional(),
            y: z.number().optional(),
            width: z.number().positive().optional(),
            height: z.number().positive().optional(),
            font: z.string().optional(),
            size: z.number().positive().optional(),
            color: z.string().optional().describe("#RRGGBB"),
          })).optional(),
          images: z.array(z.object({
            path: z.string(),
            x: z.number().optional(),
            y: z.number().optional(),
            width: z.number().positive().optional(),
            height: z.number().positive().optional(),
            description: z.string().optional(),
          })).optional(),
          tables: z.array(z.object({
            values: z.array(z.array(z.string())),
            x: z.number().optional(),
            y: z.number().optional(),
            width: z.number().positive().optional(),
            height: z.number().positive().optional(),
            headerRows: z.number().int().min(0).optional(),
            headerCols: z.number().int().min(0).optional(),
          })).optional(),
        })).min(1),
        overwrite: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => audited("keynote_create", args, async () => {
      const r = await keynoteCreate(args);
      return text(r.message, !r.ok);
    }),
  );

  server.registerTool(
    "keynote_inspect",
    {
      title: "Inspect Keynote slides and object geometry",
      description:
        "Deep-read a .key presentation: document theme/size/playback settings; each slide's layout, skipped state, title/body/notes, transition record and object counts; then exact type/position/size/rotation/opacity/lock/text for slide objects. Use before editing or for pixel/layout reproduction.",
      inputSchema: {
        path: z.string().describe("Path to the .key document."),
        maxObjects: z.number().int().positive().max(5000).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => audited("keynote_inspect", args, async () => {
      const r = await keynoteInspect(args);
      return text(r.message, !r.ok);
    }),
  );

  server.registerTool(
    "keynote_verify",
    {
      title: "Verify Keynote presentation integrity",
      description:
        "Run a structural acceptance check over a .key deck. Confirms slide dimensions/count and object dimensions; strictBounds=true additionally flags objects extending outside the slide canvas. Intended after large slide edits.",
      inputSchema: {
        path: z.string().describe("Path to the .key document."),
        expectSlides: z.number().int().positive().optional(),
        strictBounds: z.boolean().optional(),
        maxObjects: z.number().int().positive().max(20000).optional(),
        maxIssues: z.number().int().positive().max(200).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => audited("keynote_verify", args, async () => {
      const r = await keynoteVerify(args);
      return text(r.message, !r.ok);
    }),
  );

  server.registerTool(
    "keynote_find",
    {
      title: "Find text in Keynote",
      description:
        "Search slide title/body placeholders, presenter notes and free text boxes across the presentation, returning slide number and source for every hit.",
      inputSchema: {
        path: z.string().describe("Path to the .key document."),
        text: z.string().min(1),
        maxResults: z.number().int().positive().max(500).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => audited("keynote_find", args, async () => {
      const r = await keynoteFind(args);
      return text(r.message, !r.ok);
    }),
  );

  server.registerTool(
    "keynote_stats",
    {
      title: "Keynote presentation statistics",
      description:
        "Count slides/skipped slides, presenter-note characters and slide object totals for text items, shapes, images, tables, charts and movies.",
      inputSchema: { path: z.string().describe("Path to the .key document.") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => audited("keynote_stats", args, async () => {
      const r = await keynoteStats(args);
      return text(r.message, !r.ok);
    }),
  );

  server.registerTool(
    "keynote_charts",
    {
      title: "Keynote charts",
      description:
        "List, add, format or delete native Keynote charts. add accepts row/column labels, a numeric 2D data grid, legacy Keynote chart type and row/column grouping; geometry, rotation, opacity and locking are directly controllable.",
      inputSchema: {
        path: z.string().describe("Path to the .key document."),
        action: z.enum(["list", "add", "format", "delete"]),
        slide: z.number().int().positive(),
        chart: z.number().int().positive().optional(),
        type: z.enum(["pie_2d", "vertical_bar_2d", "stacked_vertical_bar_2d", "horizontal_bar_2d", "stacked_horizontal_bar_2d", "pie_3d", "vertical_bar_3d", "stacked_vertical_bar_3d", "horizontal_bar_3d", "stacked_horizontal_bar_3d", "area_2d", "stacked_area_2d", "line_2d", "line_3d", "area_3d", "stacked_area_3d", "scatterplot_2d"]).optional(),
        groupBy: z.enum(["row", "column"]).optional(),
        rowNames: z.array(z.string()).optional(),
        columnNames: z.array(z.string()).optional(),
        data: z.array(z.array(z.number())).optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
        rotation: z.number().min(0).max(359).optional(),
        opacity: z.number().min(0).max(100).optional(),
        locked: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => audited("keynote_charts", args, async () => {
      const r = await keynoteCharts(args);
      return text(r.message, !r.ok);
    }),
  );

  server.registerTool(
    "keynote_image_slides",
    {
      title: "Create Keynote image slides",
      description:
        "Use Keynote's native make-image-slides command to turn a list of local image files into slides in one operation, optionally deriving titles and applying a named slide layout.",
      inputSchema: {
        path: z.string().describe("Path to the .key document."),
        files: z.array(z.string()).min(1),
        setTitles: z.boolean().optional(),
        layout: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => audited("keynote_image_slides", args, async () => {
      const r = await keynoteImageSlides(args);
      return text(r.message, !r.ok);
    }),
  );

  server.registerTool(
    "keynote_show",
    {
      title: "Control a Keynote slideshow",
      description:
        "Start, stop or step through a slideshow on the frontmost presentation. `start` plays from the " +
        "beginning, `goto` jumps to a slide, `next`/`previous` advance one build or slide, `stop` ends it. " +
        "This takes over the screen while it runs - that is what presenting means.",
      inputSchema: {
        action: z.enum(["start", "stop", "next", "previous", "goto"]).describe("What to do."),
        slide: z.number().int().positive().optional().describe("goto: 1-based slide to show."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      audited("keynote_show", args, async () => {
        const r = await keynoteShow(args);
        return text(r.message, !r.ok);
      }),
  );

  // --- general macOS automation ----------------------------------------------

  server.registerTool(
    "mac_apps",
    {
      title: "macOS apps",
      description:
        "See and steer the apps on this Mac. `list` names every app with a visible UI, `frontmost` reports which " +
        "one is in front, `activate` brings an app forward, `launch` starts it in the background, `hide` hides it. " +
        "There is deliberately no `quit`: this server never shuts down an app that might hold unsaved work.",
      inputSchema: {
        action: z.enum(["list", "activate", "launch", "hide", "frontmost"]).describe("What to do."),
        app: z.string().optional().describe("App name, e.g. 'Safari' (activate/launch/hide)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      audited("mac_apps", args, async () => {
        const r = await macApps(args);
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "mac_ui",
    {
      title: "macOS UI scripting",
      description:
        "Drive an app's interface through System Events. `windows` lists an app's windows with position and " +
        "size; `menu` clicks a menu item by name (optionally a submenu and sub-item); `keystroke` sends a key " +
        "with optional modifiers; `focus` brings an app to the front. Needs Accessibility permission in addition " +
        "to Automation - the error tells you exactly where to grant it.",
      inputSchema: {
        action: z.enum(["windows", "menu", "keystroke", "focus"]).describe("What to do."),
        app: z.string().optional().describe("Target app name (windows/menu/focus)."),
        menu: z.string().optional().describe("menu: menu bar item, e.g. 'File'."),
        item: z.string().optional().describe("menu: item to click, e.g. 'Save'."),
        submenu: z.string().optional().describe("menu: submenu name."),
        subitem: z.string().optional().describe("menu: item inside the submenu."),
        key: z.string().optional().describe("keystroke: the key or text to type."),
        modifiers: z
          .array(z.enum(["command", "shift", "option", "control"]))
          .optional()
          .describe("keystroke: modifiers to hold."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      audited("mac_ui", args, async () => {
        const r = await macUi(args);
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "mac_system",
    {
      title: "macOS system state",
      description:
        "Read and set small pieces of system state: the text clipboard (`clipboardGet`/`clipboardSet`), post a " +
        "notification, read or set the output volume, mute/unmute, and read battery, disk usage or uptime. " +
        "None of these change files.",
      inputSchema: {
        action: z
          .enum([
            "clipboardGet",
            "clipboardSet",
            "notify",
            "volumeGet",
            "volumeSet",
            "mute",
            "battery",
            "disk",
            "uptime",
          ])
          .describe("What to do."),
        text: z.string().optional().describe("clipboardSet: text to copy. notify: the message body."),
        title: z.string().optional().describe("notify: notification title."),
        subtitle: z.string().optional().describe("notify: notification subtitle."),
        sound: z.boolean().optional().describe("notify: play a sound (default true)."),
        level: z.number().min(0).max(100).optional().describe("volumeSet: 0-100."),
        muted: z.boolean().optional().describe("mute: true to mute (default), false to unmute."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      audited("mac_system", args, async () => {
        const r = await macSystem(args);
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "mac_finder",
    {
      title: "Finder",
      description:
        "Work with files the way a person does in Finder: `reveal` selects a path in a Finder window, `open` " +
        "opens it with its default app, `info` reports type/size/dates, and `trash` moves a path to the Trash. " +
        "Trash is recoverable and is the only removal this server offers - nothing here ever deletes a file " +
        "outright.",
      inputSchema: {
        action: z.enum(["reveal", "open", "trash", "info"]).describe("What to do."),
        path: z.string().describe("Absolute path or ~-relative path."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      audited("mac_finder", args, async () => {
        const r = await macFinder(args);
        return text(r.message, !r.ok);
      }),
  );

  server.registerTool(
    "mac_shortcuts",
    {
      title: "macOS Shortcuts",
      description:
        "List the user's Shortcuts and run one by name, optionally feeding it a file. Shortcuts are the cleanest " +
        "way to reach anything with no scripting interface - if a task has a shortcut, run it instead of driving " +
        "the UI.",
      inputSchema: {
        action: z.enum(["list", "run"]).describe("List shortcuts or run one."),
        name: z.string().optional().describe("run: the shortcut's name."),
        input: z.string().optional().describe("run: path to a file to pass as input."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      audited("mac_shortcuts", args, async () => {
        const r = await macShortcuts(args);
        return text(r.message, !r.ok);
      }),
  );

  // --- Codex Computer Use (proxied) ------------------------------------------
  // These four are registered from a verbatim snapshot of what the shipped cua_repl
  // server advertises (src/cua-tools.json), so our tools/list matches Codex exactly.
  // The bodies run in the child process: see cua.ts.
  // Registered one branch per tool (rather than a shared shape map) so every handler keeps
  // the exact input type the SDK infers from a literal shape.
  type CuaDef = (typeof CUA_TOOLS)[number];
  const cuaBase = (def: CuaDef) => ({
    title: def.title,
    description: def.description,
    annotations: def.annotations,
    _meta: def._meta as Record<string, unknown> | undefined,
  });
  const runCua = (def: CuaDef, args: unknown): Promise<ToolResult> =>
    audited(def.name, args, async () => {
      const a = (args ?? {}) as Record<string, unknown>;
      const raw = (await callCuaTool(def.name, a, cuaTimeoutMs(def.name, a))) as Partial<ToolResult> & {
        content?: ToolResult["content"];
      };
      if (raw.content) {
        return { content: raw.content, ...(raw.isError ? { isError: true } : {}) };
      }
      return text("cua_repl returned no content", true);
    });

  for (const def of CUA_TOOLS) {
    if (def.name === "js") {
      server.registerTool(
        def.name,
        {
          ...cuaBase(def),
          inputSchema: {
            code: z.string().describe("JavaScript to execute using the initialized cua_repl runtime."),
            timeout_ms: z
              .number()
              .int()
              .min(1)
              .optional()
              .describe("Optional execution timeout in milliseconds. Defaults to 30000 (30 seconds) when omitted."),
            title: z
              .string()
              .min(1)
              .max(80)
              .optional()
              .describe("Short user-facing description of what the code does."),
          },
        },
        async (args) => runCua(def, args),
      );
    } else if (def.name === "js_add_node_module_dir") {
      server.registerTool(
        def.name,
        {
          ...cuaBase(def),
          inputSchema: {
            path: z
              .string()
              .min(1)
              .describe("Absolute path to a node_modules directory to add to Node package resolution."),
          },
        },
        async (args) => runCua(def, args),
      );
    } else if (def.name === "js_reset") {
      // An empty raw shape would make the SDK fall back to a Zod v4 object that drops
      // additionalProperties:false, so pass a real (empty) object schema instead.
      server.registerTool(
        def.name,
        { ...cuaBase(def), inputSchema: z.object({}) },
        async (args) => runCua(def, args),
      );
    } else if (def.name === "turn_ended") {
      server.registerTool(
        def.name,
        {
          ...cuaBase(def),
          inputSchema: {
            hook_event_name: z.string().min(1),
            session_id: z.string().min(1),
            turn_id: z.string().min(1),
          },
        },
        async (args) => runCua(def, args),
      );
    }
  }

  // --- computer use, system, workflow and everyday apps ----------------------
  // Registered through one small helper: the SDK's literal-schema overload works
  // per call, and these bodies all share the same "message plus optional image"
  // shape so the helper can assemble the MCP content blocks once.
  type AnyOutcome = { ok: boolean; message: string; image?: { data: string; mimeType: string } };
  const addTool = (
    name: string,
    title: string,
    description: string,
    inputSchema: Record<string, z.ZodTypeAny>,
    annotations: Record<string, boolean>,
    body: (args: any) => Promise<AnyOutcome>,
  ): void => {
    // The orchestrator and the skill runner execute steps by tool name, so
    // every registration also lands in the in-process registry with the same
    // body the MCP client calls.
    registerHandler(name, body, description);
    // Method call on `server` on purpose: registerTool reads private state off
    // `this`, so it must not be detached into a bare function reference.
    const register = (n: string, config: unknown, cb: (args: any) => Promise<ToolResult>): void =>
      (server.registerTool as unknown as (a: string, b: unknown, c: (args: any) => Promise<ToolResult>) => void)(
        n,
        config,
        cb,
      );
    register(name, { title, description, inputSchema, annotations }, (args: any) =>
      audited(name, args, async () => {
        noteToolCall(name, args ?? {});
        const out = await body(args);
        const content: Array<TextBlock | ImageBlock> = [{ type: "text", text: out.message }];
        if (out.image) content.push({ type: "image", data: out.image.data, mimeType: out.image.mimeType });
        return out.ok ? { content } : { content, isError: true };
      }),
    );
  };

  addTool(
    "screen_capture",
    "Look at the screen",
    "Screenshot of the display, a window, or a region, returned as an image you can actually see. " +
      "Window capture needs the app name (window_list shows candidates) or an explicit windowId; region is x/y/width/height. " +
      "The file is saved too, so you can refer to it later. Needs Screen Recording permission (mac_permissions fixes that).",
    {
      display: z.number().int().min(1).optional().describe("Display number, 1-based (default: main display)."),
      window: z.string().optional().describe("Capture the front window of this app, e.g. 'Safari'."),
      windowId: z.number().int().optional().describe("Exact window id from window_list."),
      region: z
        .object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })
        .optional()
        .describe("Capture only this rectangle of the screen."),
      path: z.string().optional().describe("Where to save (default: the configured screenshots folder)."),
      maxWidth: z.number().int().min(0).optional().describe("Downscale so width <= this (0 disables). Default 1600."),
      format: z.enum(["png", "jpeg"]).optional().describe("Output format (default png)."),
      quality: z.number().min(1).max(100).optional().describe("jpeg quality."),
      includeCursor: z.boolean().optional().describe("Draw the mouse pointer."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    (args) => screenCapture(args),
  );

  addTool(
    "window_list",
    "List windows",
    "Every on-screen window with its id, app, title, size and position, front to back. No permissions needed. " +
      "Use the id with screen_capture or window_control.",
    {
      app: z.string().optional().describe("Only windows whose app name contains this."),
      includeOffscreen: z.boolean().optional().describe("Include minimised and hidden windows."),
      minSize: z.number().optional().describe("Skip windows smaller than this many points (default 40)."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => {
      const r = await windowList(args);
      return { ok: r.ok, message: r.message };
    },
  );

  addTool(
    "mouse",
    "Control the pointer",
    "Move, click, double-click, right-click, middle-click, drag or scroll the real pointer. Coordinates are global " +
      "screen points, which is what window_list and ui_find report. Needs Accessibility permission.",
    {
      action: z.enum(["move", "click", "double_click", "right_click", "middle_click", "drag", "scroll"]),
      x: z.number().optional().describe("Target x (screen points)."),
      y: z.number().optional().describe("Target y (screen points)."),
      toX: z.number().optional().describe("drag: end x."),
      toY: z.number().optional().describe("drag: end y."),
      amount: z.number().optional().describe("scroll: positive scrolls up, negative down."),
      unit: z.enum(["line", "pixel"]).optional().describe("scroll: unit (default line)."),
      modifiers: z.array(z.enum(["command", "shift", "option", "control"])).optional().describe("Keys to hold."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    (args) => mouse(args),
  );

  addTool(
    "keyboard",
    "Type and press keys",
    "Type text into whatever is focused, press a named key (return, tab, escape, arrows, f1-f12...), or send a " +
      "shortcut combo such as ['command','shift','t']. Optionally activate an app first, which is the reliable way to " +
      "make sure the keystrokes land in the right place. Needs Accessibility permission.",
    {
      action: z.enum(["type", "key", "combo"]),
      text: z.string().optional().describe("type: the text to enter."),
      key: z.string().optional().describe("key: a named key or single character; combo: the final key."),
      keys: z.array(z.string()).optional().describe("combo: e.g. ['command','shift','t']."),
      modifiers: z.array(z.enum(["command", "shift", "option", "control", "fn"])).optional(),
      app: z.string().optional().describe("Bring this app to the front before typing."),
      delayMs: z.number().int().min(0).optional().describe("Pause between keystroke chunks."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    (args) => keyboard(args),
  );

  addTool(
    "ui_tree",
    "Read an app's accessibility tree",
    "The interface of an app as structured nodes: role, title, value, position, size and available actions, with a " +
      "path you can act on. This is how you see buttons and fields that a screenshot alone cannot name. " +
      "Defaults to the focused app; pass app or pid to target another. Needs Accessibility permission.",
    {
      app: z.string().optional().describe("App name, e.g. 'Finder'."),
      pid: z.number().int().optional().describe("Process id instead of an app name."),
      depth: z.number().int().min(1).max(16).optional().describe("How deep to descend (default 6)."),
      maxNodes: z.number().int().min(1).max(2000).optional().describe("Node budget (default 300)."),
      role: z.string().optional().describe("Only include nodes whose role contains this, e.g. 'Button'."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (args) => uiTree(args),
  );

  addTool(
    "ui_find",
    "Find a control by label",
    "Search an app's accessibility tree for an element by visible text, identifier or role, and report where it is. " +
      "Use it before ui_act so you act on the element you meant.",
    {
      app: z.string().optional().describe("App name (default: focused app)."),
      pid: z.number().int().optional(),
      text: z.string().optional().describe("Case-insensitive substring of the title, description, value or identifier."),
      role: z.string().optional().describe("Role filter, e.g. 'Button', 'TextField'."),
      depth: z.number().int().min(1).max(20).optional(),
      maxNodes: z.number().int().min(1).max(4000).optional(),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (args) => uiFind(args),
  );

  addTool(
    "ui_act",
    "Press or fill a control",
    "Perform an accessibility action on the element matching text/role: press, confirm, open its menu, focus, raise, " +
      "or set its value. index picks among several matches (ui_find lists them in order). This is more reliable than " +
      "clicking coordinates because it cannot miss the target.",
    {
      app: z.string().optional().describe("App name (default: focused app)."),
      pid: z.number().int().optional(),
      text: z.string().optional().describe("Label text to match."),
      role: z.string().optional().describe("Role filter, e.g. 'Button'."),
      action: z
        .enum(["press", "confirm", "show_menu", "focus", "set_value", "raise"])
        .optional()
        .describe("Default press."),
      value: z.string().optional().describe("set_value: the new value."),
      index: z.number().int().min(0).optional().describe("Which match to act on (default 0)."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    (args) => uiAct(args),
  );

  addTool(
    "window_control",
    "Move and arrange windows",
    "Focus, move, resize, minimise, restore, zoom, go fullscreen, or tile a window to the left/right half. " +
      "window is 1-based within the app. Needs Accessibility permission.",
    {
      action: z.enum(["focus", "move", "resize", "minimize", "restore", "zoom", "fullscreen", "tile_left", "tile_right"]),
      app: z.string().describe("App that owns the window."),
      window: z.number().int().min(1).optional().describe("1-based window index (default 1)."),
      x: z.number().optional().describe("move: left edge in points."),
      y: z.number().optional().describe("move: top edge in points."),
      width: z.number().optional().describe("resize: width in points."),
      height: z.number().optional().describe("resize: height in points."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (args) => windowControl(args),
  );

  addTool(
    "app_control",
    "Control apps",
    "List apps with windows, read the frontmost app, activate, launch in the background, hide, show, quit gracefully, " +
      "relaunch, or force-quit. Graceful quit lets the app ask about unsaved work; force_quit is the one action that " +
      "can lose data.",
    {
      action: z.enum(["list", "front", "activate", "launch", "hide", "show", "quit", "relaunch", "force_quit"]),
      app: z.string().optional().describe("App name (all actions except list/front)."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    (args) => appControl(args),
  );

  addTool(
    "system_info",
    "System state",
    "OS version, chip, cores, memory pressure, swap, load average, uptime, disk space, power source, battery, thermal " +
      "state and the top CPU processes in one call. Cheaper and more reliable than running half a dozen shell commands.",
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    () => systemInfo(),
  );

  addTool(
    "process_list",
    "List processes",
    "Running processes with pid, parent, cpu, memory, resident size, elapsed time and the command, sorted by cpu or " +
      "memory. filter matches the command or a pid.",
    {
      filter: z.string().optional().describe("Substring of the command line, or 'pid=1234'."),
      sort: z.enum(["cpu", "mem", "pid", "name"]).optional().describe("Default cpu."),
      limit: z.number().int().min(1).max(200).optional().describe("Default 25."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (args) => processList(args),
  );

  addTool(
    "process_control",
    "Signal a process",
    "Inspect one pid, send TERM/KILL/INT/HUP/USR1/USR2, stop/continue it, or change its nice value. Refuses to touch " +
      "this server or its own parents.",
    {
      action: z.enum(["signal", "stop", "continue", "priority", "info"]),
      pid: z.number().int().positive(),
      signal: z.enum(["TERM", "KILL", "INT", "HUP", "USR1", "USR2"]).optional().describe("Default TERM."),
      nice: z.number().int().min(-20).max(20).optional().describe("priority: nice delta."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    (args) => processControl(args),
  );

  addTool(
    "network_info",
    "Network state",
    "Active interfaces and their addresses, default gateway, Wi-Fi network, DNS servers and listening TCP ports.",
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    () => networkInfo(),
  );

  addTool(
    "power",
    "Power and sleep",
    "Read power settings, lock the screen, put the display or the Mac to sleep, and keep it awake for a while " +
      "(caffeinate) or allow sleep again.",
    {
      action: z.enum(["status", "lock", "sleep", "displaySleep", "keepAwake", "allowSleep"]),
      minutes: z.number().int().min(1).max(1440).optional().describe("keepAwake: how long (default 30)."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    (args) => power(args),
  );

  addTool(
    "audio",
    "Volume",
    "Read the output volume, set it 0-100, or mute/unmute.",
    {
      action: z.enum(["get", "set", "mute", "unmute"]),
      level: z.number().min(0).max(100).optional().describe("set: 0-100."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (args) => audio(args),
  );

  addTool(
    "speak",
    "Speak out loud",
    "Say text with the system voice - useful when the person is away from the screen.",
    {
      text: z.string().describe("What to say (max 4000 chars)."),
      voice: z.string().optional().describe("Voice name, e.g. 'Samantha'."),
      rate: z.number().min(80).max(500).optional().describe("Words per minute."),
      wait: z.boolean().optional().describe("Wait for speech to finish (default false)."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    (args) => speak(args),
  );

  addTool(
    "media",
    "Music and podcasts",
    "Read or control whatever Music or Spotify is playing: status with the current track, play, pause, toggle, next, " +
      "previous. Never launches a player that is not already running.",
    {
      action: z.enum(["status", "play", "pause", "toggle", "next", "previous"]),
      app: z.enum(["Music", "Spotify"]).optional().describe("Target player (default: whichever is running)."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    (args) => media(args),
  );

  addTool(
    "shell_session",
    "Persistent shell",
    "A long-lived shell you can keep using across calls: start one, run a command and get its output and exit code, " +
      "write to a running program, read what it printed since last time, interrupt with Ctrl-C, or stop it. " +
      "This is how you keep a dev server or REPL alive between turns.",
    {
      action: z.enum(["start", "run", "read", "write", "interrupt", "stop", "list"]),
      id: z.string().optional().describe("Session id (defaults to the most recent)."),
      command: z.string().optional().describe("run/write: the line to send."),
      cwd: z.string().optional().describe("start: working directory."),
      shell: z.string().optional().describe("start: shell binary (default $SHELL or /bin/zsh)."),
      timeoutSeconds: z.number().int().min(1).max(600).optional().describe("run: how long to wait for the prompt."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    (args) => shellSession(args),
  );

  addTool(
    "wait_for",
    "Wait for something to happen",
    "Poll until a condition holds (or stops holding): a file appears, a file changes, a port opens, a URL returns 2xx, " +
      "a process or app runs, or a window title matches. Returns as soon as it is true, so you never have to guess a sleep.",
    {
      condition: z.enum(["file_exists", "file_changed", "port_open", "url_ok", "process_running", "app_running", "window_title"]),
      target: z.string().describe("Path, port number, process name, app name or window text depending on the condition."),
      timeoutSeconds: z.number().int().min(1).max(600).optional().describe("Default 30."),
      intervalMs: z.number().int().min(100).max(10000).optional().describe("Default 500."),
      expect: z.enum(["present", "absent"]).optional().describe("Wait for the condition to become true or false."),
      contains: z.string().optional().describe("window_title: substring to match (defaults to target)."),
      port: z.number().int().optional().describe("port_open: port (or pass it in target)."),
      host: z.string().optional().describe("port_open: host (default 127.0.0.1)."),
      url: z.string().optional().describe("url_ok: the URL (or pass it in target)."),
      app: z.string().optional().describe("app_running: exact app/process name."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    (args) => waitFor(args),
  );

  addTool(
    "file_ops",
    "File operations",
    "Move, copy, create a directory, symlink, measure a tree, zip/unzip (or tar), touch, or open a file with a " +
      "specific app. Refuses to overwrite unless overwrite=true, and never deletes: deletion stays a Finder Trash action.",
    {
      action: z.enum(["move", "copy", "mkdir", "link", "du", "archive", "extract", "open_with", "touch"]),
      path: z.string().describe("Source path, or the directory to create."),
      to: z.string().optional().describe("Destination: path, archive file, or extraction directory."),
      overwrite: z.boolean().optional().describe("Replace an existing destination."),
      app: z.string().optional().describe("open_with: app name."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    (args) => fileOps(args),
  );

  addTool(
    "spotlight",
    "Spotlight search",
    "Instant metadata search over the whole disk: by file name, file contents, kind (pdf/image/movie/audio/text/" +
      "source/folder/app/archive) and how recently it changed. Far faster and wider than walking directories.",
    {
      query: z.string().optional().describe("Raw mdfind query, used when no structured filter is given."),
      name: z.string().optional().describe("Substring of the file name."),
      content: z.string().optional().describe("Substring of the file contents."),
      kind: z.enum(["pdf", "image", "movie", "audio", "text", "source", "folder", "app", "archive"]).optional(),
      within: z.string().optional().describe("Limit the search to this directory (default: workspace)."),
      modifiedWithinHours: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(200).optional().describe("Default 30."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (args) => spotlight(args),
  );

  addTool(
    "recent_files",
    "Recently changed files",
    "What has changed under a directory in the last N hours, newest first. Great for picking up where a person left off.",
    {
      within: z.string().optional().describe("Directory (default: workspace)."),
      hours: z.number().int().min(1).max(720).optional().describe("Default 24."),
      limit: z.number().int().min(1).max(200).optional().describe("Default 40."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (args) => recentFiles(args),
  );

  addTool(
    "browser",
    "Browser tabs and pages",
    "Work with the running browser: list tabs with titles and URLs, open a URL, read the text of the active page, " +
      "report the front tab, or close a tab. Reading page text needs 'Allow JavaScript from Apple Events' in the " +
      "browser's Develop menu.",
    {
      action: z.enum(["tabs", "open", "active", "read", "close"]),
      app: z.enum(["Safari", "Google Chrome", "Microsoft Edge", "Brave Browser", "Arc"]).optional(),
      url: z.string().optional().describe("open: the URL."),
      index: z.number().int().min(1).optional().describe("close: tab index (default 1)."),
      window: z.number().int().min(1).optional().describe("close: window index (default 1)."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    (args) => browser(args),
  );

  addTool(
    "calendar",
    "Calendar",
    "List calendars, list events in a time range, or create an event with a title, ISO start/end, notes and " +
      "location. Times are local 'YYYY-MM-DDTHH:MM'. Nothing is ever deleted.",
    {
      action: z.enum(["events", "calendars", "create"]),
      from: z.string().optional().describe("events: ISO start (default now)."),
      to: z.string().optional().describe("events: ISO end (default +7 days)."),
      limit: z.number().int().min(1).max(200).optional(),
      calendar: z.string().optional().describe("Restrict to / create in this calendar name."),
      summary: z.string().optional().describe("create: event title."),
      start: z.string().optional().describe("create: ISO start."),
      end: z.string().optional().describe("create: ISO end."),
      notes: z.string().optional().describe("create: description."),
      location: z.string().optional().describe("create: location."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    (args) => calendar(args),
  );

  addTool(
    "reminders",
    "Reminders",
    "List reminder lists, list open reminders with due dates, add one (optionally due), or mark one complete.",
    {
      action: z.enum(["lists", "list", "add", "complete"]),
      list: z.string().optional().describe("List name."),
      name: z.string().optional().describe("add/complete: the reminder text."),
      due: z.string().optional().describe("add: ISO due date 'YYYY-MM-DDTHH:MM'."),
      notes: z.string().optional().describe("add: body."),
      includeCompleted: z.boolean().optional().describe("list: include completed items."),
      limit: z.number().int().min(1).max(200).optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    (args) => reminders(args),
  );

  addTool(
    "notes",
    "Notes",
    "List notes, search by title, read one as plain text, create one, or append to an existing note.",
    {
      action: z.enum(["list", "search", "read", "create", "append"]),
      folder: z.string().optional().describe("Folder name (default 'Notes')."),
      title: z.string().optional().describe("search: substring; read/create/append: exact title."),
      body: z.string().optional().describe("create/append: the text."),
      limit: z.number().int().min(1).max(100).optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    (args) => notes(args),
  );

  addTool(
    "contacts",
    "Contacts",
    "Look a person up by name and get their email addresses and phone numbers.",
    {
      query: z.string().describe("Name to search for."),
      limit: z.number().int().min(1).max(50).optional().describe("Default 10."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (args) => contacts(args),
  );

  addTool(
    "app_config",
    "Saved settings",
    "Read and edit this Mac's saved settings - paths, device name, screenshot format and size, shell timeouts, extra " +
      "allowed folders, API keys. Stored on this machine only; secrets are masked unless you ask for reveal.",
    {
      action: z.enum(["get", "set", "unset", "patch", "reset", "path", "schema", "reveal"]),
      key: z.string().optional().describe("Dot path, e.g. 'paths.screenshots' or 'shell.defaultTimeoutSeconds'."),
      value: z.any().optional().describe("set: the new value (string, number, boolean, list or object)."),
      patch: z.record(z.any()).optional().describe("patch: an object merged into the settings."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (args) => {
      const action = String(args.action ?? "get");
      if (action === "path") return { ok: true, message: configPath() };
      if (action === "schema") return { ok: true, message: JSON.stringify(defaultConfig(), null, 2) };
      if (action === "reset") {
        const cfg = resetConfig();
        return { ok: true, message: `Reset to defaults:\n${JSON.stringify(redactConfig(cfg), null, 2)}` };
      }
      if (action === "get") {
        const cfg = loadConfig();
        if (!args.key) return { ok: true, message: JSON.stringify(redactConfig(cfg), null, 2) };
        const value = getPath(cfg, String(args.key));
        return value === undefined
          ? { ok: false, message: `No setting at ${args.key}.` }
          : { ok: true, message: typeof value === "string" ? value : JSON.stringify(value, null, 2) };
      }
      if (action === "reveal") {
        const value = getPath(loadConfig(), String(args.key ?? ""));
        return value === undefined
          ? { ok: false, message: `No setting at ${args.key}.` }
          : { ok: true, message: typeof value === "string" ? value : JSON.stringify(value, null, 2) };
      }
      if (action === "unset") {
        const cfg = unsetPath(String(args.key ?? ""));
        return { ok: true, message: `Unset ${args.key}.\n${JSON.stringify(redactConfig(cfg), null, 2)}` };
      }
      if (action === "patch") {
        if (!args.patch || typeof args.patch !== "object") return { ok: false, message: "patch needs an object" };
        const cfg = patchConfig(args.patch);
        return { ok: true, message: `Patched.\n${JSON.stringify(redactConfig(cfg), null, 2)}` };
      }
      if (!args.key) return { ok: false, message: "set needs key and value" };
      const cfg = setPath(String(args.key), args.value);
      return { ok: true, message: `Set ${args.key}.\n${JSON.stringify(redactConfig(cfg), null, 2)}` };
    },
  );

  addTool(
    "mac_permissions",
    "macOS permissions",
    "Report which macOS permissions this server has (Accessibility, Screen Recording, Automation, Full Disk Access), " +
      "ask the OS for them so the prompts appear, and open the right System Settings panes. Call it first whenever a " +
      "screen, UI or input tool says permission is missing.",
    {
      action: z.enum(["status", "request", "open", "fix"]),
      kind: z
        .enum(["accessibility", "screenRecording", "automation", "fullDiskAccess", "all"])
        .optional()
        .describe("Which permission (default accessibility for request, all for open)."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => {
      const action = String(args.action ?? "status");
      const kind = String(args.kind ?? "accessibility") as PermKind | "all";
      if (action === "status") return { ok: true, message: await diagnose() };
      if (action === "open") {
        const opened = await openPane(kind);
        return opened.length
          ? { ok: true, message: `Opened System Settings pane(s): ${opened.join(", ")}.` }
          : { ok: false, message: "Could not open System Settings." };
      }
      const kinds: PermKind[] =
        kind === "all" ? ["accessibility", "screenRecording", "automation", "fullDiskAccess"] : [kind];
      const outcomes = await requestPermissions(kinds);
      if (action === "fix") await openPane(kinds.length > 1 ? "all" : kinds[0]);
      const lines = outcomes.map((o) => `- ${o.kind}: ${o.result} - ${o.note}`);
      return {
        ok: true,
        message: `${lines.join("\n\n")}\n\n${await diagnose()}`,
      };
    },
  );

  // --- durable tasks -------------------------------------------------------
  // The task tools are the long-running layer: a plan lives on disk, a step is
  // only done when its check passes, and closing a task re-checks the success
  // criteria instead of trusting the transcript.
  const checkSchema: z.ZodTypeAny = z.object({
    kind: z.enum(["shell", "file", "absent", "windowTitle", "uiText", "tool", "wait"]),
    cmd: z.string().optional().describe("shell: the command to run."),
    cwd: z.string().optional().describe("shell: working directory."),
    path: z.string().optional().describe("file/absent: path to test."),
    pattern: z.string().optional().describe("Regex for windowTitle, uiText or shell output."),
    app: z.string().optional().describe("windowTitle/uiText: limit to this app."),
    tool: z.string().optional().describe("tool: registered tool name to call."),
    args: z.record(z.any()).optional().describe("tool: arguments for that tool."),
    expect: z.string().optional().describe("tool/shell: extra regex the result must match."),
    until: z.lazy(() => checkSchema).optional().describe("wait: the condition to poll."),
    seconds: z.number().optional().describe("wait: how long to poll (default 30)."),
  });

  const stepSchema = z.object({
    text: z.string().describe("What this step does, in plain words."),
    tool: z.string().optional().describe("Registered tool name, or shell, or sleep."),
    args: z.record(z.any()).optional().describe("Arguments for that tool. For shell use {cmd, cwd}."),
    verify: checkSchema.optional().describe("How to prove the step worked. Without it the step ends unverified."),
    dependsOn: z.array(z.string()).optional().describe("Step ids that must finish first (defaults to the previous step)."),
    retries: z.number().int().min(0).max(10).optional().describe("How many times to re-check after a failure."),
    replay: z.boolean().optional().describe("Allow the action itself to run again on retry. Off by default."),
    timeoutSeconds: z.number().int().min(5).max(3600).optional(),
    approval: z.boolean().optional().describe("Force an approval gate even when the step looks harmless."),
  });

  const renderTask = (task: Task, logLines = 10): string => {
    const progress = progressOf(task);
    const lines = [summaryLine(task), `Goal: ${task.goal || "(not stated)"}`];
    lines.push(`Steps (${progress.done}/${progress.total} verified):`);
    for (const step of task.steps) lines.push(`  ${describeStep(step)}`);
    if (task.acceptance.length) {
      lines.push("Acceptance:");
      for (const entry of task.acceptance) {
        lines.push(`  ${entry.id} [${entry.met ? "met" : "unmet"}] ${entry.text}${entry.evidence ? `  evidence: ${entry.evidence}` : ""}`);
      }
    }
    const log = readLog(task.id, logLines) as Array<Record<string, any>>;
    if (log.length) {
      lines.push("Recent log:");
      for (const entry of log) {
        const stamp = String(entry.at ?? "").slice(11, 19);
        const target = entry.step ? ` ${entry.step}` : entry.acceptance ? ` ${entry.acceptance}` : "";
        const verdict = entry.status ? ` -> ${entry.status}` : entry.ok === undefined ? "" : entry.ok ? " ok" : " failed";
        lines.push(`  ${stamp} ${entry.event}${target}${verdict}`);
      }
    }
    if (isRunning(task.id)) lines.push("This task is currently running in another process.");
    return lines.join("\n");
  };

  addTool(
    "screen_observe",
    "Read the screen in one call",      "Unified view of what is on screen: front app, window title and bounds, every display with its Retina scale, the accessibility tree, and detected states (dialog, permission prompt, loading, open menu), plus an optional screenshot and a coarse thumbprint for before/after comparison. " +
      "A window that exists but is not drawn is reported, which is how a minimized window or one on another Space shows up. context adds the trail of apps and windows this session already worked with. Start here instead of guessing coordinates. ui_do takes a target from this tree.",
    {
      app: z.string().optional().describe("App to read. Defaults to the app that owns the frontmost window."),
      depth: z.number().int().min(1).max(12).optional().describe("Tree depth to walk (default 7)."),
      maxNodes: z.number().int().min(10).max(2000).optional().describe("Node budget (default 400)."),
      screenshot: z.boolean().optional().describe("Also capture a screenshot and hash a downscaled copy, for visual before and after checks."),
      context: z.boolean().optional().describe("Also report the stored trail of apps and windows this session observed, for multi-app workflows."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => {
      try {
        const screen = await observe({ app: args.app, depth: args.depth, maxNodes: args.maxNodes, screenshot: args.screenshot === true, context: args.context === true });
        const message = summarizeScreen(screen);
        return { ok: Boolean(screen.app), message };
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    },
  );

  addTool(
    "ui_do",
    "Act on an element by name, with verification",
    "Resolves an element by name, role or identifier, picks the most reliable method the app supports (direct accessibility action, then a menu shortcut, then the app's scripting command, and only then a click on the element's current bounds), performs it, then looks again and reports what changed. " +
      "Returns verified: no when nothing observable changed, instead of claiming success. dryRun returns the ranked candidates and the chosen method without acting. Focus drift and a window moving under a click are handled by one automatic retry. resume continues with the app this session last observed instead of the frontmost one.",
    {
      app: z.string().optional().describe("App to act on. Defaults to the frontmost app."),
      name: z.string().optional().describe("Visible label of the target, for example the button title."),
      role: z.string().optional().describe("Accessibility role to narrow the search, for example button, text field, menu item."),
      identifier: z.string().optional().describe("Accessibility identifier when the app publishes one."),
      text: z.string().optional().describe("Alias for name when matching text inside the element."),
      index: z.number().int().min(0).max(50).optional().describe("Pick the Nth best candidate when several match."),
      action: z.enum(["press", "set_value", "click", "shortcut"]).optional().describe("press by default; set_value fills a field; click forces the geometric path; shortcut sends keys."),
      value: z.string().optional().describe("Value for action=set_value."),
      keys: z.array(z.string()).optional().describe("Keys for action=shortcut, for example [\"cmd\",\"s\"]."),
      intent: z.string().optional().describe("Command intent used to find a shortcut or scripted command, for example save, print, new document."),
      method: z.string().optional().describe("Force a method: ax_press, ax_set_value, shortcut, applescript_command, pointer_click."),
      dryRun: z.boolean().optional().describe("Report the candidates and the plan without acting."),
      verify: z.boolean().optional().describe("Default true. Set false to skip the before and after comparison."),
      depth: z.number().int().min(1).max(16).optional().describe("Accessibility traversal depth (default 8)."),
      maxNodes: z.number().int().min(50).max(4000).optional().describe("Accessibility node budget (default 500; raise for very large app menus)."),
      resume: z.boolean().optional().describe("Use the app this session last observed instead of the frontmost app, for multi-app workflows."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async (args) => {
      try {
        const result = await uiDo({
          app: args.app,
          name: args.name,
          role: args.role,
          identifier: args.identifier,
          text: args.text,
          index: args.index,
          action: args.action,
          value: args.value,
          keys: args.keys,
          intent: args.intent,
          method: args.method,
          dryRun: args.dryRun === true,
          verify: args.verify !== false,
          depth: args.depth,
          maxNodes: args.maxNodes,
          resume: args.resume === true,
        });
        return { ok: result.ok, message: result.message };
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    },
  );

  addTool(
    "doc",
    "Rendered document checks and rollback",      "Reads the exported PDF, not the document model, so it reports what the pages actually look like: blank pages, text outside the page box, text pushed to the bottom edge, text boxes stacked on top of other text, and page count. " +
      "compare reports per page whether the text changed and whether the rendering changed. backup, backups and restore give an edit run a way back, and restore keeps the version it replaced.",
    {
      action: z.enum(["qa", "compare", "backup", "backups", "restore"]).describe("What to do."),
      path: z.string().describe("PDF to check, or the document to back up or restore."),
      comparePath: z.string().optional().describe("For compare: the earlier PDF."),
      render: z.boolean().optional().describe("For qa: also render each page and hash it, which makes before and after comparison possible."),
      firstPage: z.number().int().min(1).optional().describe("For qa: first page to report."),
      lastPage: z.number().int().min(1).optional().describe("For qa: last page to report."),
      label: z.string().optional().describe("For backup: a name for this version, for example before-styling."),
      backup: z.string().optional().describe("For restore: the backup label. Defaults to the newest."),
      limit: z.number().int().min(1).max(5000).optional().describe("For backups: maximum recent backups to return (default 100)."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (args) => {
      try {
        if (args.action === "qa") {
          const report = await qaPdf({ file: args.path, render: args.render === true, firstPage: args.firstPage, lastPage: args.lastPage });
          const lines = [
            `${report.pages} page(s), ${report.totals.chars} characters${report.pageSize ? `, page ${Math.round(report.pageSize.width)}x${Math.round(report.pageSize.height)} points` : ""}`,
          ];
          if (report.problems.length) {
            lines.push(`problems (${report.problems.length}):`);
            for (const problem of report.problems) lines.push(`  - ${problem}`);
          } else {
            lines.push("no blank, clipped, crowded or overlapping pages found");
          }
          if (report.warnings.length) lines.push(...report.warnings.map((warning) => `warning: ${warning}`));
          const shown = report.detail.slice(0, 12);
          if (shown.length) {
            lines.push("pages:");
            for (const page of shown) {
              lines.push(
                `  ${page.page}: ${page.chars} chars${page.empty ? " EMPTY" : ""}${page.clipped ? " CLIPPED" : ""}${page.crowded ? " CROWDED" : ""}${(page.overlaps ?? 0) > 0 ? ` OVERLAP(${page.overlaps})` : ""}${page.hash ? ` hash=${page.hash}` : ""} ${page.snippet.slice(0, 70)}`,
              );
            }
          }
          return { ok: report.problems.length === 0, message: lines.join("\n") };
        }
        if (args.action === "compare") {
          if (!args.comparePath) return { ok: false, message: "compare needs comparePath (the earlier PDF)." };
          const diff = await comparePdf(args.comparePath, args.path);
          const lines = [
            `${diff.sameShape ? "same page count and page size" : "the document shape changed"}, page count ${diff.pageDelta >= 0 ? "+" : ""}${diff.pageDelta}`,
            diff.changedPages.length ? `${diff.changedPages.length} page(s) changed:` : "no page changed",
          ];
          for (const page of diff.changedPages.slice(0, 20)) {
            lines.push(`  page ${page.page}: text ${page.textChanged ? "changed" : "same"}, rendering ${page.visualChanged ? "changed" : "same"}`);
          }
          lines.push(...diff.notes);
          return { ok: true, message: lines.join("\n") };
        }
        if (args.action === "backup") {
          const entry = backupDocument(args.path, args.label);
          return { ok: true, message: `Saved ${entry.label} at ${entry.file} (${entry.size} bytes).` };
        }
        if (args.action === "backups") {
          const entries = listBackups(args.path, args.limit ?? 100);
          if (!entries.length) return { ok: true, message: "No backups for that document yet. doc action=backup creates one." };
          return { ok: true, message: entries.map((entry) => `${entry.label}  ${entry.size} bytes`).join("\n") };
        }
        const restored = restoreBackup(args.path, args.backup);
        return { ok: restored.ok, message: restored.message };
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    },
  );

  addTool(
    "project_context",
    "Scoped repo instructions and durable project memory",
    "Codex-compatible project context. instructions loads ~/.codex/AGENTS.md plus AGENTS.md/AGENTS.override.md from the repo root down to the focused file. snapshot returns live git/check/task context; write stores a compact durable handoff outside the repo; resume combines saved state with current instructions and live repo state so a fresh chat can continue without reconstructing everything.",
    {
      action: z.enum(["instructions", "snapshot", "write", "read", "resume", "clear"]),
      root: z.string().optional().describe("Project/repository root. Defaults to the server working directory."),
      focus: z.string().optional().describe("File or directory whose scoped AGENTS.md chain should apply."),
      taskId: z.string().optional().describe("Optional durable task id to include in snapshot/resume or save in project memory."),
      summary: z.string().optional().describe("write: compact current-state summary."),
      decisions: z.array(z.string()).optional().describe("write: decisions that must survive context loss."),
      next: z.array(z.string()).optional().describe("write: next actions in priority order."),
      risks: z.array(z.string()).optional().describe("write: unresolved risks/blockers."),
      checks: z.array(z.string()).optional().describe("write: known validation commands or acceptance checks."),
      maxChars: z.number().int().min(2000).max(100000).optional().describe("Maximum returned characters (default 40000)."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => {
      try {
        const r = await projectContext({
          ...args,
          root: args.root ?? process.cwd(),
        });
        return { ok: r.ok, message: r.message };
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    },
  );

  addTool(
    "project_review",
    "Deterministic pre-ship review gate",
    "Reviews the current project before declaring work done. quick checks git whitespace errors, unresolved conflict markers, suspicious credentials, oversized changed files and TODO/FIXME/HACK markers. full additionally runs detected typecheck/lint/test/build commands; commands overrides the auto-detected checks. With includeDiff=true it also returns a bounded patch so the calling model can perform semantic review in the same turn.",
    {
      root: z.string().optional().describe("Project/repository root. Defaults to the server working directory."),
      mode: z.enum(["quick", "full"]).optional().describe("quick is static-only; full also runs detected validation commands."),
      paths: z.array(z.string()).optional().describe("Review these paths instead of all changed git files."),
      commands: z.array(z.string()).optional().describe("Explicit validation commands to run after static review."),
      timeoutSeconds: z.number().int().min(5).max(3600).optional().describe("Per-command timeout, default 300 seconds."),
      maxIssues: z.number().int().min(5).max(200).optional().describe("Maximum reported issues, default 60."),
      includeDiff: z.boolean().optional().describe("Append bounded staged/working diffs for semantic model review."),
      diffChars: z.number().int().min(2000).max(80000).optional().describe("Maximum diff characters when includeDiff=true, default 20000."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => {
      try {
        const r = await projectReview({
          ...args,
          root: args.root ?? process.cwd(),
        });
        return { ok: r.ok, message: r.message };
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    },
  );

  addTool(
    "code_index",
    "Symbol index, symbol search and project summary",
    "build walks the repository and records every function, type, class, protocol and kernel declaration with its file and line, so later searches are instant and exact. " +
      "find searches those declarations by name or file. summary reads the manifests, test layout, git state and TODO count, which is what a new contributor needs first.",
    {
      action: z.enum(["build", "find", "summary"]).describe("What to do."),
      root: z.string().optional().describe("Repository root. Defaults to the working directory."),
      query: z.string().optional().describe("For find: symbol or file text to match."),
      kind: z.string().optional().describe("For find: restrict to one declaration kind, for example function, struct, kernel."),
      limit: z.number().int().min(1).max(200).optional().describe("For find: maximum hits (default 20)."),
      rebuild: z.boolean().optional().describe("For find: rebuild the index before searching."),
      maxFiles: z.number().int().min(10).max(250000).optional().describe("Index budget: maximum files walked (default 10000)."),
      maxFileSizeKB: z.number().int().min(4).max(32768).optional().describe("Index budget: skip individual source files larger than this many KiB (default 512)."),
      maxBytesMB: z.number().int().min(1).max(4096).optional().describe("Index budget: maximum aggregate source bytes parsed (default 128 MiB)."),
      maxSymbols: z.number().int().min(1000).max(2000000).optional().describe("Index budget: maximum declarations retained (default 250000)."),

    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => {
      try {
        if (args.action === "build") {
          const record = await indexRepo({ root: args.root, maxFiles: args.maxFiles, maxFileSize: args.maxFileSizeKB ? args.maxFileSizeKB * 1024 : undefined, maxBytes: args.maxBytesMB ? args.maxBytesMB * 1024 * 1024 : undefined, maxSymbols: args.maxSymbols });
          const languages = Object.entries(record.languages).map(([name, count]) => `${name} ${count}`).join(", ") || "none";
          return { ok: true, message: `Indexed ${record.files} walked file(s), ${record.symbols} symbol(s), ${(record.bytesIndexed ?? 0) / 1024 / 1024 < 10 ? ((record.bytesIndexed ?? 0) / 1024 / 1024).toFixed(2) : ((record.bytesIndexed ?? 0) / 1024 / 1024).toFixed(1)} MiB parsed (${languages}), skipped ${record.skipped}${record.limited ? " [budget limit reached]" : ""}. Written to ${record.file}` };
        }
        if (args.action === "find") {
          if (!args.query) return { ok: false, message: "find needs a query." };
          const found = await findSymbols({ root: args.root, query: args.query, kind: args.kind, limit: args.limit, rebuild: args.rebuild === true, maxFiles: args.maxFiles, maxFileSize: args.maxFileSizeKB ? args.maxFileSizeKB * 1024 : undefined, maxBytes: args.maxBytesMB ? args.maxBytesMB * 1024 * 1024 : undefined, maxSymbols: args.maxSymbols });
          const lines = [`${found.hits.length} hit(s) in ${found.record.files} indexed file(s)${found.rebuildMs ? ` (index rebuilt in ${found.rebuildMs}ms)` : ""}`];
          for (const hit of found.hits) lines.push(`  ${hit.kind.padEnd(10)} ${hit.name}  ${hit.file}:${hit.line}`);
          return { ok: found.hits.length > 0, message: lines.join("\n") };
        }
        const summary = await projectSummary(args.root);
        const lines = [
          `root: ${summary.root}`,
          `stack: ${summary.stack.language}${summary.stack.frameworks.length ? ` (${summary.stack.frameworks.join(", ")})` : ""}`,
          `files: ${summary.files}, test files: ${summary.tests}, TODOs: ${summary.todos}`,
        ];
        if (summary.stack.testCommand) lines.push(`test: ${summary.stack.testCommand}`);
        if (summary.stack.buildCommand) lines.push(`build: ${summary.stack.buildCommand}`);
        if (summary.stack.benchmarkCommand) lines.push(`bench: ${summary.stack.benchmarkCommand}`);
        if (summary.entryPoints.length) lines.push(`entry points: ${summary.entryPoints.join(", ")}`);
        if (summary.git) lines.push(`git: ${summary.git.branch}, ${summary.git.dirty} changed file(s), last ${summary.git.lastCommit ?? "?"}`);
        return { ok: true, message: lines.join("\n") };
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    },
  );

  addTool(
    "code_loop",
    "Run acceptance commands until they pass",      "run executes the acceptance commands in a repository, records which failed with their output, and keeps the history, so an iteration has a real verdict instead of an impression. " +
      "resources reports load, free memory and swap: a fanless machine under load does not produce an honest build or benchmark result. history replays what each iteration measured. " +
      "profile samples a running process with the system sampler and returns the frames carrying the most samples, which is where the time actually goes. crashes lists recent crash reports with the top frames of the failing thread.",
    {
      action: z.enum(["run", "history", "resources", "profile", "crashes"]).describe("What to do."),
      target: z.string().optional().describe("For profile: a pid or process name."),
      seconds: z.number().int().min(1).max(60).optional().describe("For profile: how long to sample (default 5)."),
      top: z.number().int().min(3).max(60).optional().describe("For profile and crashes: how many frames or entries to show."),
      app: z.string().optional().describe("For crashes: only reports whose file name contains this."),
      root: z.string().optional().describe("Repository root."),
      goal: z.string().optional().describe("For run: the goal this iteration is serving."),
      id: z.string().optional().describe("For run and history: a stable goal id so iterations group together."),
      iteration: z.number().int().min(1).optional().describe("For run: which iteration this is."),
      acceptance: z
        .array(z.object({ name: z.string(), cmd: z.string(), expect: z.string().optional(), timeoutSeconds: z.number().int().min(1).optional() }))
        .optional()
        .describe("For run: the commands that decide pass or fail, with an optional output pattern each must match."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (args) => {
      try {
        if (args.action === "resources") {
          const state = await assessResources();
          return { ok: state.ok, message: `${state.note}${state.ok ? "" : " Wait for the machine to settle before measuring."}` };
        }
        if (args.action === "profile") {
          if (!args.target) return { ok: false, message: "profile needs target, a pid or a process name." };
          const profiled = await profileProcess({ target: args.target, seconds: args.seconds, top: args.top });
          return { ok: profiled.ok, message: profiled.message };
        }
        if (args.action === "crashes") {
          const crashes = await recentCrashes({ app: args.app, limit: args.top });
          return { ok: crashes.ok, message: crashes.message };
        }
        if (args.action === "history") {
          if (!args.id) return { ok: false, message: "history needs an id." };
          const history = goalHistory(args.id);
          if (!history.length) return { ok: true, message: `No runs recorded for ${args.id} yet.` };
          const lines = history.map(
            (record) => `iteration ${record.iteration} at ${record.createdAt}: ${record.passed ? "passed" : "failed"} (${record.outcomes.filter((outcome) => outcome.ok).length}/${record.outcomes.length}) load ${record.resources.load}`,
          );
          return { ok: true, message: lines.join("\n") };
        }
        if (!args.acceptance?.length) return { ok: false, message: "run needs acceptance commands. Without them there is nothing to pass." };
        const record = await runGoal({
          root: args.root,
          goal: args.goal ?? "acceptance run",
          id: args.id,
          iteration: args.iteration,
          acceptance: args.acceptance,
        });
        const lines = [`${record.id} iteration ${record.iteration}: ${record.passed ? "passed" : "failed"}`];
        for (const outcome of record.outcomes) {
          lines.push(`  ${outcome.ok ? "ok  " : "FAIL"} ${outcome.name} (exit ${outcome.exitCode}, ${outcome.ms}ms)`);
          if (!outcome.ok && outcome.output) lines.push(...outcome.output.split("\n").slice(0, 12).map((line) => `       ${line}`));
        }
        lines.push(`resources: ${record.resources.note}`);
        if (!record.resources.ok) lines.push("this run happened on a loaded machine, so timing numbers from it are not a measurement of the code");
        return { ok: record.passed, message: lines.join("\n") };
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    },
  );

  addTool(
    "bench",
    "Record and compare performance measurements",
    "measure runs a benchmark command, extracts a numeric capture from its output and records it in one step. record stores a supplied sample; compare only compares samples in the same channel, metric and device, so a kernel microbenchmark is never averaged with a full model run, and it says regression, improvement or unchanged against a tolerance.",
    {
      action: z.enum(["measure", "record", "compare", "list"]).describe("What to do."),
      name: z.string().optional().describe("Benchmark name, for example bolt-forward."),
      channel: z.enum(["kernel", "model", "end_to_end", "memory"]).optional().describe("For record: what was measured."),
      metric: z.string().optional().describe("For record: the metric, for example ms_per_token or peak_mb."),
      value: z.number().optional().describe("For record: the measured value."),
      unit: z.string().optional().describe("For record: unit, for example ms."),
      device: z.string().optional().describe("Hardware or configuration the sample came from."),
      note: z.string().optional().describe("For record: anything that could invalidate the sample."),
      tolerancePct: z.number().min(0).max(100).optional().describe("For compare: change within this percentage counts as unchanged (default 5)."),
      cmd: z.string().optional().describe("For measure: benchmark command to run."),
      pattern: z.string().optional().describe("For measure: regex whose first capture group is the numeric result."),
      root: z.string().optional().describe("For measure: working directory for the benchmark command."),
      timeoutSeconds: z.number().int().min(1).max(3600).optional().describe("For measure: command timeout (default 300 seconds)."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (args) => {
      try {
        if (args.action === "measure") {
          if (!args.name || !args.channel || !args.metric || !args.cmd || !args.pattern) {
            return { ok: false, message: "measure needs name, channel, metric, cmd and pattern." };
          }
          let re: RegExp;
          try {
            re = new RegExp(args.pattern, "mi");
          } catch (error) {
            return { ok: false, message: `invalid measure pattern: ${(error as Error).message}` };
          }
          const cwd = args.root ? resolveUserPath(args.root) : process.cwd();
          const measured = await sh(args.cmd, { cwd, timeoutMs: (args.timeoutSeconds ?? 300) * 1000 });
          const output = `${measured.out}
${measured.err}`.trim();
          if (!measured.ok) {
            return {
              ok: false,
              message: `benchmark command failed (exit ${measured.code ?? "?"})${measured.timedOut ? " after timeout" : ""}:
${output.slice(0, 4000)}`,
            };
          }
          const match = re.exec(output);
          if (!match) {
            return { ok: false, message: `benchmark passed but output did not match /${args.pattern}/:
${output.slice(0, 4000)}` };
          }
          const captured = String(match[1] ?? match[0]).replace(/,/g, "").trim();
          const value = Number(captured);
          if (!Number.isFinite(value)) {
            return { ok: false, message: `benchmark pattern matched ${JSON.stringify(captured)}, which is not a finite number.` };
          }
          const sample = recordBenchmark({
            name: args.name,
            channel: args.channel,
            metric: args.metric,
            value,
            unit: args.unit,
            device: args.device,
            note: args.note,
          });
          return {
            ok: true,
            message:
              `Measured and recorded ${sample.name} ${sample.channel} ${sample.metric}=${sample.value}${sample.unit ? ` ${sample.unit}` : ""} at ${sample.at}
` +
              `matched: ${match[0].slice(0, 240)}`,
          };
        }
        if (args.action === "record") {
          if (!args.name || !args.channel || !args.metric || args.value === undefined) {
            return { ok: false, message: "record needs name, channel, metric and value." };
          }
          const sample = recordBenchmark({
            name: args.name,
            channel: args.channel,
            metric: args.metric,
            value: args.value,
            unit: args.unit,
            device: args.device,
            note: args.note,
          });
          return { ok: true, message: `Recorded ${sample.name} ${sample.channel} ${sample.metric}=${sample.value}${sample.unit ? ` ${sample.unit}` : ""} at ${sample.at}` };
        }
        if (args.action === "compare") {
          if (!args.name) return { ok: false, message: "compare needs a name." };
          const comparisons = compareBenchmarks(readBenchmarks(), args.name, args.tolerancePct ?? 5);
          if (!comparisons.length) return { ok: false, message: `No samples recorded for ${args.name}.` };
          const lines = comparisons.map((item) =>
            item.verdict === "no-baseline"
              ? `${item.channel}/${item.metric}: ${item.current} (only one sample, nothing to compare)`
              : `${item.channel}/${item.metric}: ${item.baseline} -> ${item.current} (${item.changePct! > 0 ? "+" : ""}${item.changePct}%) ${item.verdict.toUpperCase()}`,
          );
          return { ok: !comparisons.some((item) => item.verdict === "regression"), message: lines.join("\n") };
        }
        const samples = readBenchmarks();
        if (!samples.length) return { ok: true, message: "No benchmarks recorded yet. bench action=record adds one." };
        const lines = samples.slice(-40).map((sample) => `${sample.at} ${sample.name} ${sample.channel} ${sample.metric}=${sample.value}${sample.unit ? ` ${sample.unit}` : ""}${sample.device ? ` on ${sample.device}` : ""}`);
        return { ok: true, message: `${samples.length} sample(s):\n${lines.join("\n")}` };
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    },
  );

  addTool(
    "git_work",
    "Review, stage, commit and isolate git work",      "status shows the branch and what changed. diff shows the patch, optionally staged or summarized. stage, unstage and commit act on the repository the caller names. " +
      "checkpoint records the current working tree as a labelled commit without altering it, checkpoints lists them, and restore_checkpoint puts one back while first saving whatever was there, so a restore cannot lose work. " +
      "worktree_create makes an isolated checkout on its own branch so parallel work cannot collide, and worktree_remove takes it away again.",
    {
      action: z
        .enum(["status", "diff", "stage", "unstage", "commit", "checkpoint", "checkpoints", "restore_checkpoint", "worktree_create", "worktree_list", "worktree_remove"])
        .describe("What to do."),
      root: z.string().optional().describe("Repository root."),
      paths: z.array(z.string()).optional().describe("Paths for stage, unstage or diff."),
      message: z.string().optional().describe("For commit: the message."),
      name: z.string().optional().describe("For worktrees: the short name."),
      base: z.string().optional().describe("For worktree_create: the ref to start from (default HEAD)."),
      stat: z.boolean().optional().describe("For diff: show a summary instead of the patch."),
      stage: z.boolean().optional().describe("For diff: show staged changes."),
      id: z.string().optional().describe("For restore_checkpoint: the id from checkpoints."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async (args) => {
      try {
        const result = await gitWork({
          root: args.root,
          action: args.action,
          paths: args.paths,
          message: args.message,
          name: args.name,
          base: args.base,
          stat: args.stat === true,
          stage: args.stage === true,
          id: args.id,
        });
        return { ok: result.ok, message: result.message };
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    },
  );

  addTool(
    "web",
    "Drive a browser by structure, with a visual fallback",      "Structured control of a Chromium browser through the DevTools protocol: tabs, navigation, a DOM outline with stable element ids, locators (css=, text=, role=, label=, id=, xpath=), click, type, text, screenshots, console and network capture, waiting, evaluation, downloads, and page snapshots for change detection. " +
      "Clicks and typing are verified against the url and page text. action=changes reports the exact text lines that appeared or disappeared since the stored snapshot. Downloads go to the tool's own folder unless path names another one. The browser it starts uses its own profile, separate from the person's signed-in profile. engine=safari falls back to Safari for tabs, navigation and text.",
    {
      action: z
        .enum(["status", "tabs", "open", "goto", "dom", "find", "click", "type", "text", "screenshot", "console", "network", "wait", "eval", "snapshot", "changes", "download", "downloads", "close"])
        .describe("What to do."),
      url: z.string().optional().describe("For open and goto."),
      locator: z.string().optional().describe("Element locator: text=Save, role=button, css=#main, label=Email, id=search, xpath=//button."),
      value: z.string().optional().describe("For type: the text to set."),
      text: z.string().optional().describe("For wait: text that must appear."),
      script: z.string().optional().describe("For eval: JavaScript to run in the page."),
      timeoutSeconds: z.number().min(1).max(180).optional().describe("For goto and wait: how long to allow."),
      path: z.string().optional().describe("For screenshot: where to write the png. For download and downloads: the folder to use."),
      port: z.number().int().min(1).max(65535).optional().describe("Debugging port to attach to."),
      tab: z.string().optional().describe("Tab id to use, or the url fragment to pick a tab."),
      limit: z.number().int().min(1).max(500).optional().describe("Maximum items to return."),
      engine: z.enum(["auto", "chromium", "safari"]).optional().describe("auto uses Chromium and falls back to Safari."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async (args) => {
      try {
        const result = await runWeb({
          action: args.action,
          url: args.url,
          locator: args.locator,
          value: args.value,
          text: args.text,
          script: args.script,
          timeoutSeconds: args.timeoutSeconds,
          path: args.path,
          port: args.port,
          tab: args.tab,
          limit: args.limit,
          engine: args.engine,
        });
        return { ok: result.ok, message: result.message };
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    },
  );

  addTool(
    "skill",
    "Save, route and compile reusable workflows",
    "A skill is a saved workflow with trigger phrases, steps, acceptance criteria and a measured success rate. match routes a request to the skills whose phrases appear and ranks them by how often they have passed, so a route with history beats a guess. " +
      "compile turns a skill into a durable task, which brings retries, checkpoints, approval gates and evidence with it. report records a finished task's verdict against the skill. " +
      "seed writes the builtin skills that ship with this tool: a Swift package acceptance loop, Metal kernel and MLX model benchmarking with separate channels, and Apple silicon measurement discipline. An existing skill with the same name is kept.",
    {
      action: z.enum(["save", "list", "show", "match", "compile", "report", "seed"]).describe("What to do."),
      id: z.string().optional().describe("Skill id from list."),
      name: z.string().optional().describe("For save: the skill name."),
      description: z.string().optional().describe("For save: what it accomplishes."),
      when: z.array(z.string()).optional().describe("For save: phrases that should route to this skill."),
      apps: z.array(z.string()).optional().describe("For save: apps it works with."),
      steps: z.array(stepSchema).optional().describe("For save: the steps, each with the tool it runs and a verify check."),
      acceptance: z.array(z.object({ text: z.string(), check: checkSchema.optional() })).optional().describe("For save: how to tell it worked."),
      notes: z.string().optional().describe("For save: anything the next run should know."),
      text: z.string().optional().describe("For match: the request to route."),
      task: z.string().optional().describe("For report: the finished task id."),
      vars: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("For compile: values for {{variable}} placeholders in the saved workflow."),
      limit: z.number().int().min(1).max(500).optional().describe("For match: how many candidates (default 5). For list: maximum skills shown (default 100)."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (args) => {
      try {
        if (args.action === "save") {
          if (!args.name) return { ok: false, message: "save needs a name." };
          const existing = loadSkill(args.id ?? args.name);
          const skill = saveSkill({
            id: existing?.id,
            name: args.name,
            description: args.description ?? existing?.description,
            when: args.when ?? existing?.when,
            apps: args.apps ?? existing?.apps,
            steps: (args.steps as StepInput[] | undefined) ?? existing?.steps,
            acceptance: args.acceptance ?? existing?.acceptance,
            notes: args.notes ?? existing?.notes,
            createdAt: existing?.createdAt,
            stats: existing?.stats,
          });
          return { ok: true, message: `Saved ${describeSkill(skill)}` };
        }
        if (args.action === "seed") {
          const seeded = seedBuiltinSkills();
          const lines = [];
          if (seeded.created.length) lines.push(`Added ${seeded.created.length} builtin skill(s): ${seeded.created.join(", ")}.`);
          if (seeded.updated.length) lines.push(`Updated ${seeded.updated.length} builtin skill(s) in place: ${seeded.updated.join(", ")}.`);
          if (!seeded.created.length && !seeded.updated.length) lines.push("All builtin skills were already present.");
          if (seeded.existing.length) lines.push(`Kept the existing copies of: ${seeded.existing.join(", ")}.`);
          return { ok: true, message: lines.join("\n") };
        }
        if (args.action === "list") {
          const skills = listSkills().slice(0, args.limit ?? 100);
          return { ok: true, message: skills.length ? skills.map(describeSkill).join("\n\n") : "No skills saved yet. skill action=save adds one after a workflow works." };
        }
        if (args.action === "show") {
          const skill = args.id ? loadSkill(args.id) : undefined;
          if (!skill) return { ok: false, message: "No skill by that id. skill action=list shows them." };
          const lines = [describeSkill(skill)];
          skill.steps.forEach((step, index) => lines.push(`  ${index + 1}. ${step.tool ?? "shell"}: ${step.text}`));
          if (skill.notes) lines.push(`  notes: ${skill.notes}`);
          return { ok: true, message: lines.join("\n") };
        }
        if (args.action === "match") {
          if (!args.text) return { ok: false, message: "match needs text." };
          const matches = matchSkills(args.text, listSkills(), args.limit ?? 5);
          if (!matches.length) return { ok: true, message: "No saved skill matches. Plan a task instead, then save the plan as a skill once it works." };
          return {
            ok: true,
            message: matches.map((match) => `${match.skill.id}  ${match.skill.name}  score ${match.score}\n  ${match.reasons.join("; ")}`).join("\n"),
          };
        }
        if (args.action === "compile") {
          const skill = args.id ? loadSkill(args.id) : undefined;
          if (!skill) return { ok: false, message: "compile needs a skill id." };
          const task = createTask(compileSkill(skill, {}, args.vars ?? {}));
          appendLog(task.id, { event: "compiled", skill: skill.id });
          return { ok: true, message: `Compiled ${skill.name} into ${task.id} with ${task.steps.length} step(s). task_run executes it; task_close refuses done without evidence.` };
        }
        const skill = args.id ? loadSkill(args.id) : undefined;
        if (!skill) return { ok: false, message: "report needs a skill id." };
        if (!args.task) return { ok: false, message: "report needs the finished task id." };
        const updated = recordTaskForSkill(skill.id, args.task);
        if (!updated) return { ok: false, message: `No task ${args.task}.` };
        return { ok: true, message: `Recorded ${args.task} against ${updated.name}: ${updated.stats.passed}/${updated.stats.runs} runs passed.` };
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    },
  );

  addTool(
    "task_plan",
    "Plan a durable task",
    "Write a plan to disk: a goal, named success criteria with the check that proves each one, and ordered steps that name the tool they run. " +
      "A step without a verify check still runs but ends unverified, and the task cannot close as done on unverified work. " +
      "Steps that touch anything destructive are gated until task_approve clears them. Use task_run to execute, task_status to inspect.",
    {
      title: z.string().describe("Short name for the task."),
      goal: z.string().optional().describe("What finished looks like, in one or two sentences."),
      acceptance: z
        .array(z.object({ text: z.string(), check: checkSchema.optional() }))
        .optional()
        .describe("Success criteria. Each needs a check to be verifiable."),
      steps: z.array(stepSchema).optional(),
      apps: z.array(z.string()).optional().describe("Apps this plan works with, kept as context for later runs."),
      files: z.array(z.string()).optional().describe("Files this plan works with."),
      root: z.string().optional().describe("Project root. Links task_resume to scoped AGENTS.md instructions, saved project state and live git context."),
      maxSteps: z.number().int().min(1).max(10000).optional().describe("Step budget per task_run call (default 25, max 10000)."),
      maxMinutes: z.number().int().min(1).max(10080).optional().describe("Wall clock budget for the whole task in minutes (default 60, max 7 days)."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (args) => {
      try {
        const task = createTask({
          title: args.title,
          goal: args.goal,
          acceptance: args.acceptance,
          steps: (args.steps ?? []) as StepInput[],
          apps: args.apps,
          files: args.files,
          root: args.root ? path.resolve(resolveUserPath(args.root)) : undefined,
          maxSteps: args.maxSteps,
          maxMinutes: args.maxMinutes,
        });
        appendLog(task.id, { event: "created", title: task.title, steps: task.steps.length });
        const gated = stepsNeedApproval(task);
        const note = gated.length ? `\nApproval needed before these run: ${gated.map((s) => s.id).join(", ")}.` : "";
        return { ok: true, message: `Created ${task.id}.\n${renderTask(task, 0)}${note}` };
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    },
  );

  addTool(
    "task_run",
    "Run the next steps of a task",
    "Executes the steps that can run now, in order, and verifies each one. A failed step stops the run unless stopOnFailure is false. " +
      "Progress is written to disk after every step, so an interrupted run resumes from the last verified one. dryRun reports what would run without doing it.",
    {
      id: z.string().describe("Task id from task_plan."),
      maxSteps: z.number().int().min(1).max(50).optional().describe("How many steps this call may run (default 5)."),
      dryRun: z.boolean().optional().describe("Report the next step without executing anything."),
      stopOnFailure: z.boolean().optional().describe("Default true. Set false to keep going past a failed step."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async (args) => {
      try {
        const report = await runTask(String(args.id), {
          maxSteps: args.maxSteps,
          dryRun: args.dryRun === true,
          stopOnFailure: args.stopOnFailure !== false,
        });
        return { ok: report.stopped !== "failure" && report.stopped !== "locked", message: report.message };
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    },
  );

  addTool(
    "task_status",
    "Inspect a task",
    "One task with its steps, evidence, acceptance results and recent log, or every open task when no id is given.",
    {
      id: z.string().optional().describe("Task id. Omit to list open tasks."),
      all: z.boolean().optional().describe("Include closed tasks in the recent-task list."),
      limit: z.number().int().min(1).max(1000).optional().describe("When listing without id, maximum recent tasks to return (default 100)."),
      logLines: z.number().int().min(0).max(100).optional().describe("How many log entries to show (default 10)."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => {
      try {
        if (!args.id) {
          const tasks = listTasks(args.all === true, args.limit ?? 100);
          if (!tasks.length) return { ok: true, message: "No open tasks. task_plan creates one." };
          const lines = tasks.map((task) => `  ${summaryLine(task)}${isRunning(task.id) ? "  RUNNING" : ""}`);
          return { ok: true, message: `${tasks.length} task(s):\n${lines.join("\n")}` };
        }
        const task = requireTask(String(args.id));
        return { ok: true, message: renderTask(task, args.logLines ?? 10) };
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    },
  );

  addTool(
    "task_next",
    "What a task should do next",
    "The single next thing to run, or the approval that is holding the task up, or why nothing can run.",
    {
      id: z.string().describe("Task id."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => {
      try {
        const task = requireTask(String(args.id));
        const next = runnableSteps(task)[0];
        if (next) return { ok: true, message: `Next: ${describeStep(next)}\nRun it with task_run id=${task.id}.` };
        const gated = stepsNeedApproval(task);
        if (gated.length) {
          return { ok: true, message: `Waiting for approval:\n${gated.map((step) => `  ${describeStep(step)}`).join("\n")}\nClear it with task_approve.` };
        }
        return { ok: true, message: `Nothing runnable in ${task.id}. task_status shows the blockers and the log.` };
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    },
  );

  addTool(
    "task_approve",
    "Approve a gated step",
    "Clears the approval gate on one step, or on every gated step. Steps that run destructive commands stay blocked until this is called.",
    {
      id: z.string().describe("Task id."),
      step: z.string().optional().describe("Step id to approve."),
      all: z.boolean().optional().describe("Approve every gated step."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => {
      try {
        const task = requireTask(String(args.id));
        const gated = stepsNeedApproval(task);
        const targets = args.all === true ? gated.map((step) => step.id) : args.step ? [String(args.step)] : [];
        if (!targets.length) {
          return { ok: false, message: `Nothing to approve. ${gated.length ? `Gated steps: ${gated.map((s) => s.id).join(", ")}.` : "No step is waiting for approval."}` };
        }
        const approved: string[] = [];
        for (const id of targets) {
          const step = task.steps.find((candidate) => candidate.id === id);
          if (!step) continue;
          step.approved = true;
          step.approvedAt = new Date().toISOString();
          approved.push(id);
          appendLog(task.id, { event: "approved", step: id, at: step.approvedAt });
        }
        saveTask(task);
        return approved.length
          ? { ok: true, message: `Approved ${approved.join(", ")}. task_run can now execute ${approved.length > 1 ? "them" : "it"}.` }
          : { ok: false, message: `No matching step in ${task.id}.` };
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    },
  );

  addTool(
    "task_steer",
    "Change a plan mid-run",
    "Adjust a task while it is going: record a note on a step, insert a new step, skip a step, or put a failed step back to pending. " +
      "This is how a correction from the user lands in the plan instead of only in the conversation.",
    {
      id: z.string().describe("Task id."),
      action: z.enum(["note", "insert", "skip", "retry"]),
      step: z.string().optional().describe("Step id the action applies to (or the step to insert after)."),
      text: z.string().optional().describe("note: the note. insert: what the new step does."),
      tool: z.string().optional().describe("insert: tool name."),
      args: z.record(z.any()).optional().describe("insert: tool arguments."),
      verify: checkSchema.optional().describe("insert: how the new step is proven."),
      approval: z.boolean().optional().describe("insert: gate the new step."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (args) => {
      try {
        const task = requireTask(String(args.id));
        if (task.status === "done" || task.status === "failed") {
          return { ok: false, message: `${task.id} is closed (${task.status}). Plan a new task instead of editing a finished one.` };
        }
        if (args.action === "note") {
          const step = args.step ? task.steps.find((candidate) => candidate.id === args.step) : undefined;
          if (step) step.note = String(args.text ?? "").slice(0, 500);
          else task.context.facts["note"] = String(args.text ?? "").slice(0, 500);
          saveTask(task);
          appendLog(task.id, { event: "note", step: args.step, text: args.text });
          return { ok: true, message: `Noted on ${step ? step.id : "the task"}: ${args.text}` };
        }
        if (args.action === "skip") {
          const step = task.steps.find((candidate) => candidate.id === args.step);
          if (!step) return { ok: false, message: `No step ${args.step} in ${task.id}.` };
          step.status = "skipped";
          step.note = String(args.text ?? "skipped").slice(0, 300);
          saveTask(task);
          appendLog(task.id, { event: "skipped", step: step.id });
          return { ok: true, message: `Skipped ${step.id}. Steps that depend on it may now be blocked.` };
        }
        if (args.action === "retry") {
          const step = task.steps.find((candidate) => candidate.id === args.step);
          if (!step) return { ok: false, message: `No step ${args.step} in ${task.id}.` };
          step.status = "pending";
          step.evidence = undefined;
          saveTask(task);
          appendLog(task.id, { event: "requeued", step: step.id });
          return { ok: true, message: `${step.id} is pending again. task_run will pick it up.` };
        }
        if (!args.text) return { ok: false, message: "insert needs text describing the new step." };
        const index = args.step ? task.steps.findIndex((candidate) => candidate.id === args.step) : task.steps.length - 1;
        const newId = `s${task.steps.length + 1}`;
        const anchor = index >= 0 ? task.steps[index] : undefined;
        task.steps.splice(index + 1, 0, {
          id: newId,
          text: String(args.text),
          tool: args.tool,
          args: args.args,
          verify: args.verify,
          dependsOn: anchor ? [anchor.id] : [],
          retries: 0,
          replay: false,
          timeoutSeconds: 300,
          approval: args.approval === true,
          approved: false,
          status: "pending",
          attempts: 0,
        });
        saveTask(task);
        appendLog(task.id, { event: "inserted", step: newId, text: args.text });
        return { ok: true, message: `Inserted ${newId} after ${anchor ? anchor.id : "the end"}: ${args.text}` };
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    },
  );

  addTool(
    "task_close",
    "Finish a task",
    "Re-runs every acceptance check, records the evidence, and refuses to close as done while any criterion is unmet or unproven. " +
      "force records the task as finished anyway, with the unmet criteria written into the reason.",
    {
      id: z.string().describe("Task id."),
      force: z.boolean().optional().describe("Close even without passing checks, marking the gap in the reason."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => {
      try {
        const task = requireTask(String(args.id));
        await evaluateAcceptance(task);
        const blockers = acceptanceBlockers(task);
        const unfinished = task.steps.filter((step) => step.status !== "done" && step.status !== "skipped");
        if ((blockers.length || unfinished.length) && args.force !== true) {
          const lines = [`Not closing ${task.id} yet.`];
          if (blockers.length) lines.push(`Unmet criteria:\n${blockers.map((entry) => `  ${entry}`).join("\n")}`);
          if (unfinished.length) lines.push(`Unfinished steps: ${unfinished.map((step) => `${step.id} (${step.status})`).join(", ")}`);
          lines.push("Fix the gap, adjust the plan with task_steer, or pass force to record it as unfinished work.");
          return { ok: false, message: lines.join("\n") };
        }
        task.status = "done";
        task.closedAt = new Date().toISOString();
        task.closeReason =
          blockers.length || unfinished.length
            ? `forced: ${blockers.length} unmet criteria, ${unfinished.length} unfinished steps`
            : "every acceptance criterion verified";
        saveTask(task);
        appendLog(task.id, { event: "closed", reason: task.closeReason });
        return { ok: true, message: `Closed ${task.id}. ${task.closeReason}.` };
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    },
  );

  addTool(
    "task_resume",
    "Resume a task after an interruption",
    "Reads the task from disk, re-checks the acceptance criteria, and reports the last verified step, the next one to run and anything waiting on approval. " +
      "Use it at the start of a new conversation so work continues instead of restarting.",
    {
      id: z.string().optional().describe("Task id. Omit to list open tasks and pick one."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => {
      try {
        if (!args.id) {
          const tasks = listTasks(false, 50);
          if (!tasks.length) return { ok: true, message: "No open task to resume. task_plan starts one." };
          return { ok: true, message: `Open tasks:\n${tasks.map((task) => `  ${summaryLine(task)}`).join("\n")}\nPass one of these ids to resume it.` };
        }
        const task = requireTask(String(args.id));
        const stale = refreshStaleEvidence(task);
        await evaluateAcceptance(task);
        const verified = task.steps.filter((step) => step.status === "done").map((step) => step.id);
        const next = runnableSteps(task)[0];
        const gated = stepsNeedApproval(task);
        const lines = [renderTask(task, 6)];
        const projectRoot = task.context.facts.root;
        if (projectRoot) {
          const project = await projectContext({ root: projectRoot, action: "resume", taskId: task.id, maxChars: 12000 });
          if (project.ok) lines.push("", "Project resume context:", project.message);
        }
        if (stale.length) lines.push(`Re-queued because their definition changed: ${stale.join(", ")}`);
        lines.push(`Last verified step: ${verified.length ? verified[verified.length - 1] : "none yet"}`);
        lines.push(next ? `Next to run: ${describeStep(next)}` : "Nothing runnable right now.");
        if (gated.length) lines.push(`Waiting on approval: ${gated.map((step) => step.id).join(", ")}`);
        lines.push(next ? `Continue with task_run id=${task.id}.` : "Adjust the plan with task_steer or close it with task_close.");
        return { ok: true, message: lines.join("\n") };
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    },
  );

  audit({
    event: "server_created",
    summary: `tools=run_command,write_file,download_file,search_files,read_file,list_directory,pages_status,pages_create,pages_read,pages_inspect,pages_verify,pages_styles,pages_replace,pages_edit,pages_format,pages_table,pages_export,pages_find,pages_stats,pages_insert_image,pages_insert_textbox,pages_objects,pages_duplicate,pages_layout,pages_text_layout,pages_document_layout,pages_section_layout,iwork_ui_control,iwork_arrange,iwork_items,iwork_apps,iwork_document,iwork_shapes,iwork_export,iwork_script,numbers_create,numbers_inspect,numbers_verify,numbers_find,numbers_stats,numbers_sheets,numbers_tables,numbers_cells,keynote_create,keynote_inspect,keynote_verify,keynote_find,keynote_stats,keynote_slides,keynote_content,keynote_notes,keynote_document,keynote_slide_format,keynote_transition,keynote_charts,keynote_image_slides,keynote_show,mac_apps,mac_ui,mac_system,mac_finder,mac_shortcuts,screen_capture,window_list,mouse,keyboard,ui_tree,ui_find,ui_act,window_control,app_control,system_info,process_list,process_control,network_info,power,audio,speak,media,shell_session,wait_for,file_ops,spotlight,recent_files,browser,calendar,reminders,notes,contacts,app_config,mac_permissions,project_context,project_review,task_plan,task_run,task_status,task_next,task_approve,task_steer,task_close,task_resume,${CUA_TOOLS.map((t) => t.name).join(",")}`,
  });
  return server;
}

/** Client-facing timeout for a cua tool: room for its own timeout_ms plus startup/screenshot work. */
function cuaTimeoutMs(name: string, args: Record<string, unknown>): number {
  if (name !== "js") return 60_000;
  const requested = typeof args?.timeout_ms === "number" ? args.timeout_ms : 30_000;
  return Math.min(300_000, Math.max(60_000, requested + 30_000));
}

function mimeFor(ext: string): string {
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "ico":
      return "image/x-icon";
    case "heic":
      return "image/heic";
    default:
      return "image/png";
  }
}