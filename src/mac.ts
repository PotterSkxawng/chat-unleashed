// General macOS automation used by Chat Unleashed.
//
// Three deliberate omissions, all for the same reason - this server should not
// surprise the person sitting in front of the Mac:
//   - no `quit` and no `close` anywhere (same rule the iWork layer follows)
//   - no file deletion: `mac_finder trash` moves to the Trash, which is
//     recoverable, and nothing here ever unlinks a path
//   - no silent app launching: `launch`/`activate` are explicit actions
//
// UI scripting (mac_ui) needs Accessibility permission in addition to
// Automation. macOS reports that as -25211 and the error message says so.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { asLit, bad, explainFailure, ok, runAppleScript, type Result } from "./applescript.js";

function shell(cmd: string, args: string[], timeoutMs = 20_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || stderr || "").toString().trim() });
    });
  });
}

/** Run a System Events script and wrap the failure with the right advice. */
async function sysEvents(body: string[], timeoutMs = 30_000): Promise<Result> {
  const script = [
    `with timeout of ${Math.round(timeoutMs / 1000)} seconds`,
    `  tell application "System Events"`,
    ...body.filter(Boolean),
    `  end tell`,
    `end timeout`,
  ].join("\n");

  const res = await runAppleScript(script, timeoutMs + 5_000);
  if (!res.ok) return bad(explainFailure(res, "System Events"));
  return ok(res.out);
}

// --- mac_apps --------------------------------------------------------------

export type AppAction = "list" | "activate" | "launch" | "hide" | "frontmost";

export interface MacAppsOptions {
  action: AppAction;
  app?: string;
}

export async function macApps(opts: MacAppsOptions): Promise<Result> {
  if (opts.action === "frontmost") {
    const res = await sysEvents([`  return name of first application process whose frontmost is true`]);
    if (!res.ok) return res;
    return ok(`Frontmost app: ${res.message}`);
  }

  if (opts.action === "list") {
    const res = await sysEvents([
      `  set out to ""`,
      `  repeat with p in (application processes whose background only is false)`,
      `    set out to out & (name of p) & (ASCII character 31)`,
      `  end repeat`,
      `  return out`,
    ]);
    if (!res.ok) return res;
    const names = res.message.split(String.fromCharCode(31)).filter(Boolean).sort((a, b) => a.localeCompare(b));
    return ok(`${names.length} app(s) with a UI right now:\n${names.map((n) => `  - ${n}`).join("\n")}`);
  }

  if (!opts.app) return bad(`ERROR: action=${opts.action} needs \`app\`.`);

  if (opts.action === "activate") {
    // Telling a stopped app to activate launches it, which is what the caller
    // asked for by naming it explicitly.
    const res = await runAppleScript(
      `with timeout of 30 seconds\n  tell application ${asLit(opts.app)}\n    activate\n  end tell\nend timeout`,
      35_000,
    );
    if (!res.ok) return bad(explainFailure(res, opts.app));
    return ok(`Activated ${opts.app}.`);
  }

  if (opts.action === "launch") {
    const res = await runAppleScript(
      `with timeout of 30 seconds\n  tell application ${asLit(opts.app)}\n    launch\n  end tell\nend timeout`,
      35_000,
    );
    if (!res.ok) return bad(explainFailure(res, opts.app));
    return ok(`Launched ${opts.app} (left running in the background).`);
  }

  // hide
  const res = await sysEvents([
    `  if not (exists process ${asLit(opts.app)}) then error "no running process named ${opts.app}"`,
    `  set visible of process ${asLit(opts.app)} to false`,
    `  return "ok"`,
  ]);
  if (!res.ok) return res;
  return ok(`Hid ${opts.app}.`);
}

// --- mac_ui ----------------------------------------------------------------

export type UiAction = "windows" | "menu" | "keystroke" | "focus";

export interface UiOptions {
  action: UiAction;
  app?: string;
  menu?: string;
  item?: string;
  submenu?: string;
  subitem?: string;
  key?: string;
  modifiers?: Array<"command" | "shift" | "option" | "control">;
}

export async function macUi(opts: UiOptions): Promise<Result> {
  if (opts.action === "windows") {
    if (!opts.app) return bad("ERROR: action=windows needs `app`.");
    const res = await sysEvents([
      `  if not (exists process ${asLit(opts.app)}) then error "no running process named ${opts.app}"`,
      `  set out to ""`,
      `  set i to 0`,
      `  tell process ${asLit(opts.app)}`,
      `    repeat with w in windows`,
      `      set i to i + 1`,
      `      set nm to ""`,
      `      set px to 0`,
      `      set py to 0`,
      `      set ww to 0`,
      `      set hh to 0`,
      `      try`,
      `        set nm to name of w`,
      `        set {px, py} to position of w`,
      `        set {ww, hh} to size of w`,
      `      end try`,
      `      set out to out & (i as text) & (ASCII character 30) & nm & (ASCII character 30) & (px as text) & (ASCII character 30) & (py as text) & (ASCII character 30) & (ww as text) & (ASCII character 30) & (hh as text) & (ASCII character 31)`,
      `    end repeat`,
      `  end tell`,
      `  return out`,
    ]);
    if (!res.ok) return res;

    const rows = res.message.split(String.fromCharCode(31)).filter(Boolean);
    if (!rows.length) return ok(`${opts.app} has no open windows.`);
    const lines = rows.map((r) => {
      const f = r.split(String.fromCharCode(30));
      return `  ${String(f[0]).padStart(2)}  ${(f[1] || "(untitled)").slice(0, 50).padEnd(52)} ${f[4]}x${f[5]} at (${f[2]}, ${f[3]})`;
    });
    return ok(`Windows of ${opts.app}:\n${lines.join("\n")}`);
  }

  if (opts.action === "menu") {
    if (!opts.app || !opts.menu || !opts.item) {
      return bad("ERROR: action=menu needs `app`, `menu` (e.g. File) and `item` (e.g. Save).");
    }
    const pathExpr = opts.submenu && opts.subitem
      ? `menu item ${asLit(opts.subitem)} of menu 1 of menu item ${asLit(opts.submenu)} of menu 1 of menu bar item ${asLit(opts.menu)} of menu bar 1`
      : opts.submenu
        ? `menu item ${asLit(opts.submenu)} of menu 1 of menu bar item ${asLit(opts.menu)} of menu bar 1`
        : `menu item ${asLit(opts.item)} of menu 1 of menu bar item ${asLit(opts.menu)} of menu bar 1`;

    const res = await sysEvents([
      `  if not (exists process ${asLit(opts.app)}) then error "no running process named ${opts.app}"`,
      `  tell process ${asLit(opts.app)}`,
      `    click ${pathExpr}`,
      `  end tell`,
      `  return "ok"`,
    ]);
    if (!res.ok) return res;
    return ok(`Clicked ${opts.menu} > ${opts.submenu ?? opts.item}${opts.subitem ? ` > ${opts.subitem}` : ""} in ${opts.app}.`);
  }

  if (opts.action === "focus") {
    if (!opts.app) return bad("ERROR: action=focus needs `app`.");
    const res = await sysEvents([
      `  if not (exists process ${asLit(opts.app)}) then error "no running process named ${opts.app}"`,
      `  set frontmost of process ${asLit(opts.app)} to true`,
      `  return "ok"`,
    ]);
    if (!res.ok) return res;
    return ok(`Brought ${opts.app} to the front.`);
  }

  // keystroke
  if (!opts.key) return bad("ERROR: action=keystroke needs `key`.");
  const using = (opts.modifiers ?? []).map((m) => `${m} down`).join(", ");
  const stmt = using ? `keystroke ${asLit(opts.key)} using {${using}}` : `keystroke ${asLit(opts.key)}`;
  const res = await sysEvents([`  ${stmt}`, `  return "ok"`]);
  if (!res.ok) return res;
  return ok(`Sent ${opts.modifiers?.length ? `${opts.modifiers.join("+")}+` : ""}${opts.key}.`);
}

// --- mac_system ------------------------------------------------------------

export type SystemAction =
  | "clipboardGet"
  | "clipboardSet"
  | "notify"
  | "volumeGet"
  | "volumeSet"
  | "mute"
  | "battery"
  | "disk"
  | "uptime";

export interface SystemOptions {
  action: SystemAction;
  text?: string;
  title?: string;
  subtitle?: string;
  sound?: boolean;
  level?: number;
  muted?: boolean;
}

export async function macSystem(opts: SystemOptions): Promise<Result> {
  switch (opts.action) {
    case "clipboardGet": {
      const res = await runAppleScript(`return the clipboard as text`, 15_000);
      if (!res.ok) {
        return bad(
          "ERROR: the clipboard does not contain text (or is empty). Images and rich data are not readable this way.",
        );
      }
      return ok(res.out.trim() ? `Clipboard:\n${res.out}` : "Clipboard is empty.");
    }
    case "clipboardSet": {
      if (opts.text === undefined) return bad("ERROR: action=clipboardSet needs `text`.");
      const res = await runAppleScript(`set the clipboard to ${asLit(opts.text)}\nreturn "ok"`, 15_000);
      if (!res.ok) return bad(explainFailure(res, "the clipboard"));
      return ok(`Copied ${opts.text.length} character(s) to the clipboard.`);
    }
    case "notify": {
      if (!opts.text) return bad("ERROR: action=notify needs `text`.");
      const lines = [`display notification ${asLit(opts.text)}`];
      if (opts.title) lines.push(`with title ${asLit(opts.title)}`);
      if (opts.subtitle) lines.push(`subtitle ${asLit(opts.subtitle)}`);
      if (opts.sound !== false) lines.push(`sound name "Ping"`);
      const res = await runAppleScript(`${lines.join(" ")}\nreturn "ok"`, 15_000);
      if (!res.ok) return bad(explainFailure(res, "Notification Center"));
      return ok(`Posted a notification${opts.title ? ` titled ${JSON.stringify(opts.title)}` : ""}.`);
    }
    case "volumeGet": {
      const res = await runAppleScript(`return output volume of (get volume settings)`, 15_000);
      if (!res.ok) return bad(explainFailure(res, "system audio"));
      const muted = await runAppleScript(`return output muted of (get volume settings)`, 15_000);
      return ok(`Output volume: ${res.out.trim()}%${muted.ok && muted.out.trim() === "true" ? " (muted)" : ""}`);
    }
    case "volumeSet": {
      if (opts.level === undefined) return bad("ERROR: action=volumeSet needs `level` 0-100.");
      const level = Math.min(100, Math.max(0, Math.round(opts.level)));
      const res = await runAppleScript(`set volume output volume ${level}\nreturn "ok"`, 15_000);
      if (!res.ok) return bad(explainFailure(res, "system audio"));
      return ok(`Set output volume to ${level}%.`);
    }
    case "mute": {
      const muted = opts.muted !== false;
      const res = await runAppleScript(`set volume output muted ${muted}\nreturn "ok"`, 15_000);
      if (!res.ok) return bad(explainFailure(res, "system audio"));
      return ok(muted ? "Muted the output." : "Unmuted the output.");
    }
    case "battery": {
      const res = await shell("/usr/bin/pmset", ["-g", "batt"]);
      if (!res.ok) return bad(`ERROR: could not read battery state: ${res.out}`);
      return ok(`Battery:\n${res.out}`);
    }
    case "disk": {
      const res = await shell("/bin/df", ["-h", "/"]);
      if (!res.ok) return bad(`ERROR: could not read disk usage: ${res.out}`);
      return ok(`Disk usage:\n${res.out}`);
    }
    case "uptime": {
      const res = await shell("/usr/bin/uptime", []);
      if (!res.ok) return bad(`ERROR: could not read uptime: ${res.out}`);
      return ok(res.out);
    }
    default:
      return bad(`ERROR: unknown action ${opts.action}.`);
  }
}

// --- mac_finder ------------------------------------------------------------

export type FinderAction = "reveal" | "open" | "trash" | "info";

export interface FinderOptions {
  action: FinderAction;
  path: string;
}

export async function macFinder(opts: FinderOptions): Promise<Result> {
  if (!opts.path) return bad("ERROR: path is required.");
  const target = path.resolve(opts.path.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));

  if (opts.action === "info") {
    if (!fs.existsSync(target)) return bad(`ERROR: no such path: ${target}`);
    const stat = fs.statSync(target);
    const kind = stat.isDirectory() ? "folder" : "file";
    return ok(
      `${target}\n  ${kind}, ${stat.size} bytes\n  modified: ${stat.mtime.toISOString()}\n  created: ${stat.birthtime.toISOString()}`,
    );
  }

  if (!fs.existsSync(target)) return bad(`ERROR: no such path: ${target}`);

  if (opts.action === "reveal") {
    const res = await runAppleScript(
      [
        `with timeout of 30 seconds`,
        `  tell application "Finder"`,
        `    activate`,
        `    reveal (POSIX file ${asLit(target)} as alias)`,
        `  end tell`,
        `end timeout`,
      ].join("\n"),
      35_000,
    );
    if (!res.ok) return bad(explainFailure(res, "Finder"));
    return ok(`Revealed ${target} in Finder.`);
  }

  if (opts.action === "open") {
    const res = await runAppleScript(
      [
        `with timeout of 30 seconds`,
        `  tell application "Finder"`,
        `    open (POSIX file ${asLit(target)} as alias)`,
        `  end tell`,
        `end timeout`,
      ].join("\n"),
      35_000,
    );
    if (!res.ok) return bad(explainFailure(res, "Finder"));
    return ok(`Opened ${target}.`);
  }

  // trash - moves to the Trash, never unlinks
  const res = await runAppleScript(
    [
      `with timeout of 60 seconds`,
      `  tell application "Finder"`,
      `    delete (POSIX file ${asLit(target)} as alias)`,
      `  end tell`,
      `end timeout`,
    ].join("\n"),
    70_000,
  );
  if (!res.ok) return bad(explainFailure(res, "Finder"));
  return ok(`Moved ${target} to the Trash (recoverable until the Trash is emptied).`);
}

// --- mac_shortcuts ---------------------------------------------------------

export interface ShortcutsOptions {
  action: "list" | "run";
  name?: string;
  input?: string;
}

export async function macShortcuts(opts: ShortcutsOptions): Promise<Result> {
  if (opts.action === "list") {
    const res = await shell("/usr/bin/shortcuts", ["list"], 30_000);
    if (!res.ok) return bad(`ERROR: could not list shortcuts: ${res.out}`);
    const names = res.out.split("\n").filter(Boolean);
    if (!names.length) return ok("No Shortcuts are installed.");
    return ok(`${names.length} shortcut(s):\n${names.map((n) => `  - ${n}`).join("\n")}`);
  }

  if (!opts.name) return bad("ERROR: action=run needs `name`.");

  const args = ["run", opts.name];
  if (opts.input) {
    if (!fs.existsSync(opts.input)) return bad(`ERROR: no such input file: ${opts.input}`);
    args.push("-i", path.resolve(opts.input));
  }

  const res = await shell("/usr/bin/shortcuts", args, 300_000);
  if (!res.ok) return bad(`ERROR: shortcut ${JSON.stringify(opts.name)} failed:\n${res.out}`);
  return ok(`Ran shortcut ${JSON.stringify(opts.name)}${res.out ? `:\n${res.out}` : "."}`);
}
