// On-device configuration store: the app's saved state.
//
// Everything machine-specific (paths, device name, API keys, plugin locations)
// lives in one JSON file on this Mac, never in the source tree, so the same
// build ships to everyone. The file is written atomically with mode 0600 and
// can be edited through the MCP `app_config` tool or the local HTTP API the
// frontend talks to (`/api/config`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import packageJson from "../package.json" with { type: "json" };

export interface AppConfig {
  version: number;
  general: {
    deviceName: string;
    timezone: string | null;
    locale: string | null;
  };
  paths: {
    workspace: string;
    screenshots: string;
    downloads: string;
  };
  computerUse: {
    /** Overrides the auto-discovered Codex Computer Use plugin dir. */
    pluginDir: string | null;
    /** CODEX_HOME, if the plugin lives somewhere else. */
    codexHome: string | null;
    screenshotMaxWidth: number;
    screenshotFormat: "png" | "jpeg";
    /** Pause between synthetic input events, in ms. */
    inputDelayMs: number;
    /** Per-character delay when typing, in ms. */
    typingDelayMs: number;
  };
  shell: {
    defaultTimeoutSeconds: number;
    maxTimeoutSeconds: number;
  };
  security: {
    /** When true, destructive tools refuse and explain instead of acting. */
    dryRun: boolean;
    /** Extra directories tools may read/write beyond the defaults. */
    allowedRoots: string[];
  };
  integrations: {
    /** Free-form API keys the user adds; redacted on read. */
    secrets: Record<string, string>;
  };
  updatedAt: string | null;
}

export const CONFIG_VERSION = 1;
/** Shipped version, reported by the MCP handshake and the HTTP API. */
export const APP_VERSION = packageJson.version;

export function appHome(): string {
  const override = process.env.LOCAL_AGENT_MCP_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "local-agent-mcp");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg && xdg.trim() ? xdg : path.join(os.homedir(), ".config"), "local-agent-mcp");
}

export function configPath(): string {
  return path.join(appHome(), "config.json");
}

export function defaultConfig(): AppConfig {
  const home = os.homedir();
  return {
    version: CONFIG_VERSION,
    general: {
      deviceName: os.hostname().replace(/\.local$/, ""),
      timezone: null,
      locale: null,
    },
    paths: {
      workspace: home,
      screenshots: path.join(appHome(), "screenshots"),
      downloads: path.join(home, "Downloads"),
    },
    computerUse: {
      pluginDir: null,
      codexHome: null,
      screenshotMaxWidth: 1600,
      screenshotFormat: "png",
      inputDelayMs: 12,
      typingDelayMs: 4,
    },
    shell: {
      defaultTimeoutSeconds: 60,
      maxTimeoutSeconds: 600,
    },
    security: {
      dryRun: false,
      allowedRoots: [],
    },
    integrations: {
      secrets: {},
    },
    updatedAt: null,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Deep-merge a patch onto `base`, rejecting type changes so typos fail loudly. */
export function mergeConfig(base: unknown, patch: unknown, at = ""): unknown {
  if (!isPlainObject(patch)) throw new Error(`${at || "config"} must be an object`);
  const out: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const where = at ? `${at}.${key}` : key;
    const current = out[key];
    if (isPlainObject(value)) {
      out[key] = mergeConfig(isPlainObject(current) ? current : {}, value, where);
      continue;
    }
    if (Array.isArray(value)) {
      if (current !== undefined && !Array.isArray(current)) {
        throw new Error(`${where} is a list; got ${typeof value}`);
      }
      out[key] = value;
      continue;
    }
    if (value === null) {
      if (current !== undefined && current !== null && typeof current !== "object") {
        throw new Error(`${where} cannot be null`);
      }
      out[key] = null;
      continue;
    }
    if (current !== undefined && current !== null && typeof current !== typeof value) {
      throw new Error(`${where} expects ${typeof current}, got ${typeof value}`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`${where} must be a finite number`);
    }
    out[key] = value;
  }
  return out;
}

function backupCorrupt(file: string): void {
  try {
    fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
  } catch {
    /* best effort */
  }
}

export function loadConfig(): AppConfig {
  const file = configPath();
  const defaults = defaultConfig();
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") backupCorrupt(file);
    return defaults;
  }
  try {
    const merged = mergeConfig(defaults, raw) as AppConfig;
    merged.version = CONFIG_VERSION;
    return merged;
  } catch {
    backupCorrupt(file);
    return defaults;
  }
}

/** Atomic write: temp file in the same directory, then rename. Mode 0600. */
export function saveConfig(config: AppConfig): AppConfig {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const next: AppConfig = { ...config, version: CONFIG_VERSION, updatedAt: new Date().toISOString() };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
  return next;
}

export function patchConfig(patch: unknown): AppConfig {
  const current = loadConfig();
  const merged = mergeConfig(current, patch) as AppConfig;
  return saveConfig(merged);
}

export function resetConfig(): AppConfig {
  return saveConfig(defaultConfig());
}

/** Dot-path read, e.g. `getPath(cfg, "shell.defaultTimeoutSeconds")`. */
export function getPath(config: unknown, dotted: string): unknown {
  let cursor: unknown = config;
  for (const part of dotted.split(".").filter(Boolean)) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

/** Dot-path write through the validating merger. */
export function setPath(dotted: string, value: unknown): AppConfig {
  const parts = dotted.split(".").filter(Boolean);
  if (!parts.length) throw new Error("path is empty");
  let patch: unknown = value;
  for (const part of [...parts].reverse()) patch = { [part]: patch };
  return patchConfig(patch);
}

export function unsetPath(dotted: string): AppConfig {
  const parts = dotted.split(".").filter(Boolean);
  if (!parts.length) throw new Error("path is empty");
  const config = clone(loadConfig()) as unknown as Record<string, unknown>;
  let cursor: Record<string, unknown> | undefined = config;
  for (const part of parts.slice(0, -1)) {
    cursor = isPlainObject(cursor?.[part]) ? (cursor![part] as Record<string, unknown>) : undefined;
  }
  if (cursor) delete cursor[parts[parts.length - 1]];
  return saveConfig(config as unknown as AppConfig);
}

const SECRET_RE = /(key|token|secret|password|passwd|credential)/i;

function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "********";
  return `${value.slice(0, 3)}...${value.slice(-2)} (${value.length} chars)`;
}

/** Config as safe to show a model or a browser: secrets become masks. */
export function redactConfig(config: AppConfig): AppConfig {
  const copy = clone(config);
  const secrets = copy.integrations?.secrets ?? {};
  for (const [name, value] of Object.entries(secrets)) {
    if (SECRET_RE.test(name) || value.length > 12) secrets[name] = maskSecret(value);
  }
  return copy;
}

export function ensureDirs(config: AppConfig): void {
  for (const dir of [config.paths.screenshots, config.paths.downloads]) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    } catch {
      /* read-only or missing parent: callers report the real failure */
    }
  }
}

/** Expand `~` and make absolute against the workspace. */
export function resolveUserPath(input: string, config: AppConfig = loadConfig()): string {
  let value = input.trim();
  if (value === "~") value = os.homedir();
  else if (value.startsWith("~/")) value = path.join(os.homedir(), value.slice(2));
  if (!path.isAbsolute(value)) value = path.join(config.paths.workspace, value);
  return path.resolve(value);
}
