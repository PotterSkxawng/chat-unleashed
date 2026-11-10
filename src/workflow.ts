// Workflow tools: long-lived shells, waiting for the world to change, file
// operations the shell-free way, and Spotlight search.
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { loadConfig, resolveUserPath, type AppConfig } from "./config.js";
import { formatBytes, good, failed, run, truncate, type Outcome } from "./exec.js";

// --- shell sessions ------------------------------------------------------

interface Session {
  id: string;
  shell: string;
  cwd: string;
  child: ChildProcess;
  buffer: string;
  startedAt: number;
  lastUsed: number;
  exited: boolean;
  exitCode: number | null;
}

const sessions = new Map<string, Session>();
const MAX_BUFFER = 300_000;

function readSession(id: string): Session | null {
  return sessions.get(id) ?? null;
}

function sessionSummary(s: Session): string {
  return `  ${s.id}  ${s.exited ? `exited(${s.exitCode})` : "running"}  ${formatBytes(s.buffer.length)} buffered  cwd ${s.cwd}  ${s.shell}`;
}

export interface ShellSessionArgs {
  action: "start" | "run" | "read" | "write" | "interrupt" | "stop" | "list";
  id?: string;
  command?: string;
  cwd?: string;
  shell?: string;
  timeoutSeconds?: number;
}

export async function shellSession(args: ShellSessionArgs, config: AppConfig = loadConfig()): Promise<Outcome> {
  if (args.action === "list") {
    const all = [...sessions.values()];
    return good(all.length ? `${all.length} session(s):\n${all.map(sessionSummary).join("\n")}` : "No shell sessions. Start one with action=start.");
  }

  if (args.action === "start") {
    const shell = args.shell ?? process.env.SHELL ?? "/bin/zsh";
    const cwd = args.cwd ? resolveUserPath(args.cwd, config) : config.paths.workspace;
    if (!fs.existsSync(cwd)) return failed(`cwd does not exist: ${cwd}`);
    // A login shell (not interactive): it still loads the machine's PATH and
    // profile, but unlike `-i` it does not depend on a terminal being present,
    // which is what made piped sessions drop the first commands.
    const child = spawn(shell, ["-l"], {
      cwd,
      env: { ...process.env, TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const id = `sh_${randomUUID().slice(0, 8)}`;
    const session: Session = {
      id,
      shell,
      cwd,
      child,
      buffer: "",
      startedAt: Date.now(),
      lastUsed: Date.now(),
      exited: false,
      exitCode: null,
    };
    const append = (chunk: Buffer) => {
      session.buffer += chunk.toString("utf8");
      if (session.buffer.length > MAX_BUFFER) session.buffer = session.buffer.slice(-MAX_BUFFER / 2);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("exit", (code) => {
      session.exited = true;
      session.exitCode = code;
      append(Buffer.from(`\n[session exited with ${code}]\n`));
    });
    child.on("error", (err) => append(Buffer.from(`\n[session error: ${err.message}]\n`)));
    sessions.set(id, session);
    // Prove the shell is actually executing by round-tripping a marker, rather
    // than waiting for a prompt that a piped shell never prints.
    const ready = `__MCP_READY_${randomUUID().slice(0, 6)}__`;
    child.stdin?.write(`printf '${ready}\\n'\n`);
    const deadline = Date.now() + 10_000;
    while (!session.buffer.includes(ready) && !session.exited && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const alive = session.buffer.includes(ready);
    session.buffer = session.buffer.replace(new RegExp(`${ready}\\n?`), "").trim();
    return good(
      alive
        ? `Started ${id} (${shell}) in ${cwd}. Use action=run with id=${id}.`
        : `Started ${id} (${shell}) in ${cwd}, but it did not answer a probe within 10s - it may still be loading its profile.`,
    );
  }

  if (args.action === "stop") {
    const ids = args.id ? [args.id] : [...sessions.keys()];
    if (!ids.length) return good("No sessions to stop.");
    const stopped: string[] = [];
    for (const id of ids) {
      const session = readSession(id);
      if (!session) continue;
      try {
        session.child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      sessions.delete(id);
      stopped.push(id);
    }
    return stopped.length ? good(`Stopped ${stopped.join(", ")}.`) : failed(`No session ${args.id}.`);
  }

  const session = args.id ? readSession(args.id) : [...sessions.values()].pop();
  if (!session) return failed(args.id ? `No session ${args.id}. action=list shows what exists.` : "No session yet: action=start first.");

  if (args.action === "interrupt") {
    session.child.kill("SIGINT");
    return good(`Sent Ctrl-C to ${session.id}.`);
  }

  if (args.action === "read") {
    session.lastUsed = Date.now();
    const text = session.buffer;
    session.buffer = "";
    return good(text ? truncate(text, 40_000) : "(no new output)");
  }

  if (args.action === "write") {
    if (!args.command) return failed("action=write needs command");
    if (session.exited) return failed(`${session.id} has exited; start a new session.`);
    session.child.stdin?.write(`${args.command}\n`);
    session.lastUsed = Date.now();
    return good(`Wrote ${args.command.length} char(s) to ${session.id}. Read the output with action=read.`);
  }

  // run: write, then wait for the next prompt-ish quiet period or the timeout.
  if (!args.command) return failed("action=run needs command");
  if (session.exited) return failed(`${session.id} has exited; start a new session.`);
  const timeoutMs = Math.min((args.timeoutSeconds ?? 30) * 1000, (config.shell.maxTimeoutSeconds ?? 600) * 1000);
  const marker = `__MCP_${randomUUID().slice(0, 6)}__`;
  const before = session.buffer.length;
  session.child.stdin?.write(`${args.command}\nprintf '${marker}%s\\n' "$?"\n`);
  const started = Date.now();
  let exitSeen: number | null = null;
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 120));
    const idx = session.buffer.indexOf(marker, before);
    if (idx >= 0) {
      const after = session.buffer.slice(idx + marker.length);
      const codeLine = after.split("\n")[0]?.trim() ?? "";
      exitSeen = Number(codeLine);
      break;
    }
    if (session.exited) break;
  }
  const text = session.buffer.slice(before);
  session.buffer = "";
  session.lastUsed = Date.now();
  if (exitSeen === null && !session.exited) {
    return good(`${session.id}: still running after ${Math.round((Date.now() - started) / 1000)}s (output so far below). It keeps going in the background.\n${truncate(text, 20_000)}`);
  }
  const code = exitSeen ?? session.exitCode ?? 0;
  const body = text.replace(new RegExp(`${marker}\\d+\\n?`), "").trim();
  return {
    ok: code === 0,
    message: `${session.id} exit=${code}${body ? `\n${truncate(body, 20_000)}` : "\n(no output)"}`,
  };
}

// --- wait_for ------------------------------------------------------------

export interface WaitForArgs {
  condition: "file_exists" | "file_changed" | "port_open" | "url_ok" | "process_running" | "window_title" | "app_running";
  target: string;
  timeoutSeconds?: number;
  intervalMs?: number;
  contains?: string;
  expect?: "present" | "absent";
  port?: number;
  host?: string;
  url?: string;
  app?: string;
  path?: string;
}

async function checkCondition(args: WaitForArgs): Promise<{ met: boolean; detail: string }> {
  const expect = args.expect ?? "present";
  switch (args.condition) {
    case "file_exists": {
      const exists = fs.existsSync(args.target);
      return { met: expect === "present" ? exists : !exists, detail: `${args.target} ${exists ? "exists" : "missing"}` };
    }
    case "file_changed": {
      try {
        const st = fs.statSync(args.target);
        const stamp = `${st.size}:${st.mtimeMs}`;
        return { met: true, detail: `stamp=${stamp}` };
      } catch {
        return { met: false, detail: `${args.target} missing` };
      }
    }
    case "port_open": {
      const port = args.port ?? Number(args.target);
      const host = args.host ?? "127.0.0.1";
      const open = await new Promise<boolean>((resolve) => {
        const socket = net.connect({ host, port, timeout: 1200 });
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("error", () => resolve(false));
        socket.once("timeout", () => {
          socket.destroy();
          resolve(false);
        });
      });
      return { met: expect === "present" ? open : !open, detail: `${host}:${port} ${open ? "open" : "closed"}` };
    }
    case "url_ok": {
      const url = args.url ?? args.target;
      try {
        const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(2500) });
        return { met: expect === "present" ? res.ok : !res.ok, detail: `${url} -> ${res.status}` };
      } catch (err) {
        return { met: expect === "absent", detail: `${url} -> ${(err as Error).message}` };
      }
    }
    case "process_running":
    case "app_running": {
      const needle = args.app ?? args.target;
      const res = await run("/usr/bin/pgrep", [args.condition === "app_running" ? "-f" : "-x", needle], { timeoutMs: 5_000 });
      const running = !!res.out.trim();
      return { met: expect === "present" ? running : !running, detail: `${needle} ${running ? "running" : "not running"}` };
    }
    case "window_title": {
      const { jxa } = await import("./exec.js");
      const res = await jxa(
        `ObjC.import('CoreGraphics');var raw=ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(1|(1<<4),0))||[];JSON.stringify(raw.map(function(w){return String(w.kCGWindowName||'')}))`,
        10_000,
      );
      const titles = ((): string[] => {
        try {
          return JSON.parse(res.out.trim()) as string[];
        } catch {
          return [];
        }
      })();
      const needle = (args.contains ?? args.target).toLowerCase();
      const hit = titles.find((t) => t.toLowerCase().includes(needle));
      return { met: expect === "present" ? !!hit : !hit, detail: hit ? `window "${hit}"` : `no window matching "${needle}"` };
    }
    default:
      return { met: false, detail: `unknown condition ${args.condition}` };
  }
}

export async function waitFor(args: WaitForArgs): Promise<Outcome> {
  if (!args.target && !args.url && !args.port) return failed("target is required");
  const timeoutMs = Math.min(Math.max(1, args.timeoutSeconds ?? 30), 600) * 1000;
  const interval = Math.min(Math.max(100, args.intervalMs ?? 500), 10_000);
  const started = Date.now();

  if (args.condition === "file_changed") {
    const before = await checkCondition(args);
    if (!before.met) return failed(before.detail);
    while (Date.now() - started < timeoutMs) {
      await new Promise((r) => setTimeout(r, interval));
      const now = await checkCondition(args);
      if (now.detail !== before.detail) return good(`Changed after ${((Date.now() - started) / 1000).toFixed(1)}s (${before.detail} -> ${now.detail}).`);
    }
    return failed(`No change within ${timeoutMs / 1000}s (still ${before.detail}).`);
  }

  let last = "";
  while (Date.now() - started < timeoutMs) {
    const res = await checkCondition(args);
    last = res.detail;
    if (res.met) return good(`Met after ${((Date.now() - started) / 1000).toFixed(1)}s: ${res.detail}`);
    await new Promise((r) => setTimeout(r, interval));
  }
  return failed(`Not met within ${timeoutMs / 1000}s: ${last}`);
}

// --- file_ops ------------------------------------------------------------

export interface FileOpsArgs {
  action: "move" | "copy" | "mkdir" | "link" | "du" | "archive" | "extract" | "open_with" | "touch";
  path: string;
  to?: string;
  overwrite?: boolean;
  app?: string;
}

export async function fileOps(args: FileOpsArgs, config: AppConfig = loadConfig()): Promise<Outcome> {
  const src = args.path ? resolveUserPath(args.path, config) : "";
  if (!src) return failed("path is required");
  const dest = args.to ? resolveUserPath(args.to, config) : "";

  if (args.action === "mkdir") {
    await fsp.mkdir(src, { recursive: true });
    return good(`Created ${src}.`);
  }

  if (args.action === "touch") {
    const now = new Date();
    if (fs.existsSync(src)) await fsp.utimes(src, now, now);
    else await fsp.writeFile(src, "");
    return good(`Touched ${src}.`);
  }

  if (args.action === "du") {
    const res = await run("/usr/bin/du", ["-sk", src], { timeoutMs: 60_000 });
    if (!res.ok) return failed(res.err || res.out);
    const kb = Number(res.out.trim().split(/\s+/)[0] ?? 0);
    const count = await fsp.readdir(src).catch(() => [] as string[]);
    return good(`${src}: ${formatBytes(kb * 1024)}${count.length ? `, ${count.length} top-level item(s)` : ""}`);
  }

  if (!dest) return failed(`action=${args.action} needs to`);

  if (args.action === "open_with") {
    const target = args.app ?? dest;
    const res = await run("/usr/bin/open", ["-a", target, src], { timeoutMs: 20_000 });
    return res.ok ? good(`Opened ${src} with ${target}.`) : failed(res.err || res.out);
  }

  if (args.action === "extract") {
    await fsp.mkdir(dest, { recursive: true });
    const isZip = /\.zip$/i.test(src);
    const res = isZip
      ? await run("/usr/bin/ditto", ["-x", "-k", src, dest], { timeoutMs: 300_000 })
      : await run("/usr/bin/tar", ["-xzf", src, "-C", dest], { timeoutMs: 300_000 });
    return res.ok ? good(`Extracted ${src} into ${dest}.`) : failed(res.err || res.out);
  }

  if (args.action === "archive") {
    if (fs.existsSync(dest) && !args.overwrite) return failed(`${dest} exists; pass overwrite=true to replace it.`);
    const isZip = /\.zip$/i.test(dest);
    const res = isZip
      ? await run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", src, dest], { timeoutMs: 300_000 })
      : await run("/usr/bin/tar", ["-czf", dest, "-C", path.dirname(src), path.basename(src)], { timeoutMs: 300_000 });
    if (!res.ok) return failed(res.err || res.out);
    const size = fs.statSync(dest).size;
    return good(`Archived ${src} -> ${dest} (${formatBytes(size)}).`);
  }

  if (args.action === "link") {
    if (fs.existsSync(dest) && !args.overwrite) return failed(`${dest} exists; pass overwrite=true to replace it.`);
    await fsp.symlink(src, dest);
    return good(`Linked ${dest} -> ${src}.`);
  }

  if (fs.existsSync(dest) && !args.overwrite) {
    return failed(`${dest} already exists; pass overwrite=true to replace it.`);
  }
  if (!fs.existsSync(src)) return failed(`${src} does not exist.`);

  if (args.action === "move") {
    try {
      await fsp.rename(src, dest);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EXDEV") return failed((err as Error).message);
      await fsp.cp(src, dest, { recursive: true, force: true });
      await fsp.rm(src, { recursive: true, force: true });
    }
    return good(`Moved ${src} -> ${dest}.`);
  }

  await fsp.cp(src, dest, { recursive: true, force: !!args.overwrite, errorOnExist: !args.overwrite });
  const stat = await fsp.stat(dest);
  return good(`Copied ${src} -> ${dest} (${formatBytes(stat.size)}${stat.isDirectory() ? ", directory" : ""}).`);
}

// --- spotlight / recent_files -------------------------------------------

export interface SpotlightArgs {
  query?: string;
  name?: string;
  content?: string;
  kind?: "pdf" | "image" | "movie" | "audio" | "text" | "source" | "folder" | "app" | "archive";
  within?: string;
  modifiedWithinHours?: number;
  limit?: number;
}

const KIND_CLAUSE: Record<string, string> = {
  pdf: 'kMDItemContentType == "com.adobe.pdf"',
  image: "kMDItemContentTypeTree == \"public.image\"",
  movie: "kMDItemContentTypeTree == \"public.movie\"",
  audio: "kMDItemContentTypeTree == \"public.audio\"",
  text: "kMDItemContentTypeTree == \"public.text\"",
  source: "(kMDItemFSName == \"*.ts\"c || kMDItemFSName == \"*.tsx\"c || kMDItemFSName == \"*.js\"c || kMDItemFSName == \"*.py\"c || kMDItemFSName == \"*.go\"c || kMDItemFSName == \"*.rs\"c || kMDItemFSName == \"*.swift\"c || kMDItemFSName == \"*.md\"c)",
  folder: 'kMDItemContentType == "public.folder"',
  app: 'kMDItemContentType == "com.apple.application-bundle"',
  archive: '(kMDItemFSName == "*.zip"c || kMDItemFSName == "*.tar.gz"c || kMDItemFSName == "*.tgz"c)',
};

function quoteMdfind(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

export async function spotlight(args: SpotlightArgs, config: AppConfig = loadConfig()): Promise<Outcome> {
  const clauses: string[] = [];
  if (args.name) clauses.push(`kMDItemFSName == "*${args.name.replace(/"/g, "")}*"c`);
  if (args.content) clauses.push(`kMDItemTextContent == "*${args.content.replace(/"/g, "")}*"c`);
  if (args.kind) clauses.push(KIND_CLAUSE[args.kind] ?? "");
  if (args.modifiedWithinHours) {
    const days = Math.max(1, Math.ceil(args.modifiedWithinHours / 24));
    clauses.push(`kMDItemFSContentChangeDate >= $time.today(-${days})`);
  }
  const query = clauses.filter(Boolean).join(" && ") || args.query;
  if (!query) return failed("Give a name, content, kind, modifiedWithinHours or a raw query.");

  const scope = args.within ? resolveUserPath(args.within, config) : config.paths.workspace;
  const limit = Math.min(Math.max(1, args.limit ?? 30), 200);
  const res = await run("/usr/bin/mdfind", ["-onlyin", scope, query], { timeoutMs: 25_000 });
  if (!res.ok && !res.out.trim()) return failed(res.err || "mdfind failed");
  const files = res.out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.includes("/node_modules/") && !l.includes("/.git/"));
  const shown = files.slice(0, limit);
  const rows = shown.map((file) => {
    try {
      const st = fs.statSync(file);
      const when = st.mtime.toISOString().slice(0, 16).replace("T", " ");
      return `  ${when}  ${formatBytes(st.size).padStart(9)}  ${file}`;
    } catch {
      return `  ?                 ?  ${file}`;
    }
  });
  return good(`${files.length} hit(s)${files.length > limit ? `, showing ${limit}` : ""} in ${scope}:\n${rows.join("\n")}`);
}

export async function recentFiles(args: { within?: string; hours?: number; limit?: number }, config: AppConfig = loadConfig()): Promise<Outcome> {
  const scope = args.within ? resolveUserPath(args.within, config) : config.paths.workspace;
  const hours = Math.min(Math.max(1, args.hours ?? 24), 24 * 30);
  const days = Math.max(1, Math.ceil(hours / 24));
  const res = await run("/usr/bin/mdfind", ["-onlyin", scope, `kMDItemFSContentChangeDate >= $time.today(-${days})`], {
    timeoutMs: 30_000,
  });
  const files = res.out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.includes("/node_modules/") && !l.includes("/.git/") && !l.startsWith("/.Trash/"));
  const withStat = files
    .map((file) => {
      try {
        return { file, mtime: fs.statSync(file).mtimeMs, size: fs.statSync(file).size };
      } catch {
        return null;
      }
    })
    .filter((v): v is { file: string; mtime: number; size: number } => !!v)
    .filter((v) => Date.now() - v.mtime <= hours * 3600_000)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, Math.min(args.limit ?? 40, 200));
  if (!withStat.length) return good(`Nothing changed in the last ${hours}h under ${scope}.`);
  const rows = withStat.map((v) => `  ${new Date(v.mtime).toISOString().slice(0, 16).replace("T", " ")}  ${formatBytes(v.size).padStart(9)}  ${v.file}`);
  return good(`${withStat.length} file(s) changed in the last ${hours}h under ${scope}:\n${rows.join("\n")}`);
}
