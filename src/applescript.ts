// Shared Apple Events plumbing for every app this server drives.
//
// Everything below is deliberately app-agnostic: the three iWork apps (Pages,
// Numbers, Keynote) expose almost the same object model - rich text, tables,
// shapes, images, movies, charts, export - and differ only in how a document is
// addressed (body text vs sheets vs slides). So the engine lives here once and
// each app module supplies only what is genuinely different.
//
// HARD RULE inherited from the Pages module: this server never closes a
// document and never quits an app. There is no `close` and no `quit` in any
// generated script. Documents are left exactly as the user left them.
import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applicationCandidates, findApplicationByBundleId } from "./mac-paths.js";

/** Field/record separators so one AppleScript run can return structured rows. */
export const US = String.fromCharCode(30);
export const RS = String.fromCharCode(31);

export type Result = { ok: boolean; message: string };
export const ok = (message: string): Result => ({ ok: true, message });
export const bad = (message: string): Result => ({ ok: false, message });

export interface AsResult {
  ok: boolean;
  out: string;
  error?: string;
  code?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

// --- execution -------------------------------------------------------------

export function runAppleScript(source: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<AsResult> {
  // Offline validation hooks (no Apple Events, no app interaction):
  //   APPLESCRIPT_DUMP_DIR=/tmp/x  -> write every generated script to disk
  //   APPLESCRIPT_DRY_RUN=1        -> also skip execution entirely
  // The PAGES_* names are kept so the older harness keeps working.
  const dumpDir = process.env.APPLESCRIPT_DUMP_DIR ?? process.env.PAGES_DUMP_DIR;
  if (dumpDir) {
    try {
      fs.mkdirSync(dumpDir, { recursive: true });
      const name = `script-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.applescript`;
      fs.writeFileSync(path.join(dumpDir, name), source, "utf8");
    } catch {
      /* diagnostics only */
    }
  }
  if (process.env.APPLESCRIPT_DRY_RUN === "1" || process.env.PAGES_DRY_RUN === "1") {
    return Promise.resolve({ ok: true, out: "" });
  }

  return new Promise((resolve) => {
    const child = spawn("/usr/bin/osascript", ["-e", source], { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;

    const finish = (result: AsResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish({ ok: false, out: "", error: `AppleScript timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);

    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => finish({ ok: false, out: "", error: e.message }));
    child.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8").replace(/\n$/, "");
      const stderr = Buffer.concat(err).toString("utf8").trim();
      if (code === 0) {
        finish({ ok: true, out: stdout });
        return;
      }
      const match = /\((-?\d{3,5})\)\s*$/.exec(stderr);
      finish({
        ok: false,
        out: stdout,
        error: stderr || `osascript exited with ${code}`,
        code: match ? Number(match[1]) : undefined,
      });
    });
  });
}

/** Parent chain, so a permission message can name the app macOS will ask about. */
function processAncestry(): string[] {
  const names: string[] = [];
  let pid = process.pid;
  for (let i = 0; i < 6 && pid > 1; i++) {
    try {
      const out = execFileSync("/bin/ps", ["-o", "ppid=,comm=", "-p", String(pid)]).toString().trim();
      const match = /^(\d+)\s+(.*)$/.exec(out);
      if (!match) break;
      names.push(path.basename(match[2]));
      pid = Number(match[1]);
    } catch {
      break;
    }
  }
  return names;
}

/** Turn an AppleScript failure into something the calling model can act on. */
export function explainFailure(res: AsResult, appLabel: string): string {
  const code = res.code;
  const detail = res.error ?? "unknown error";
  if (code === -1743 || code === -10004) {
    const chain = processAncestry();
    const chainNote = chain.length ? ` (process chain: ${chain.join(" <- ")})` : "";
    return (
      `ERROR: macOS blocked automation of ${appLabel} (${code}).\n` +
      `The app that hosts this MCP server needs a one-time Automation grant:\n` +
      `  1. System Settings -> Privacy & Security -> Automation\n` +
      `  2. Find the host app in the list${chainNote} and switch "${appLabel}" on.\n` +
      `     If it is not listed, click "+" and add the server binary; mac_permissions action=status prints its path.\n` +
      `  3. Retry the call - no restart needed.\n` +
      `Open the pane: open "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"\n` +
      `raw: ${detail}`
    );
  }
  if (code === -1728) return `ERROR: ${appLabel} could not find that object - is the document still open? (${detail})`;
  if (code === -1708) return `ERROR: ${appLabel} does not support that command in its current state. (${detail})`;
  if (code === -609) return `ERROR: lost the connection to ${appLabel} - it probably quit or crashed. (${detail})`;
  if (code === -128) return `ERROR: cancelled (a ${appLabel} dialog may be waiting for input). (${detail})`;
  if (code === -1719) return `ERROR: ${appLabel} does not understand that AppleScript term - check the op arguments. (${detail})`;
  if (code === -25211) {
    return (
      `ERROR: macOS blocked UI scripting of ${appLabel} (${code}).\n` +
      `Driving menus, windows and keystrokes needs a second permission on top of Automation:\n` +
      `  1. System Settings -> Privacy & Security -> Accessibility\n` +
      `  2. Add the app that hosts this server and switch it on.\n` +
      `Open the pane: open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"\n` +
      `raw: ${detail}`
    );
  }
  return `ERROR: ${detail}`;
}

// --- literals --------------------------------------------------------------

export function asLit(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** AppleScript number list, keeping one decimal so half-point sizes survive. */
export function numList(values: number[]): string {
  return `{${values.map((v) => String(Math.round(v * 10) / 10)).join(", ")}}`;
}

export function strList(values: string[]): string {
  return `{${values.map(asLit).join(", ")}}`;
}

export function colorList(values: Array<[number, number, number]>): string {
  return `{${values.map(([r, g, b]) => `{${r}, ${g}, ${b}}`).join(", ")}}`;
}

/** #RRGGBB -> AppleScript 0..65535 RGB triple. */
export function hexToApple(hex: string): [number, number, number] {
  const clean = hex.replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) throw new Error(`invalid colour ${hex} - expected #RRGGBB`);
  const part = (i: number) => parseInt(clean.slice(i, i + 2), 16) * 257;
  return [part(0), part(2), part(4)];
}

/** 0..65535 RGB triple back to #RRGGBB. */
export function appleToHex(color: [number, number, number]): string {
  const part = (v: number) => Math.round(Math.min(65535, Math.max(0, v)) / 257).toString(16).padStart(2, "0");
  return `#${part(color[0])}${part(color[1])}${part(color[2])}`.toUpperCase();
}

// --- app registry ----------------------------------------------------------

export type AppKey = "pages" | "numbers" | "keynote";

export interface AppDef {
  key: AppKey;
  /** Human label, also used in error messages and `tell application "...">`. */
  label: string;
  bundleId: string;
  /** Where the app may live. The "Creator Studio" renames are checked first. */
  paths: string[];
  ext: string;
  /** Export format name -> Pages/Numbers/Keynote enum value + file extension. */
  exportFormats: Record<string, { as: string; ext: string }>;
}

export const IWORK_APPS: Record<AppKey, AppDef> = {
  pages: {
    key: "pages",
    label: "Pages",
    bundleId: "com.apple.Pages",
    paths: applicationCandidates("Pages Creator Studio.app", "Pages.app"),
    ext: ".pages",
    exportFormats: {
      pdf: { as: "PDF", ext: "pdf" },
      txt: { as: "unformatted text", ext: "txt" },
      rtf: { as: "formatted text", ext: "rtf" },
      epub: { as: "EPUB", ext: "epub" },
      docx: { as: "Microsoft Word", ext: "docx" },
    },
  },
  numbers: {
    key: "numbers",
    label: "Numbers",
    bundleId: "com.apple.Numbers",
    paths: applicationCandidates("Numbers Creator Studio.app", "Numbers.app"),
    ext: ".numbers",
    exportFormats: {
      pdf: { as: "PDF", ext: "pdf" },
      xlsx: { as: "Microsoft Excel", ext: "xlsx" },
      csv: { as: "CSV", ext: "csv" },
    },
  },
  keynote: {
    key: "keynote",
    label: "Keynote",
    bundleId: "com.apple.Keynote",
    paths: applicationCandidates("Keynote Creator Studio.app", "Keynote.app"),
    ext: ".key",
    exportFormats: {
      pdf: { as: "PDF", ext: "pdf" },
      pptx: { as: "Microsoft PowerPoint", ext: "pptx" },
      html: { as: "HTML", ext: "html" },
      movie: { as: "QuickTime movie", ext: "m4v" },
      images: { as: "slide images", ext: "png" },
    },
  },
};

export const APP_KEYS: AppKey[] = ["pages", "numbers", "keynote"];

const pathCache = new Map<AppKey, string | null>();

export function findAppPath(app: AppDef): string | null {
  if (pathCache.has(app.key)) return pathCache.get(app.key)!;
  const found = findApplicationByBundleId(app.bundleId, app.paths);
  pathCache.set(app.key, found);
  return found;
}

export function appVersion(appPath: string): string {
  try {
    const out = execFileSync("/usr/bin/plutil", [
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      "-o",
      "-",
      path.join(appPath, "Contents", "Info.plist"),
    ]);
    return out.toString("utf8").trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export function isAppRunning(app: AppDef): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("/usr/bin/pgrep", ["-x", app.label], (err, stdout) => {
      resolve(!err && stdout.trim().length > 0);
    });
  });
}

/** Resolve an app from a document path's extension. */
export function appForPath(filePath: string): AppDef | null {
  const ext = path.extname(filePath).toLowerCase();
  if (!ext) return null;
  for (const key of APP_KEYS) {
    if (IWORK_APPS[key].ext === ext) return IWORK_APPS[key];
  }
  return null;
}

/** Resolve an app from a name like "pages", "Numbers" or "com.apple.Keynote". */
export function appForName(name: string): AppDef | null {
  const needle = name.trim().toLowerCase();
  for (const key of APP_KEYS) {
    const app = IWORK_APPS[key];
    if (key === needle || app.label.toLowerCase() === needle || app.bundleId.toLowerCase() === needle) return app;
  }
  return null;
}

export function requireApp(app: AppDef): Result | null {
  if (!findAppPath(app)) {
    return bad(
      `ERROR: ${app.label} is not installed or is not registered with macOS Launch Services. Install it, launch it once, then retry.`,
    );
  }
  return null;
}

/** Expand a leading ~ and make the path absolute. */
export function resolveUserPath(p: string): string {
  return path.resolve(p.replace(/^~(?=\/|$)/, os.homedir()));
}

/** Resolve and validate a target document path. */
export function resolveTarget(p: string | undefined, what = "document"): string | Result {
  if (!p) return bad(`ERROR: path is required - pass the ${what} to modify.`);
  const resolved = resolveUserPath(p);
  if (!fs.existsSync(resolved)) return bad(`ERROR: no such file: ${resolved}`);
  return resolved;
}

/** Narrowing helper: true when resolveTarget() returned an error. */
export function failed(value: string | Result): value is Result {
  return typeof value !== "string";
}

/**
 * AppleScript that binds `doc` to the document at `targetPath`, reusing an
 * already-open window when possible so we never spawn duplicates.
 */
export function bindDocument(app: AppDef, targetPath: string | null, varName = "doc"): string {
  if (!targetPath) return `set ${varName} to document 1`;
  const lit = asLit(targetPath);
  return [
    `set targetPath to ${lit}`,
    `set ${varName} to missing value`,
    `repeat with d in documents`,
    `  try`,
    `    if (POSIX path of (file of d)) is targetPath then`,
    `      set ${varName} to contents of d`,
    `      exit repeat`,
    `    end if`,
    `  end try`,
    `end repeat`,
    `if ${varName} is missing value then`,
    `  set prevApp to ""`,
    `  try`,
    `    tell application "System Events" to set prevApp to name of first application process whose frontmost is true`,
    `  end try`,
    `  set ${varName} to open POSIX file targetPath`,
    `  if prevApp is not "" then`,
    `    try`,
    `      tell application "System Events" to set frontmost of (first application process whose name is prevApp) to true`,
    `    end try`,
    `  end if`,
    `end if`,
  ].join("\n");
}

/** Standard timeout + document binding wrapper. */
export function appScript(
  app: AppDef,
  target: string | null,
  body: string[],
  opts: { handlers?: string; timeout?: number } = {},
): string {
  const script = [
    `with timeout of ${opts.timeout ?? 220} seconds`,
    `  tell application id "${app.bundleId}"`,
    `  ${bindDocument(app, target)}`,
    ...body.filter((line) => line !== ""),
    `  end tell`,
    `end timeout`,
  ].join("\n");
  return opts.handlers ? `${script}\n${opts.handlers}` : script;
}

/** Handlers that must sit outside the tell block; call them with `my`. */
export const LOCAL_HANDLERS = [
  "",
  "on joinList(theList)",
  "  set oldDelims to AppleScript's text item delimiters",
  "  set AppleScript's text item delimiters to linefeed",
  "  set out to theList as text",
  "  set AppleScript's text item delimiters to oldDelims",
  "  return out",
  "end joinList",
  "",
  "on offsetOf(haystack, needle, startAt)",
  "  set hay to haystack as text",
  "  if startAt > (count of characters of hay) then return 0",
  "  set sub to text startAt thru -1 of hay",
  "  set off to offset of needle in sub",
  "  if off is 0 then return 0",
  "  return startAt + off - 1",
  "end offsetOf",
].join("\n");

/** Split a US/RS encoded record stream into field arrays. */
export function parseRecords(raw: string): string[][] {
  const rows: string[][] = [];
  for (const record of raw.split(RS)) {
    if (!record) continue;
    rows.push(record.split(US));
  }
  return rows;
}
