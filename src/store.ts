// Filesystem primitives for the durable stores (tasks, skills, metrics).
//
// Writes are atomic where replacement semantics are intended. JSONL tails are
// read from the end of the file so years of task history do not have to be
// loaded into RAM just to show the latest few events.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const suffix = randomBytes(6).toString("hex");
  const tmp = `${file}.${process.pid}.${suffix}.tmp`;
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      // Atomic rename protects against process crashes. Full fsync is optional
      // because forcing it on every checkpoint destroys high-frequency throughput.
      if (process.env.LOCAL_AGENT_FSYNC === "1") fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* renamed or already removed */
    }
  }
}

export function appendJsonl(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  // One append syscall keeps individual JSONL records intact between processes
  // on local filesystems, while avoiding a read/modify/write cycle.
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function tailText(file: string, maxBytes: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    if (!size) return "";
    const take = Math.min(size, Math.max(4096, maxBytes));
    const start = size - take;
    const buf = Buffer.allocUnsafe(take);
    let read = 0;
    while (read < take) {
      const n = fs.readSync(fd, buf, read, take - read, start + read);
      if (!n) break;
      read += n;
    }
    let text = buf.subarray(0, read).toString("utf8");
    // If we started mid-file, discard the first partial record. The final
    // record is retained even if the file does not end with a newline.
    if (start > 0) {
      const firstNl = text.indexOf("\n");
      text = firstNl >= 0 ? text.slice(firstNl + 1) : "";
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

export function readJsonl<T>(file: string, limit = 100, maxBytes = 2 * 1024 * 1024): T[] {
  try {
    const wanted = Math.max(1, Math.min(limit, 10_000));
    const text = tailText(file, Math.max(64 * 1024, Math.min(maxBytes, 64 * 1024 * 1024)));
    const lines = text.split("\n").filter(Boolean);
    const out: T[] = [];
    for (const line of lines.slice(-wanted)) {
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        // A corrupt or partially written line should not hide the rest of the
        // durable log. Atomic task state remains authoritative.
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function listJson(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

export function removeFile(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* already gone */
  }
}
