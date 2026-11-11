import fs from "node:fs";
import path from "node:path";
import { appHome } from "./config.js";

export const LOG_DIR = path.join(appHome(), "logs");
const LOG_FILE = path.join(LOG_DIR, "audit.log");

function envInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
}

// Audit history is useful for debugging, but tool arguments can contain private data.
// Keep the default footprint small and let operators opt into longer retention.
const MAX_LOG_BYTES = envInt("LOCAL_AGENT_AUDIT_MAX_BYTES", 8 * 1024 * 1024, 1024 * 1024, 1024 * 1024 * 1024);
const KEEP_LOGS = envInt("LOCAL_AGENT_AUDIT_KEEP", 4, 1, 128);
let approxBytes = -1;

export interface AuditEntry {
  event: string;
  tool?: string;
  args?: unknown;
  ok?: boolean;
  summary?: string;
  durationMs?: number;
}

const SECRET_KEY_RE = /(?:^|[_-])(api[_-]?key|private[_-]?key|access[_-]?key|token|secret|password|passwd|credential|authorization|cookie)(?:$|[_-])/i;
const CONTENT_KEY_RE = /^(?:text|body|content|value|script)$/i;
const TOKEN_RE = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}={0,2}\b/gi;
const ASSIGNMENT_RE = /\b([A-Za-z_][A-Za-z0-9_-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_-]*)\s*=\s*([^\s'";]+)/gi;
const QUERY_SECRET_RE = /([?&](?:api[_-]?key|key|token|secret|password|credential)=)[^&#\s]+/gi;

function redactString(value: string): string {
  return value
    .replace(TOKEN_RE, "[REDACTED]")
    .replace(BEARER_RE, "Bearer [REDACTED]")
    .replace(ASSIGNMENT_RE, "$1=[REDACTED]")
    .replace(QUERY_SECRET_RE, "$1[REDACTED]");
}

function sanitizeValue(value: unknown, parentKey = "", seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, parentKey, seen));
  }

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const redactAllValues = /^env$/i.test(parentKey);
  const secretPath = typeof source.key === "string" && /(?:token|secret|password|passwd|credential|api[_-]?key|private[_-]?key)/i.test(source.key);
  for (const [key, item] of Object.entries(source)) {
    if (redactAllValues || SECRET_KEY_RE.test(key) || (secretPath && key === "value")) {
      out[key] = "[REDACTED]";
      continue;
    }
    if (CONTENT_KEY_RE.test(key)) {
      const size = typeof item === "string" ? ` ${item.length} chars` : "";
      out[key] = `[REDACTED CONTENT${size}]`;
      continue;
    }
    out[key] = sanitizeValue(item, key, seen);
  }
  return out;
}

/** Return an audit-safe copy of arbitrary tool arguments. */
export function sanitizeAuditArgs(args: unknown): unknown {
  return sanitizeValue(args);
}

function clipArgs(args: unknown): string | undefined {
  if (args === undefined) return undefined;
  let s: string;
  try {
    const safe = sanitizeAuditArgs(args);
    s = typeof safe === "string" ? safe : JSON.stringify(safe);
  } catch {
    s = "[unserializable arguments]";
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

/** Append one redacted JSON line to the per-user audit log. Never throws. */
export function audit(entry: AuditEntry): void {
  const { args, summary, ...rest } = entry;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...rest,
    ...(summary !== undefined ? { summary: redactString(summary).slice(0, 1000) } : {}),
    ...(args !== undefined ? { args: clipArgs(args) } : {}),
  });
  const payload = `${line}\n`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    const bytes = Buffer.byteLength(payload);
    rotateIfNeeded(bytes);
    fs.appendFileSync(LOG_FILE, payload, { mode: 0o600 });
    try {
      fs.chmodSync(LOG_FILE, 0o600);
    } catch {
      /* best effort */
    }
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
