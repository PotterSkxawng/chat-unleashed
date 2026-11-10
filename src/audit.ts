import fs from "node:fs";
import path from "node:path";
import { appHome } from "./config.js";

export const LOG_DIR = path.join(appHome(), "logs");
const LOG_FILE = path.join(LOG_DIR, "audit.log");

function envInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
}

// Keep a bounded but substantial local audit history. Operators can raise both
// values when longer retention matters more than disk usage.
const MAX_LOG_BYTES = envInt("LOCAL_AGENT_AUDIT_MAX_BYTES", 64 * 1024 * 1024, 1024 * 1024, 1024 * 1024 * 1024);
const KEEP_LOGS = envInt("LOCAL_AGENT_AUDIT_KEEP", 16, 1, 128);
let approxBytes = -1;

export interface AuditEntry {
  event: string;
  tool?: string;
  args?: unknown;
  ok?: boolean;
  summary?: string;
  durationMs?: number;
}

function clipArgs(args: unknown): string | undefined {
  if (args === undefined) return undefined;
  let s: string;
  try {
    s = typeof args === "string" ? args : JSON.stringify(args);
  } catch {
    s = String(args);
  }
  return s.length > 4000 ? `${s.slice(0, 4000)}...[+${s.length - 4000} chars]` : s;
}

function currentSize(): number {
  if (approxBytes >= 0) return approxBytes;
  try {
    approxBytes = fs.statSync(LOG_FILE).size;
  } catch {
    approxBytes = 0;
  }
  return approxBytes;
}

function rotateIfNeeded(incoming: number): void {
  if (currentSize() + incoming <= MAX_LOG_BYTES) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    for (let i = KEEP_LOGS - 1; i >= 1; i--) {
      const src = `${LOG_FILE}.${i}`;
      const dst = `${LOG_FILE}.${i + 1}`;
      if (!fs.existsSync(src)) continue;
      try {
        fs.renameSync(src, dst);
      } catch {
        /* best effort across concurrent server/test processes */
      }
    }
    if (fs.existsSync(LOG_FILE)) {
      try {
        fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
      } catch {
        // If another process rotated first, re-stat before appending.
      }
    }
  } finally {
    try {
      approxBytes = fs.statSync(LOG_FILE).size;
    } catch {
      approxBytes = 0;
    }
  }
}

/** Append one JSON line to the per-user audit log. Never throws. */
export function audit(entry: AuditEntry): void {
  const { args, ...rest } = entry;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...rest,
    ...(args !== undefined ? { args: clipArgs(args) } : {}),
  });
  const payload = `${line}\n`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const bytes = Buffer.byteLength(payload);
    rotateIfNeeded(bytes);
    fs.appendFileSync(LOG_FILE, payload, { mode: 0o600 });
    approxBytes += bytes;
  } catch (err) {
    approxBytes = -1;
    process.stderr.write(`[audit] write failed: ${(err as Error).message}\n`);
  }
}

/** Synchronous audit backend is already flushed on every call. */
export function flushAuditSync(): void {
  // Intentionally empty; kept as a stable shutdown hook if audit becomes buffered.
}
