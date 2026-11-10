// The action planner's execution layer.
//
// observe() answers what is on screen in one call: the front app, its windows,
// the display geometry including Retina scale, the accessibility tree, the states
// that change what to do next, and a coarse visual thumbprint. uiDo() resolves a
// target by name, picks the most reliable method the app supports, performs it,
// then looks again and reports what changed. Geometry is the last resort and its
// result is verified rather than assumed.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAppleScript } from "./applescript.js";
import {
  appControl,
  keyboard,
  mouse,
  pidForApp,
  screenCapture,
  uiActPath,
  uiNodes,
  windowList,
  type UiNode,
  type WindowInfo,
} from "./computer.js";
import { describeContext, lastContextFor, recordContext } from "./context.js";
import { failed, good, jxa, run, truncate, type Outcome } from "./exec.js";
import {
  centerOf,
  chooseMethod,
  describePlan,
  detectState,
  rankCandidates,
  verifyTransition,
  type ActionPlan,
  type Capabilities,
  type Candidate,
  type Observation,
  type ScreenFlags,
  type TargetQuery,
  type UiLike,
} from "./targeting.js";

const DEFAULT_SHORTCUTS: Record<string, string[]> = {
  new: ["cmd", "n"],
  open: ["cmd", "o"],
  save: ["cmd", "s"],
  save_as: ["cmd", "shift", "s"],
  print: ["cmd", "p"],
  close: ["cmd", "w"],
  quit: ["cmd", "q"],
  find: ["cmd", "f"],
  select_all: ["cmd", "a"],
  undo: ["cmd", "z"],
  redo: ["cmd", "shift", "z"],
  copy: ["cmd", "c"],
  cut: ["cmd", "x"],
  paste: ["cmd", "v"],
  preferences: ["cmd", ","],
};

const SCRIPTABLE = new Set([
  "Pages",
  "Numbers",
  "Keynote",
  "Safari",
  "Finder",
  "Mail",
  "Music",
  "Notes",
  "Calendar",
  "Reminders",
  "Preview",
  "TextEdit",
  "Google Chrome",
  "Microsoft Word",
  "Microsoft Excel",
  "Microsoft PowerPoint",
]);

const APP_COMMANDS: Record<string, Record<string, string>> = {
  Pages: { "new document": 'tell application "Pages" to make new document' },
  Numbers: { "new document": 'tell application "Numbers" to make new document' },
  Keynote: { "new document": 'tell application "Keynote" to make new document' },
  Safari: { "new window": 'tell application "Safari" to make new document' },
  Finder: { "new folder": 'tell application "Finder" to make new folder' },
  TextEdit: { "new document": 'tell application "TextEdit" to make new document' },
};

export function capabilitiesFor(app: string, accessible: boolean): Capabilities {
  return {
    accessible,
    scriptable: SCRIPTABLE.has(app),
    shortcuts: { ...DEFAULT_SHORTCUTS },
    commands: APP_COMMANDS[app] ?? {},
  };
}

export interface DisplayInfo {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

const SCREEN_BODY = `
ObjC.import('AppKit');
var screens = $.NSScreen.screens;
var out = [];
for (var i = 0; i < screens.count; i++) {
  var s = screens.objectAtIndex(i);
  var f = s.frame, v = s.visibleFrame;
  out.push({
    index: i,
    x: Math.round(f.origin.x), y: Math.round(f.origin.y),
    width: Math.round(f.size.width), height: Math.round(f.size.height),
    scale: Number(s.backingScaleFactor),
    visible: { x: Math.round(v.origin.x), y: Math.round(v.origin.y), width: Math.round(v.size.width), height: Math.round(v.size.height) }
  });
}
JSON.stringify(out);
`;

/** Screen geometry in points, with the Retina scale each display reports. Origins
 *  use AppKit coordinates, which start at the bottom left of the main display. */
export async function displays(): Promise<DisplayInfo[]> {
  const res = await jxa(SCREEN_BODY, 15_000);
  const raw = res.out.trim().split("\n").pop() ?? "";
  try {
    const parsed = JSON.parse(raw) as DisplayInfo[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const FRONT_BODY = `
ObjC.import('CoreGraphics');
var ref = $.CGWindowListCopyWindowInfo(1, 0);
var name = '';
if (ref) {
  var a = ObjC.castRefToObject(ref);
  for (var i = 0; i < a.count && !name; i++) {
    var d = a.objectAtIndex(i);
    var layer = ObjC.unwrap(d.objectForKey('kCGWindowLayer'));
    var owner = String(ObjC.unwrap(d.objectForKey('kCGWindowOwnerName')) || '');
    if (Number(layer) === 0 && owner && owner !== 'Window Server' && owner !== 'Dock') name = owner;
  }
}
JSON.stringify({ name: name });
`;

/** The app that owns the frontmost normal window. This reads the window server
 *  rather than asking an app, so it works before any automation permission. */
export async function frontApp(): Promise<string | undefined> {
  const res = await jxa(FRONT_BODY, 10_000);
  const raw = res.out.trim().split("\n").pop() ?? "";
  try {
    const parsed = JSON.parse(raw) as { name?: string };
    return parsed.name || undefined;
  } catch {
    return undefined;
  }
}

async function thumbprint(): Promise<{ hash?: string; file?: string }> {
  const file = path.join(os.tmpdir(), `lap-thumb-${process.pid}-${Date.now()}.png`);
  const capture = await screenCapture({ path: file, format: "png" });
  if (!capture.ok) return {};
  const small = `${file}.small.png`;
  const res = await run("/usr/bin/sips", ["-Z", "64", file, "--out", small], { timeoutMs: 15_000 });
  const source = res.ok && fs.existsSync(small) ? small : file;
  try {
    const hash = createHash("sha1").update(fs.readFileSync(source)).digest("hex").slice(0, 12);
    return { hash, file };
  } catch {
    return {};
  }
}

export interface ObserveOptions {
  app?: string;
  depth?: number;
  maxNodes?: number;
  screenshot?: boolean;
  /** Include the stored trail of apps and windows this session worked with. */
  context?: boolean;
}

export interface ScreenObservation {
  app: string;
  pid?: number;
  frontmost: string | undefined;
  isFrontmost: boolean;
  windowTitle?: string;
  windowBounds?: { x: number; y: number; width: number; height: number };
  windows: WindowInfo[];
  displays: DisplayInfo[];
  nodes: UiNode[];
  flags: ScreenFlags;
  thumbprint?: string;
  screenshot?: string;
  axError?: string;
  contextTrail?: string;
  notes: string[];
}

function largestWindow(windows: WindowInfo[]): WindowInfo | undefined {
  const normal = windows.filter((win) => win.layer === 0 && win.width > 40 && win.height > 40);
  return normal.sort((a, b) => b.width * b.height - a.width * a.height)[0];
}

/** One call that answers "what is on screen and what state is it in". */
export async function observe(options: ObserveOptions = {}): Promise<ScreenObservation> {
  const front = await frontApp();
  const app = options.app ?? front ?? "";
  const notes: string[] = [];
  const [tree, listing, screens] = await Promise.all([
    app ? uiNodes({ app, depth: options.depth ?? 7, maxNodes: options.maxNodes ?? 400 }) : Promise.resolve({ ok: false, nodes: [], error: "no app given and no front window" }),
    windowList({ ...(app ? { app } : {}), includeOffscreen: true }),
    displays(),
  ]);
  const windows = listing.windows ?? [];
  const active = largestWindow(windows);
  const nodes = tree.nodes ?? [];
  const flags = detectState(nodes as UiLike[]);
  let shot: { hash?: string; file?: string } = {};
  if (options.screenshot) shot = await thumbprint();
  if (!tree.ok && tree.error) notes.push(tree.error);
  if (app && front && app.toLowerCase() !== front.toLowerCase()) {
    notes.push(`${app} is not frontmost; ${front} is. Actions on ${app} may need it activated first.`);
  }
  if (active && active.onscreen === false) {
    notes.push(
      `${app} has a window that is not drawn right now (${active.width}x${active.height} "${active.title.slice(0, 40)}"). It is minimized, hidden, or on another Space, so make ${app} active before acting on it.`,
    );
  }
  if (screens.length > 1) notes.push(`${screens.length} displays attached; coordinates are in points, not pixels.`);
  const retina = screens.filter((screen) => Number(screen.scale) > 1);
  if (retina.length) notes.push(`Retina scale ${retina.map((screen) => screen.scale).join("/")} on display ${retina.map((screen) => screen.index).join(",")}.`);

  const pid = app ? await pidForApp(app) : undefined;
  const windowBounds = active ? { x: active.x, y: active.y, width: active.width, height: active.height } : undefined;
  if (app) {
    recordContext({ app, windowTitle: active?.title || undefined, windowBounds, pid, displays: screens.length, step: "observe" });
  }

  return {
    app,
    pid,
    frontmost: front,
    isFrontmost: Boolean(app && front && app.toLowerCase() === front.toLowerCase()),
    windowTitle: active?.title || undefined,
    windowBounds,
    windows,
    displays: screens,
    nodes,
    flags,
    thumbprint: shot.hash,
    screenshot: shot.file,
    axError: tree.ok ? undefined : tree.error,
    contextTrail: options.context ? describeContext() : undefined,
    notes,
  };
}

function asObservation(screen: ScreenObservation): Observation {
  const focused = screen.nodes.find((node) => node.focused === true);
  return {
    title: screen.windowTitle,
    focusedPath: focused?.path,
    thumbprint: screen.thumbprint,
    nodes: screen.nodes as UiLike[],
    flags: screen.flags,
  };
}

function renderObservation(screen: ScreenObservation, limit = 18): string {
  const lines: string[] = [];
  lines.push(`app: ${screen.app || "unknown"}${screen.pid ? ` (pid ${screen.pid})` : ""}${screen.isFrontmost ? " [frontmost]" : ""}`);
  if (screen.windowTitle) lines.push(`window: "${screen.windowTitle.slice(0, 100)}"`);
  if (screen.windowBounds) {
    const b = screen.windowBounds;
    lines.push(`bounds: ${b.x},${b.y} ${b.width}x${b.height} points`);
  }
  for (const display of screen.displays) {
    lines.push(`display ${display.index}: ${display.width}x${display.height} at ${display.x},${display.y}, scale ${display.scale}`);
  }
  const on = Object.entries(screen.flags)
    .filter(([key, value]) => key !== "modals" && value === true)
    .map(([key]) => key);
  if (on.length) lines.push(`state: ${on.join(", ")}`);
  for (const modal of screen.flags.modals) lines.push(`modal: "${modal.title}" path=${modal.path}`);
  if (screen.thumbprint) lines.push(`thumbprint: ${screen.thumbprint}`);
  if (screen.nodes.length) {
    lines.push(`nodes: ${screen.nodes.length} (showing ${Math.min(limit, screen.nodes.length)})`);
    for (const node of screen.nodes.slice(0, limit)) {
      const label = node.title ?? node.description ?? node.value ?? "";
      lines.push(`  ${node.role}${label ? ` "${String(label).slice(0, 60)}"` : ""}${node.path ? ` path=${node.path}` : ""}`);
    }
  }
  if (screen.notes.length) lines.push(`notes: ${screen.notes.join(" ")}`);
  if (screen.contextTrail) lines.push(screen.contextTrail);
  return lines.join("\n");
}

export interface UiDoArgs {
  app?: string;
  name?: string;
  role?: string;
  identifier?: string;
  text?: string;
  index?: number;
  action?: "press" | "set_value" | "click" | "shortcut";
  value?: string;
  keys?: string[];
  intent?: string;
  method?: string;
  dryRun?: boolean;
  verify?: boolean;
  /** Accessibility traversal controls for very large app trees. */
  depth?: number;
  maxNodes?: number;
  /** Continue with the app this session last observed instead of the frontmost one. */
  resume?: boolean;
}

function parseKeys(keys: string[]): { modifiers: Array<"command" | "shift" | "option" | "control">; key: string } {
  const modifiers: Array<"command" | "shift" | "option" | "control"> = [];
  let key = "";
  for (const part of keys) {
    const lower = part.toLowerCase();
    if (lower === "cmd" || lower === "command" || lower === "meta") modifiers.push("command");
    else if (lower === "shift") modifiers.push("shift");
    else if (lower === "opt" || lower === "option" || lower === "alt") modifiers.push("option");
    else if (lower === "ctrl" || lower === "control") modifiers.push("control");
    else key = part;
  }
  return { modifiers, key };
}

async function activate(app: string): Promise<Outcome> {
  const res = await appControl({ action: "activate", app });
  if (res.ok) await new Promise((resolve) => setTimeout(resolve, 400));
  return res;
}

async function executePlan(plan: ActionPlan, app: string, value: string | undefined): Promise<Outcome> {
  switch (plan.method) {
    case "ax_press":
      return uiActPath({ app, path: plan.path ?? "", action: "press" });
    case "ax_set_value":
      return uiActPath({ app, path: plan.path ?? "", action: "set_value", value: value ?? "" });
    case "shortcut": {
      const { modifiers, key } = parseKeys(plan.keys ?? []);
      return keyboard({ action: "combo", keys: [key], modifiers, app });
    }
    case "applescript_command": {
      const res = await runAppleScript(plan.script ?? "", 30_000);
      return res.ok ? good(res.out.trim() || "AppleScript command ran.") : failed(res.error ?? "AppleScript command failed.");
    }
    case "pointer_click": {
      const point = plan.point;
      if (!point) return failed("No usable bounds for a pointer click.");
      return mouse({ action: "click", x: point.x, y: point.y });
    }
    default:
      return failed(plan.blocked ?? "No method can reach this element.");
  }
}

/** Resolve, choose, act, then look again. The reply carries the evidence, because
 *  a click that reported success without proof is the failure mode this exists to stop. */
export async function uiDo(args: UiDoArgs): Promise<Outcome> {
  const resumed = !args.app && args.resume ? lastContextFor() : undefined;
  const depth = Math.max(1, Math.min(16, Math.round(args.depth ?? 8)));
  const maxNodes = Math.max(50, Math.min(4000, Math.round(args.maxNodes ?? 500)));
  const before = await observe({ app: args.app ?? resumed?.app, depth, maxNodes, screenshot: args.verify !== false });
  if (!before.app) return failed("No app to act on. Name one, or focus a window first.");
  const app = before.app;
  const caps = capabilitiesFor(app, before.nodes.length > 0);

  if (args.action === "shortcut" && args.keys?.length) {
    const plan: ActionPlan = {
      method: "shortcut",
      confidence: "medium",
      why: "the caller asked for these keys directly",
      keys: args.keys,
      steps: [`send ${args.keys.join("+")} to ${app}`, "confirm the window or document changed"],
      fallbacks: [],
    };
    if (!before.isFrontmost) await activate(app);
    const outcome = await executePlan(plan, app, args.value);
    const after = await observe({ app, depth, maxNodes, screenshot: true });
    const check = verifyTransition(asObservation(before), asObservation(after), plan);
    return report(plan, outcome, check, before, after, args.verify !== false);
  }

  const query: TargetQuery = { name: args.name, role: args.role, identifier: args.identifier, text: args.text, index: args.index };
  if (!query.name && !query.identifier && !query.text) {
    return failed("Give a name, text or identifier to act on. screen_observe lists what is there.");
  }
  let candidates = rankCandidates(before.nodes as UiLike[], query);
  if (!candidates.length && !before.isFrontmost) {
    // The app may not have published its tree while it was in the background.
    await activate(app);
    const again = await observe({ app, depth, maxNodes });
    candidates = rankCandidates(again.nodes as UiLike[], query);
    if (!candidates.length) {
      return failed(
        `Nothing in ${app} matches ${JSON.stringify(query.name ?? query.text ?? query.identifier)}. ` +
          (again.axError ? `Accessibility reported: ${again.axError}` : "screen_observe shows the tree that is available."),
      );
    }
    Object.assign(before, again);
  }
  if (!candidates.length) {
    return failed(
      `Nothing in ${app} matches ${JSON.stringify(query.name ?? query.text ?? query.identifier)}. ` +
        (before.axError ? `Accessibility reported: ${before.axError}` : "screen_observe shows the tree that is available."),
    );
  }

  const chosen: Candidate = candidates[0];
  let plan = chooseMethod(chosen.node, { app, intent: args.intent, capabilities: caps, value: args.action === "set_value" ? args.value ?? "" : undefined });
  if (args.action === "click") {
    const point = centerOf(chosen.node);
    plan = point
      ? { method: "pointer_click", confidence: "low", why: "the caller asked for a click at the element's current center", point, steps: [`click ${point.x},${point.y}`], fallbacks: [] }
      : plan;
  }
  if (args.method && args.method !== plan.method) {
    plan = { ...plan, why: `${plan.why} (overridden to ${args.method} by the caller)` };
    if (args.method === "pointer_click") {
      const point = centerOf(chosen.node);
      if (point) plan = { ...plan, method: "pointer_click", point };
    }
  }

  const ambiguity =
    candidates.length > 1 && candidates[1].score >= chosen.score - 8
      ? `\nambiguous: "${String(candidates[1].node.title ?? candidates[1].node.description ?? "").slice(0, 60)}" scored ${candidates[1].score} vs ${chosen.score}. Pass index or role to disambiguate.`
      : "";
  const header = `target: ${chosen.node.role}${chosen.node.title ? ` "${String(chosen.node.title).slice(0, 70)}"` : ""} path=${chosen.node.path ?? "?"} (score ${chosen.score})\n${describePlan(plan)}${ambiguity}`;

  if (args.dryRun) {
    return good(`Would act on ${app}.\n${header}\n\nScreen now:\n${renderObservation(before, 10)}`);
  }

  if (!before.isFrontmost) await activate(app);
  let outcome = await executePlan(plan, app, args.value);
  let after = await observe({ app, depth, maxNodes, screenshot: true });
  let check = verifyTransition(asObservation(before), asObservation(after), plan);

  // One bounded recovery: focus drifted or the window moved under a geometric click.
  if (outcome.ok && !check.verified && plan.method === "pointer_click") {
    const fresh = rankCandidates(after.nodes as UiLike[], query)[0];
    const point = fresh ? centerOf(fresh.node) : undefined;
    if (point && (point.x !== plan.point?.x || point.y !== plan.point?.y)) {
      const retry: ActionPlan = { ...plan, point, why: `${plan.why}; retried at the updated center after the first click changed nothing` };
      outcome = await executePlan(retry, app, args.value);
      after = await observe({ app, depth, maxNodes, screenshot: true });
      check = verifyTransition(asObservation(before), asObservation(after), retry);
      plan = retry;
    }
  }

  return report(plan, outcome, check, before, after, args.verify !== false);
}

function report(
  plan: ActionPlan,
  outcome: Outcome,
  check: { verified: boolean; weak: boolean; evidence: string[] },
  before: ScreenObservation,
  after: ScreenObservation,
  verifyWanted: boolean,
): Outcome {
  const lines: string[] = [];
  lines.push(`${outcome.ok ? "Did" : "Could not do"} ${plan.method} on ${after.app}${plan.path ? ` (path ${plan.path})` : ""}.`);
  if (plan.point) lines.push(`point: ${plan.point.x},${plan.point.y}`);
  lines.push(`why: ${plan.why}`);
  if (!outcome.ok) lines.push(`error: ${outcome.message}`);
  if (verifyWanted) {
    lines.push(`verified: ${check.verified ? (check.weak ? "yes, by pixels only" : "yes") : "no"}`);
    for (const line of check.evidence) lines.push(`  - ${line}`);
  }
  if (after.flags.dialog) lines.push(`dialog is now open: ${after.flags.modals.map((m) => `"${m.title}"`).join(", ") || "untitled"}`);
  if (after.flags.permissionPrompt) lines.push("this looks like a permission prompt; a person has to answer it");
  if (after.flags.loading) lines.push("the app reports a loading state; wait_for or task_run with a wait check is the honest next step");
  if (before.windowBounds && after.windowBounds) {
    const moved = before.windowBounds.x !== after.windowBounds.x || before.windowBounds.y !== after.windowBounds.y;
    if (moved) lines.push(`window moved during the action: ${before.windowBounds.x},${before.windowBounds.y} -> ${after.windowBounds.x},${after.windowBounds.y}`);
  }
  if (!check.verified && outcome.ok) lines.push(`nothing observable changed. Next: re-run screen_observe, or try ${plan.fallbacks[0] ?? "a different target"}.`);
  const text = lines.join("\n");
  return outcome.ok && (!verifyWanted || check.verified) ? good(text) : failed(text);
}

export interface UiRecoverArgs {
  app?: string;
  action?: "focus" | "escape" | "reobserve";
}

/** The three things that actually break: focus went somewhere else, a stray
 *  window or dialog is in front, or the tree was stale. */
export async function uiRecover(args: UiRecoverArgs): Promise<Outcome> {
  const app = args.app ?? (await frontApp());
  const action = args.action ?? "focus";
  const lines: string[] = [];
  if (action === "escape") {
    const res = await keyboard({ action: "key", key: "escape", app });
    lines.push(res.ok ? `Sent Escape to ${app ?? "the front app"}.` : `Escape failed: ${res.message}`);
    lines.push("Escape cancels unsaved dialogs in some apps. Confirm the window still holds the work.");
  } else if (action === "focus" && app) {
    const res = await activate(app);
    lines.push(res.ok ? `${app} is frontmost again.` : `Could not activate ${app}: ${res.message}`);
  }
  const screen = await observe({ app, depth: 6, maxNodes: 300 });
  lines.push("");
  lines.push(renderObservation(screen, 12));
  return screen.nodes.length || screen.displays.length ? good(lines.join("\n")) : failed(lines.join("\n"));
}

export function summarizeScreen(screen: ScreenObservation): string {
  return renderObservation(screen);
}
