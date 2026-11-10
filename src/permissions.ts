// macOS permission handling, owned by this server.
//
// The server asks the OS for what it needs (Accessibility, Screen Recording,
// Automation, Full Disk Access), reports exactly which binary the OS has to
// trust, and opens the right pane. Nothing here depends on how the server was
// launched - a terminal, an MCP client, a menu-bar app or a launcher all get
// the same answers.
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { jxa, run } from "./exec.js";

export type PermKind = "accessibility" | "screenRecording" | "automation" | "fullDiskAccess";
export type PermState = "granted" | "denied" | "unknown";

export interface PermStatus {
  kind: PermKind;
  label: string;
  state: PermState;
  detail: string;
}

export const PANES: Record<PermKind, string> = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
  fullDiskAccess: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
};

const LABELS: Record<PermKind, string> = {
  accessibility: "Accessibility (control apps and read their UI)",
  screenRecording: "Screen Recording (screenshots and window capture)",
  automation: "Automation (drive other apps with AppleScript)",
  fullDiskAccess: "Full Disk Access (read protected files such as Mail and Messages)",
};

/** Human-readable identity of the process the OS will attribute the grant to. */
export interface ProcessIdentity {
  executable: string;
  appBundle: string | null;
  ancestors: string[];
  pid: number;
}

function bundleFromExecutable(exe: string): string | null {
  const marker = "/Contents/MacOS/";
  const idx = exe.indexOf(marker);
  return idx > 0 ? `${exe.slice(0, idx)}.app` : null;
}

export function processIdentity(): ProcessIdentity {
  const ancestors: string[] = [];
  let pid = process.pid;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    try {
      const out = execFileSync("/bin/ps", ["-o", "ppid=,comm=", "-p", String(pid)]).toString().trim();
      const match = /^(\d+)\s+(.*)$/.exec(out);
      if (!match) break;
      ancestors.push(path.basename(match[2].trim()));
      pid = Number(match[1]);
    } catch {
      break;
    }
  }
  const executable = process.execPath;
  const fromAncestors = ancestors.map((a) => a).find((a) => a.endsWith(".app")) ?? null;
  return {
    executable,
    appBundle: bundleFromExecutable(executable) ?? fromAncestors,
    ancestors,
    pid: process.pid,
  };
}

/** The name a person will look for in System Settings. */
export function identityLabel(identity: ProcessIdentity = processIdentity()): string {
  if (identity.appBundle) return path.basename(identity.appBundle, ".app");
  return path.basename(identity.executable);
}

const AX_PROBE = `
ObjC.import('ApplicationServices');
function readTrusted() {
  try { return $.AXIsProcessTrusted() ? 'granted' : 'denied'; } catch (e) { return 'unknown'; }
}
readTrusted();
`;

const AX_REQUEST = `
ObjC.import('ApplicationServices');
ObjC.import('Foundation');
try {
  var key = $.NSString.alloc.initWithUTF8String('AXTrustedCheckOptionPrompt');
  var opts = $.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithBool(true), key);
  $.AXIsProcessTrustedWithOptions(opts) ? 'granted' : 'prompted';
} catch (e) {
  'error: ' + e.message;
}
`;

const SCREEN_PROBE = `
ObjC.import('CoreGraphics');
try {
  if (typeof $.CGPreflightScreenCaptureAccess === 'function') {
    $.CGPreflightScreenCaptureAccess() ? 'granted' : 'denied';
  } else { 'unknown'; }
} catch (e) { 'unknown'; }
`;

const SCREEN_REQUEST = `
ObjC.import('CoreGraphics');
try {
  if (typeof $.CGRequestScreenCaptureAccess === 'function') {
    $.CGRequestScreenCaptureAccess() ? 'granted' : 'prompted';
  } else { 'manual'; }
} catch (e) { 'manual'; }
`;

async function probe(script: string, timeoutMs = 10_000): Promise<string> {
  const res = await jxa(script, timeoutMs);
  const value = (res.out || res.err).trim().split("\n").pop() ?? "";
  if (!res.ok && !value) return "unknown";
  return value || "unknown";
}

export async function accessibilityStatus(): Promise<PermStatus> {
  const state = await probe(AX_PROBE);
  return {
    kind: "accessibility",
    label: LABELS.accessibility,
    state: state === "granted" ? "granted" : state === "denied" ? "denied" : "unknown",
    detail:
      state === "granted"
        ? "The server may read and drive other apps' interfaces."
        : "Grant it to enable ui_tree, ui_find, ui_act, mouse, keyboard and window_control.",
  };
}

export async function screenRecordingStatus(): Promise<PermStatus> {
  const state = await probe(SCREEN_PROBE);
  return {
    kind: "screenRecording",
    label: LABELS.screenRecording,
    state: state === "granted" ? "granted" : state === "denied" ? "denied" : "unknown",
    detail:
      state === "granted"
        ? "Screenshots and window captures will contain real pixels."
        : "Without it screencapture returns a desktop-only or empty image.",
  };
}

/** Apple Events are per-target-app, so probe the app the caller cares about. */
export async function automationStatus(app = "Finder"): Promise<PermStatus> {
  const res = await run(
    "/usr/bin/osascript",
    ["-e", `with timeout of 10 seconds\n  tell application "${app.replace(/"/g, '\\"')}" to get name\nend timeout`],
    { timeoutMs: 15_000 },
  );
  if (res.ok) {
    return {
      kind: "automation",
      label: LABELS.automation,
      state: "granted",
      detail: `Apple Events to ${app} are allowed.`,
    };
  }
  const denied = /-1743|-10004|not authorized|Not authorized/.test(`${res.err} ${res.out}`);
  return {
    kind: "automation",
    label: LABELS.automation,
    state: denied ? "denied" : "unknown",
    detail: denied
      ? `Apple Events to ${app} are blocked. Approve the prompt, or add the server in Privacy & Security > Automation.`
      : (res.err || res.out || "unknown failure").slice(0, 300),
  };
}

export async function fullDiskAccessStatus(): Promise<PermStatus> {
  const probes = [
    path.join(os.homedir(), "Library", "Application Support", "com.apple.TCC", "TCC.db"),
    path.join(os.homedir(), "Library", "Mail"),
  ];
  for (const target of probes) {
    try {
      execFileSync("/bin/ls", ["-a", target], { stdio: "pipe" });
      return {
        kind: "fullDiskAccess",
        label: LABELS.fullDiskAccess,
        state: "granted",
        detail: "Protected locations are readable.",
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
    }
  }
  return {
    kind: "fullDiskAccess",
    label: LABELS.fullDiskAccess,
    state: "denied",
    detail: "Needed only for protected stores (Mail, Messages, Safari history, Time Machine).",
  };
}

export async function allStatus(): Promise<PermStatus[]> {
  const [accessibility, screenRecording, automation, fullDiskAccess] = await Promise.all([
    accessibilityStatus(),
    screenRecordingStatus(),
    automationStatus(),
    fullDiskAccessStatus(),
  ]);
  return [accessibility, screenRecording, automation, fullDiskAccess];
}

export interface RequestOutcome {
  kind: PermKind;
  result: string;
  note: string;
}

/** Ask macOS for a grant: this triggers the system prompt that adds us to the list. */
export async function requestPermissions(kinds: PermKind[]): Promise<RequestOutcome[]> {
  const outcomes: RequestOutcome[] = [];
  for (const kind of kinds) {
    if (kind === "accessibility") {
      const result = await probe(AX_REQUEST, 15_000);
      outcomes.push({
        kind,
        result,
        note:
          result === "granted"
            ? "Already granted."
            : "A macOS dialog should appear. Approve it, then switch the toggle on in Privacy & Security > Accessibility. " +
              "If the entry shows our helper rather than the app, enable that entry too.",
      });
    } else if (kind === "screenRecording") {
      const result = await probe(SCREEN_REQUEST, 15_000);
      outcomes.push({
        kind,
        result,
        note:
          result === "granted"
            ? "Already granted."
            : result === "prompted"
              ? "macOS asked for Screen Recording. Approve it, then enable the toggle (a restart of the server may be required once)."
              : "This macOS build offers no screenplay prompt for a background process: open System Settings > Privacy & Security > " +
                "Screen Recording, press +, and add the server binary (the path is in the status output).",
      });
    } else if (kind === "automation") {
      outcomes.push({
        kind,
        result: "prompt-on-use",
        note:
          "Automation is requested the first time a tool targets an app; macOS shows a per-app dialog. " +
          "Nothing to pre-approve here.",
      });
    } else {
      outcomes.push({
        kind,
        result: "manual",
        note: "Full Disk Access cannot be requested programmatically - add the app in System Settings.",
      });
    }
  }
  return outcomes;
}

export async function openPane(kind: PermKind | "all"): Promise<string[]> {
  const kinds: PermKind[] =
    kind === "all" ? ["accessibility", "screenRecording", "automation", "fullDiskAccess"] : [kind];
  const opened: string[] = [];
  for (const k of kinds) {
    const res = await run("/usr/bin/open", [PANES[k]], { timeoutMs: 10_000 });
    if (res.ok) opened.push(k);
  }
  return opened;
}

/** One-paragraph diagnosis the model can act on without guessing. */
export async function diagnose(): Promise<string> {
  const identity = processIdentity();
  const statuses = await allStatus();
  const lines: string[] = [];
  lines.push(`Server process: ${identity.executable} (pid ${identity.pid})`);
  lines.push(`Name macOS will show: ${identityLabel(identity)}`);
  if (identity.ancestors.length) lines.push(`Launch chain: ${identity.ancestors.join(" <- ")}`);
  lines.push("");
  for (const s of statuses) {
    lines.push(`- ${s.label}: ${s.state.toUpperCase()} - ${s.detail}`);
  }
  const missing = statuses.filter((s) => s.state !== "granted").map((s) => s.kind);
  if (missing.length) {
    lines.push("");
    lines.push("To fix: call this tool with action=request (it triggers the OS prompts), then enable the entries");
    lines.push("in System Settings. If the app is not listed, add it with the + button:");
    lines.push(`  ${identity.appBundle ?? identity.executable}`);
    lines.push(`Panes: ${missing.map((m) => PANES[m]).join("  ")}`);
  }
  return lines.join("\n");
}
