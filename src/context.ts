// What the agent last worked with on screen, kept between calls.
//
// A multi-app workflow is a sequence like "read the Pages document, paste the
// numbers into Numbers, check Mail". Each call used to start from whatever app
// happened to be frontmost, which loses the thread as soon as focus moves. This
// store remembers the app, window and display each call observed, so the next
// call can go back to the right place and say why.
//
// It is a small append list, newest last, capped, and the person can delete the
// file at any time; nothing else depends on it.
import fs from "node:fs";
import path from "node:path";
import { appHome } from "./config.js";

export interface ContextBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenContextEntry {
  app: string;
  windowTitle?: string;
  windowBounds?: ContextBounds;
  pid?: number;
  displays: number;
  /** What the call was doing, for a readable trail. */
  step?: string;
  at: string;
}

export interface ScreenContext {
  entries: ScreenContextEntry[];
  updatedAt: string;
}

const MAX_ENTRIES = 40;

function contextFile(): string {
  return path.join(appHome(), "screen-context.json");
}

export function readContext(): ScreenContext {
  try {
    const parsed = JSON.parse(fs.readFileSync(contextFile(), "utf8")) as ScreenContext;
    if (!Array.isArray(parsed.entries)) return { entries: [], updatedAt: "" };
    return parsed;
  } catch {
    return { entries: [], updatedAt: "" };
  }
}

function writeContext(context: ScreenContext): void {
  try {
    fs.mkdirSync(path.dirname(contextFile()), { recursive: true });
    fs.writeFileSync(contextFile(), JSON.stringify(context, null, 2), { mode: 0o600 });
  } catch {
    // Losing the trail is not worth failing an action that already happened.
  }
}

/** Remember one observation. Entries for the same app and window collapse to the
 *  newest, so the trail stays short enough to read. */
export function recordContext(entry: Omit<ScreenContextEntry, "at">): ScreenContextEntry {
  const saved: ScreenContextEntry = { ...entry, at: new Date().toISOString() };
  const context = readContext();
  const key = `${saved.app}\u0000${saved.windowTitle ?? ""}`;
  const kept = context.entries.filter((item) => `${item.app}\u0000${item.windowTitle ?? ""}` !== key);
  kept.push(saved);
  writeContext({ entries: kept.slice(-MAX_ENTRIES), updatedAt: saved.at });
  return saved;
}

/** The most recent entry, optionally restricted to one app. */
export function lastContextFor(app?: string): ScreenContextEntry | undefined {
  const entries = readContext().entries;
  if (!app) return entries[entries.length - 1];
  const needle = app.toLowerCase();
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].app.toLowerCase().includes(needle)) return entries[i];
  }
  return undefined;
}

/** Apps in most-recent-first order, which is what a workflow hand-off needs. */
export function recentApps(limit = 5): string[] {
  const entries = readContext().entries;
  const seen: string[] = [];
  for (let i = entries.length - 1; i >= 0 && seen.length < limit; i--) {
    if (!seen.some((name) => name.toLowerCase() === entries[i].app.toLowerCase())) seen.push(entries[i].app);
  }
  return seen;
}

export function forgetContext(): void {
  try {
    fs.rmSync(contextFile(), { force: true });
  } catch {
    // Already gone is the same outcome.
  }
}

export function describeContext(limit = 6): string {
  const context = readContext();
  if (!context.entries.length) return "No screen context has been recorded yet. screen_observe records it.";
  const lines = [`screen context, newest last (${context.entries.length} entries):`];
  for (const entry of context.entries.slice(-limit)) {
    const where = entry.windowTitle ? ` "${entry.windowTitle.slice(0, 60)}"` : "";
    const bounds = entry.windowBounds
      ? ` ${Math.round(entry.windowBounds.width)}x${Math.round(entry.windowBounds.height)} at ${Math.round(entry.windowBounds.x)},${Math.round(entry.windowBounds.y)}`
      : "";
    lines.push(`  ${entry.at}  ${entry.app}${where}${bounds}${entry.step ? `  (${entry.step})` : ""}`);
  }
  lines.push(`apps, most recent first: ${recentApps(6).join(", ") || "none"}`);
  return lines.join("\n");
}
