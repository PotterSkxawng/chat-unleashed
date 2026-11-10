// Process helpers shared by every tool that shells out.
//
// All of these are promise-based, time-boxed and output-capped so a hung or
// chatty child can never wedge the server or flood the model's context.
import { spawn } from "node:child_process";
import { BoundedCapture } from "./bounded-capture.js";

export interface RunOptions {
  timeoutMs?: number;
  input?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Bytes kept per stream (the rest is dropped, `truncated` is set). */
  maxBytes?: number;
}

export interface RunResult {
  ok: boolean;
  code: number | null;
  out: string;
  err: string;
  timedOut: boolean;
  truncated: boolean;
}

const DEFAULT_MAX = 400_000;

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { timeoutMs = 20_000, input, cwd, env, maxBytes = DEFAULT_MAX } = opts;
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const out = new BoundedCapture(maxBytes);
    const err = new BoundedCapture(maxBytes);

    const grouped = process.platform !== "win32";
    const child = spawn(cmd, args, {
      cwd,
      env: env ?? process.env,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      // A dedicated process group lets timeout cleanup kill grandchildren too
      // (build systems and shell pipelines otherwise leak workers).
      detached: grouped,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (grouped && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, Math.max(100, timeoutMs));

    const finish = (code: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = out.text;
      const stderr = err.text + (spawnError ? `\n${spawnError}` : "");
      resolve({
        ok: code === 0 && !spawnError,
        code,
        out: stdout,
        err: stderr.trim(),
        timedOut,
        truncated: out.truncated || err.truncated,
      });
    };

    child.stdout?.on("data", (b: Buffer) => out.push(b));
    child.stderr?.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => finish(null, e.message));
    child.on("close", (code) => finish(code));

    if (input !== undefined && child.stdin) {
      child.stdin.on("error", () => {
        /* child exited early; close handler reports the real result */
      });
      child.stdin.end(input);
    }
  });
}

/** zsh login shell, for one-liners that need pipes/globs. */
export function sh(script: string, opts: RunOptions = {}): Promise<RunResult> {
  return run("/bin/zsh", ["-lc", script], opts);
}

/** JXA. Source goes over stdin so nothing has to survive shell quoting. */
export function jxa(source: string, timeoutMs = 20_000): Promise<RunResult> {
  return run("/usr/bin/osascript", ["-l", "JavaScript", "-"], { input: source, timeoutMs });
}

export async function hasBinary(name: string): Promise<string | null> {
  const res = await run("/usr/bin/which", [name], { timeoutMs: 5_000 });
  const found = res.out.trim().split("\n")[0];
  return res.ok && found ? found : null;
}

/** Best-effort "this is the app macOS will name" for permission prompts. */
export function appBundleOf(exePath: string): string | null {
  const idx = exePath.indexOf("/Contents/MacOS/");
  return idx > 0 ? `${exePath.slice(0, idx)}.app` : null;
}

/** What a tool returns: a message, and optionally an image the model can see. */
export interface Outcome {
  ok: boolean;
  message: string;
  image?: { data: string; mimeType: string };
}

export const good = (message: string, image?: Outcome["image"]): Outcome => ({ ok: true, message, ...(image ? { image } : {}) });
export const failed = (message: string): Outcome => ({ ok: false, message });

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m && !d) parts.push(`${m}m`);
  if (!parts.length) parts.push(`${s}s`);
  return parts.join(" ");
}

export function truncate(value: string, limit = 20_000): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n... [truncated ${value.length - limit} chars]`;
}
