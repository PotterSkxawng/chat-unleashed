// Proxy to Codex's own Computer Use MCP server (`cua_repl`).
//
// Rather than reimplementing screen control, we launch exactly the server ChatGPT
// launches - configured by the installed `unified-computer-use` plugin's .mcp.json - and
// forward tool calls to it. The tool definitions in ./cua-tools.json are a verbatim
// snapshot of what that server advertises, so our tools/list matches Codex even before
// the child has started.
//
// The child drives `Codex Computer Use.app` (SkyComputerUseService), which is where all
// macOS permission handling lives; nothing here touches the screen directly.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { audit } from "./audit.js";
import { APP_VERSION, loadConfig } from "./config.js";
import snapshot from "./cua-tools.json" with { type: "json" };

export type CuaToolDef = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  _meta?: Record<string, unknown>;
};

export const CUA_TOOLS = snapshot as CuaToolDef[];
export const CUA_TOOL_NAMES: Set<string> = new Set(CUA_TOOLS.map((t) => t.name));

/**
 * Where the Codex Computer Use plugin lives on this machine.
 * Overridable so a packaged build never depends on one user's layout:
 *   CHAT_UNLEASHED_CUA_PLUGIN_DIR  exact plugin directory
 *   CODEX_HOME                  root of the Codex install (default ~/.codex)
 *   app_config computerUse.pluginDir  same override, stored per machine
 */
function pluginRoot(): string {
  const direct = process.env.CHAT_UNLEASHED_CUA_PLUGIN_DIR?.trim();
  if (direct) return path.resolve(direct);
  let fromConfig: string | null = null;
  try {
    fromConfig = loadConfig().computerUse.pluginDir;
  } catch {
    fromConfig = null;
  }
  if (fromConfig) return path.resolve(fromConfig);
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "plugins", "cache", "openai-bundled", "unified-computer-use");
}
const DIAGNOSTIC_CAP = 4000;

type PluginConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  startup_timeout_sec?: number;
};

let child: ChildProcess | null = null;
let startPromise: Promise<void> | null = null;
let nextId = 1;
let stdoutBuf = "";
let stderrTail = "";
const pending = new Map<
  number,
  { resolve: (msg: Record<string, unknown>) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
>();

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Newest installed unified-computer-use plugin dir that actually has a .mcp.json. */
function pickPluginDir(): string | null {
  const root = pluginRoot();
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return null;
  }
  const dirs = entries
    .map((e) => path.join(root, e))
    .filter((dir) => fs.existsSync(path.join(dir, ".mcp.json")));
  if (dirs.length === 0) return null;
  dirs.sort((a, b) => compareVersions(path.basename(b), path.basename(a)));
  return dirs[0];
}

function loadPluginConfig(): { config: PluginConfig; dir: string } {
  const dir = pickPluginDir();
  if (!dir) {
    throw new Error(
      `Computer Use plugin not found under ${pluginRoot()}. ` +
        "Install/enable Computer Use in the ChatGPT desktop app first, " +
        "or point app_config computerUse.pluginDir at its directory.",
    );
  }
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8")) as {
    mcpServers?: Record<string, PluginConfig>;
  };
  const config = parsed.mcpServers?.cua_repl;
  if (!config?.command) {
    throw new Error(`No mcpServers.cua_repl entry in ${path.join(dir, ".mcp.json")}`);
  }
  return { config, dir };
}

function handleMessage(msg: Record<string, unknown>): void {
  const id = msg.id;
  if (typeof id !== "number") return; // notifications (e.g. logging) are ignored
  const waiter = pending.get(id);
  if (!waiter) return;
  pending.delete(id);
  clearTimeout(waiter.timer);
  waiter.resolve(msg);
}

function writeLine(line: string): void {
  if (!child || !child.stdin || child.stdin.destroyed) {
    throw new Error("cua_repl child is not running");
  }
  child.stdin.write(line + "\n");
}

function rpc(method: string, params: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
  if (!child) return Promise.reject(new Error("cua_repl child is not running"));
  const id = nextId++;
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`cua_repl timed out after ${timeoutMs}ms waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      writeLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      reject(err as Error);
    }
  });
}

function failStart(err: unknown): never {
  const message = (err as Error)?.message ?? String(err);
  audit({
    event: "cua_start_failed",
    ok: false,
    summary: stderrTail ? `${message} | stderr: ${stderrTail.slice(-500)}` : message,
  });
  stopChild();
  throw err instanceof Error ? err : new Error(message);
}

function stopChild(): void {
  for (const [, waiter] of pending) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error("cua_repl child stopped"));
  }
  pending.clear();
  if (child) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  child = null;
  startPromise = null;
}

/**
 * Spawn Codex's cua_repl exactly as the plugin config describes and complete the MCP
 * handshake. Memoized; concurrent callers share one start. Any failure clears the memo
 * so the next call retries.
 */
function ensureStarted(): Promise<void> {
  if (startPromise) return startPromise;
  startPromise = (async () => {
    const { config, dir } = loadPluginConfig();
    const c = spawn(config.command, config.args ?? [], {
      env: { ...process.env, ...(config.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      cwd: os.homedir(),
    });
    child = c;
    stdoutBuf = "";
    stderrTail = "";

    c.stdout?.setEncoding("utf8");
    c.stdout?.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      let index: number;
      while ((index = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, index).trim();
        stdoutBuf = stdoutBuf.slice(index + 1);
        if (!line) continue;
        try {
          handleMessage(JSON.parse(line) as Record<string, unknown>);
        } catch {
          /* non-JSON output from the child; ignore */
        }
      }
    });
    c.stderr?.setEncoding("utf8");
    c.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-DIAGNOSTIC_CAP);
    });
    c.on("error", (err) => {
      audit({ event: "cua_child_error", ok: false, summary: err.message });
      stopChild();
    });
    c.on("exit", (code, signal) => {
      audit({
        event: "cua_child_exit",
        ok: false,
        summary: `code=${code ?? "null"} signal=${signal ?? "none"} pending=${pending.size}`,
      });
      stopChild();
    });

    const startupMs = (config.startup_timeout_sec ?? 120) * 1000;
    const init = await rpc(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "chat-unleashed", version: APP_VERSION },
      },
      startupMs,
    );
    if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
    writeLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));

    // Drift check: our registered definitions are a snapshot, so warn if the live
    // server has moved on (e.g. after a ChatGPT.app update).
    try {
      const live = (await rpc("tools/list", {}, 30_000)) as {
        result?: { tools?: Array<{ name: string }> };
      };
      const names = (live.result?.tools ?? []).map((t) => t.name).join(",");
      const missing = [...CUA_TOOL_NAMES].filter((n) => !(live.result?.tools ?? []).some((t) => t.name === n));
      if (missing.length > 0) {
        audit({ event: "cua_tool_drift", ok: false, summary: `snapshot has tools the live server lacks: ${missing.join(",")}` });
      } else {
        audit({ event: "cua_ready", summary: `plugin=${path.basename(dir)} live_tools=${names}` });
      }
    } catch (err) {
      audit({ event: "cua_tools_list_failed", ok: false, summary: (err as Error).message });
    }
  })().catch((err) => {
    failStart(err);
  });
  return startPromise;
}

/** Run one tool on Codex's Computer Use runtime and return its MCP result verbatim. */
export async function callCuaTool(
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  await ensureStarted();
  const msg = await rpc("tools/call", { name, arguments: args }, timeoutMs);
  if (msg.error) {
    const err = msg.error as { message?: string; code?: number };
    throw new Error(err.message ?? JSON.stringify(msg.error));
  }
  return (msg.result ?? {}) as Record<string, unknown>;
}

/** Best-effort shutdown so the child never outlives this server. */
export function stopCua(): void {
  stopChild();
}

process.on("exit", () => {
  if (child) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
});
