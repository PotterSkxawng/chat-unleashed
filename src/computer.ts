// Computer-use tools: see the screen, drive the pointer and keyboard, and read
// or act on an app's accessibility tree.
//
// Design notes
//   - Screenshots go through /usr/sbin/screencapture so Retina scaling, window
//     capture and region capture are the OS's own, not a reimplementation.
//   - Pointer events are CGEvent posts (literal enum values, so the bridge does
//     not depend on how a given macOS exports its constants).
//   - Keystrokes and window geometry go through System Events, whose AppleScript
//     surface is far more stable across macOS releases than raw AX value types.
//   - The AX tree reader returns compact JSON the model can reason about, with
//     hard caps on depth/nodes so a huge app cannot flood the context.
import fs from "node:fs";
import path from "node:path";
import { jxa, run, formatBytes, truncate, good, failed, type Outcome } from "./exec.js";
import { loadConfig, resolveUserPath, type AppConfig } from "./config.js";

const SCREENCAPTURE = "/usr/sbin/screencapture";

const AX_HELP =
  "Accessibility permission is missing. Grant it to this server:\n" +
  "  mac_permissions action=request kind=accessibility  (triggers the macOS prompt)\n" +
  "  or System Settings > Privacy & Security > Accessibility and enable the entry for\n" +
  "  the app running this server (the + button accepts the binary path).";

function axError(raw: string): string | null {
  if (/-1719|-25211|-25204|assistive access|not allowed assistive|AXError/i.test(raw)) return AX_HELP;
  return null;
}

function ensureParentDir(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

// --- screen_capture --------------------------------------------------------

export interface ScreenCaptureArgs {
  display?: number;
  window?: string;
  windowId?: number;
  region?: { x: number; y: number; width: number; height: number };
  path?: string;
  maxWidth?: number;
  format?: "png" | "jpeg";
  quality?: number;
  includeCursor?: boolean;
}

export async function screenCapture(args: ScreenCaptureArgs, config: AppConfig = loadConfig()): Promise<Outcome> {
  const format = args.format ?? config.computerUse.screenshotFormat ?? "png";
  const ext = format === "jpeg" ? "jpg" : "png";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = args.path
    ? resolveUserPath(args.path, config)
    : path.join(config.paths.screenshots, `screen-${stamp}.${ext}`);
  ensureParentDir(target);

  const flags: string[] = ["-x", "-t", format];
  if (args.includeCursor) flags.push("-C");
  if (format === "jpeg") flags.push("-o");
  if (args.region) {
    const { x, y, width, height } = args.region;
    flags.push(`-R${Math.round(x)},${Math.round(y)},${Math.round(width)},${Math.round(height)}`);
  } else if (args.windowId) {
    flags.push(`-l${Math.round(args.windowId)}`);
  } else if (args.window) {
    const listed = await windowList({ app: args.window });
    const id = listed.ids[0];
    if (!id) return failed(`No on-screen window found for "${args.window}". Try window_list first.`);
    flags.push(`-l${id}`);
  } else if (args.display) {
    flags.push(`-D${Math.round(args.display)}`);
  }
  flags.push(target);

  const res = await run(SCREENCAPTURE, flags, { timeoutMs: 30_000 });
  const errText = `${res.err} ${res.out}`.trim();
  if (/could not create image|not authorized|Operation not permitted/i.test(errText)) {
    return failed(
      "Screen capture was refused. macOS needs Screen Recording for this server.\n" +
        "  mac_permissions action=request kind=screenRecording\n" +
        "Then enable the entry in System Settings > Privacy & Security > Screen Recording " +
        "(and restart the server once after granting).",
    );
  }
  if (!fs.existsSync(target)) {
    return failed(`screencapture produced no file. ${errText || `exit ${res.code}`}`);
  }
  let size = fs.statSync(target).size;
  if (size === 0) return failed(`screencapture wrote an empty file. ${errText}`.trim());

  const maxWidth = args.maxWidth ?? config.computerUse.screenshotMaxWidth ?? 1600;
  if (maxWidth > 0) {
    await run("/usr/bin/sips", ["-Z", String(Math.round(maxWidth)), target], { timeoutMs: 20_000 });
    size = fs.statSync(target).size;
  }
  if (format === "jpeg" && args.quality && args.quality > 0 && args.quality < 100) {
    await run("/usr/bin/sips", ["-s", "formatOptions", String(Math.round(args.quality)), target], {
      timeoutMs: 20_000,
    });
    size = fs.statSync(target).size;
  }

  const dims = await imageDimensions(target);
  const data = fs.readFileSync(target).toString("base64");
  const mime = format === "jpeg" ? "image/jpeg" : "image/png";
  const what = args.region
    ? `region ${args.region.width}x${args.region.height} at ${args.region.x},${args.region.y}`
    : args.windowId || args.window
      ? `window ${args.window ?? args.windowId}`
      : args.display
        ? `display ${args.display}`
        : "the main display";
  return good(
    `Captured ${what} -> ${target} (${dims ?? "?" } , ${formatBytes(size)})`,
    { data, mimeType: mime },
  );
}

async function imageDimensions(file: string): Promise<string | null> {
  const res = await run("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], { timeoutMs: 10_000 });
  const w = /pixelWidth:\s*(\d+)/.exec(res.out)?.[1];
  const h = /pixelHeight:\s*(\d+)/.exec(res.out)?.[1];
  return w && h ? `${w}x${h}px` : null;
}

// --- window_list (no permissions needed) -----------------------------------

export interface WindowListArgs {
  app?: string;
  includeOffscreen?: boolean;
  minSize?: number;
}

export interface WindowInfo {
  id: number;
  app: string;
  pid: number;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
  alpha: number;
  /** False for a window that exists but is not drawn: minimized, hidden, or on a
   *  different Space. It is the only Space signal CoreGraphics offers publicly. */
  onscreen: boolean;
}

const WINDOW_SCRIPT = `
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
ObjC.import('AppKit');
var ARGS = __ARGS__;
// onScreenOnly = 1, excludeDesktopElements = 16
var opts = ARGS.includeOffscreen ? 0 : (1 | (1 << 4));
var ref = $.CGWindowListCopyWindowInfo(opts, 0);
if (!ref) { JSON.stringify([]); } else {
  var a = ObjC.castRefToObject(ref);
  var out = [];
  for (var i = 0; i < a.count; i++) {
    var d = a.objectAtIndex(i);
    var b = ObjC.deepUnwrap(d.objectForKey('kCGWindowBounds')) || {};
    out.push({
      id: ObjC.unwrap(d.objectForKey('kCGWindowNumber')),
      app: String(ObjC.unwrap(d.objectForKey('kCGWindowOwnerName')) || ''),
      pid: ObjC.unwrap(d.objectForKey('kCGWindowOwnerPID')),
      title: String(ObjC.unwrap(d.objectForKey('kCGWindowName')) || ''),
      x: b.X, y: b.Y, width: b.Width, height: b.Height,
      layer: ObjC.unwrap(d.objectForKey('kCGWindowLayer')),
      alpha: ObjC.unwrap(d.objectForKey('kCGWindowAlpha')),
      onscreen: ObjC.unwrap(d.objectForKey('kCGWindowIsOnscreen')) ? true : false
    });
  }
  JSON.stringify(out);
}
`;

export async function windowList(args: WindowListArgs = {}): Promise<{ ok: boolean; message: string; ids: number[]; windows: WindowInfo[] }> {
  const script = WINDOW_SCRIPT.replace("__ARGS__", JSON.stringify({ includeOffscreen: !!args.includeOffscreen }));
  const res = await jxa(script, 20_000);
  if (!res.ok || !res.out.trim()) {
    return { ok: false, message: axError(`${res.err} ${res.out}`) ?? `window list failed: ${res.err || res.out}`, ids: [], windows: [] };
  }
  let windows: WindowInfo[] = [];
  try {
    windows = JSON.parse(res.out.trim()) as WindowInfo[];
  } catch {
    return { ok: false, message: `window list returned unparsable output`, ids: [], windows: [] };
  }
  windows = windows.filter((w) => {
    if (!w || typeof w.width !== "number") return false;
    if (w.width < (args.minSize ?? 40) || w.height < (args.minSize ?? 40)) return false;
    if (args.app) {
      const needle = args.app.toLowerCase();
      return `${w.app}`.toLowerCase().includes(needle);
    }
    return true;
  });
  windows.sort((a, b) => a.layer - b.layer || b.width * b.height - a.width * a.height);
  const lines = windows.map(
    (w) =>
      `  #${w.id}  ${w.app}${w.title ? ` - ${w.title}` : ""}  ${Math.round(w.width)}x${Math.round(w.height)} at ${Math.round(w.x)},${Math.round(w.y)}` +
      (w.layer ? `  [layer ${w.layer}]` : "") +
      (w.alpha < 1 ? `  [alpha ${w.alpha.toFixed(2)}]` : "") +
      (w.onscreen === false ? "  [not on this Space or minimized]" : ""),
  );
  const header = `${windows.length} window(s)${args.app ? ` for "${args.app}"` : ""}`;
  return {
    ok: true,
    message: windows.length ? `${header}:\n${lines.join("\n")}` : `${header}.`,
    ids: windows.map((w) => w.id),
    windows,
  };
}

// --- mouse (CGEvent) -------------------------------------------------------

export interface MouseArgs {
  action: "move" | "click" | "double_click" | "right_click" | "middle_click" | "drag" | "scroll";
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  amount?: number;
  unit?: "line" | "pixel";
  modifiers?: Array<"command" | "shift" | "option" | "control">;
}

const MOUSE_SCRIPT = `
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
var ARGS = __ARGS__;
var TAP = 0;                 // kCGHIDEventTap
var MOVED = 5, LEFT_DOWN = 1, LEFT_UP = 2, RIGHT_DOWN = 3, RIGHT_UP = 4;
var LEFT_DRAG = 6, RIGHT_DRAG = 7, OTHER_DOWN = 25, OTHER_UP = 26, OTHER_DRAG = 27;
var SCROLL = 22, CLICK_STATE = 1;
var FLAGS = { command: (1 << 20), shift: (1 << 17), control: (1 << 18), option: (1 << 19) };

function point(x, y) { return { x: x, y: y }; }
function flagValue(list) {
  var v = 0;
  for (var i = 0; list && i < list.length; i++) { v = v | (FLAGS[list[i]] || 0); }
  return v;
}
function post(type, x, y, button, clicks, mods) {
  var ev = $.CGEventCreateMouseEvent(null, type, point(x, y), button);
  if (clicks && clicks > 1) $.CGEventSetIntegerValueField(ev, CLICK_STATE, clicks);
  var f = flagValue(mods);
  if (f) $.CGEventSetFlags(ev, f);
  $.CGEventPost(TAP, ev);
}
function pos() {
  var ev = $.CGEventCreate(null);
  var p = $.CGEventGetLocation(ev);
  return { x: Math.round(p.x), y: Math.round(p.y) };
}
var a = ARGS.action, mods = ARGS.modifiers || [];
if (a === 'move') {
  post(MOVED, ARGS.x, ARGS.y, 0, 1, mods);
  JSON.stringify({ ok: true, where: pos() });
} else if (a === 'click' || a === 'double_click' || a === 'right_click' || a === 'middle_click') {
  var right = a === 'right_click', middle = a === 'middle_click';
  var button = right ? 1 : middle ? 2 : 0;
  var down = right ? RIGHT_DOWN : middle ? OTHER_DOWN : LEFT_DOWN;
  var up = right ? RIGHT_UP : middle ? OTHER_UP : LEFT_UP;
  var clicks = a === 'double_click' ? 2 : 1;
  post(MOVED, ARGS.x, ARGS.y, button, 1, mods);
  delay(0.02);
  for (var i = 1; i <= clicks; i++) {
    post(down, ARGS.x, ARGS.y, button, i, mods);
    delay(0.01);
    post(up, ARGS.x, ARGS.y, button, i, mods);
    if (i < clicks) delay(0.06);
  }
  JSON.stringify({ ok: true, where: pos() });
} else if (a === 'drag') {
  post(MOVED, ARGS.x, ARGS.y, 0, 1, mods);
  delay(0.05);
  post(LEFT_DOWN, ARGS.x, ARGS.y, 0, 1, mods);
  var steps = 12;
  for (var s = 1; s <= steps; s++) {
    var ix = Math.round(ARGS.x + (ARGS.toX - ARGS.x) * (s / steps));
    var iy = Math.round(ARGS.y + (ARGS.toY - ARGS.y) * (s / steps));
    post(LEFT_DRAG, ix, iy, 0, 1, mods);
    delay(0.012);
  }
  post(LEFT_UP, ARGS.toX, ARGS.toY, 0, 1, mods);
  JSON.stringify({ ok: true, where: pos() });
} else if (a === 'scroll') {
  var unit = ARGS.unit === 'pixel' ? 0 : 1;
  var amount = ARGS.amount || 0;
  var ev = $.CGEventCreateScrollWheelEvent(null, unit, 1, amount);
  if (ARGS.x !== undefined && ARGS.y !== undefined) $.CGEventSetLocation(ev, point(ARGS.x, ARGS.y));
  $.CGEventPost(TAP, ev);
  JSON.stringify({ ok: true, where: pos(), amount: amount });
} else {
  JSON.stringify({ ok: false, error: 'unknown action ' + a });
}
`;

export async function mouse(args: MouseArgs): Promise<Outcome> {
  if (args.action !== "scroll" && (typeof args.x !== "number" || typeof args.y !== "number")) {
    return failed(`action=${args.action} needs x and y`);
  }
  if (args.action === "drag" && (typeof args.toX !== "number" || typeof args.toY !== "number")) {
    return failed("action=drag needs toX and toY");
  }
  const script = MOUSE_SCRIPT.replace("__ARGS__", JSON.stringify(args));
  const res = await jxa(script, 20_000);
  const raw = `${res.err} ${res.out}`.trim();
  if (!res.ok) return failed(axError(raw) ?? `mouse event failed: ${raw}`);
  let parsed: { ok?: boolean; where?: { x: number; y: number }; error?: string; amount?: number } = {};
  try {
    parsed = JSON.parse(res.out.trim().split("\n").pop() ?? "{}");
  } catch {
    /* fall through to the generic message */
  }
  if (parsed.ok === false) return failed(parsed.error ?? "mouse action failed");
  const at = parsed.where ? `; pointer now at ${parsed.where.x},${parsed.where.y}` : "";
  if (args.action === "scroll") return good(`Scrolled ${parsed.amount ?? args.amount ?? 0} ${args.unit ?? "line"}(s)${at}.`);
  if (args.action === "drag") return good(`Dragged ${args.x},${args.y} -> ${args.toX},${args.toY}${at}.`);
  if (args.action === "move") return good(`Pointer moved to ${args.x},${args.y}${at}.`);
  return good(`Performed ${args.action} at ${args.x},${args.y}${at}.`);
}

// --- keyboard (System Events) ---------------------------------------------

const KEY_CODES: Record<string, number> = {
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  delete: 51,
  backspace: 51,
  forwarddelete: 117,
  escape: 53,
  esc: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};

export interface KeyboardArgs {
  action: "type" | "key" | "combo";
  text?: string;
  key?: string;
  keys?: string[];
  modifiers?: Array<"command" | "shift" | "option" | "control" | "fn">;
  app?: string;
  delayMs?: number;
}

function asString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export async function keyboard(args: KeyboardArgs, config: AppConfig = loadConfig()): Promise<Outcome> {
  const mods = (args.modifiers ?? []).filter((m) => m !== "fn");
  const using = mods.length ? ` using {${mods.map((m) => `${m} down`).join(", ")}}` : "";
  const lines: string[] = [];
  if (args.app) {
    lines.push(`tell application ${asString(args.app)} to activate`);
    lines.push("delay 0.15");
  }
  lines.push('tell application "System Events"');

  if (args.action === "type") {
    if (!args.text) return failed("action=type needs text");
    const chunk = 180;
    for (let i = 0; i < args.text.length; i += chunk) {
      lines.push(`  keystroke ${asString(args.text.slice(i, i + chunk))}`);
      if (args.delayMs ?? config.computerUse.typingDelayMs) lines.push("  delay 0.01");
    }
  } else if (args.action === "key") {
    const name = (args.key ?? "").toLowerCase();
    const code = KEY_CODES[name];
    if (code !== undefined) lines.push(`  key code ${code}${using}`);
    else if (name.length === 1) lines.push(`  keystroke ${asString(name)}${using}`);
    else return failed(`unknown key "${args.key}". Known: ${Object.keys(KEY_CODES).join(", ")}, or a single character.`);
  } else {
    const combo = args.keys?.length ? args.keys.join("+") : (args.key ?? "");
    if (!combo) return failed("action=combo needs keys such as [\"command\",\"shift\",\"t\"] or a key");
    const parts = combo.split("+").map((p) => p.trim()).filter(Boolean);
    const keyName = parts.pop() ?? "";
    const comboMods = parts.map((p) => (p === "cmd" ? "command" : p === "opt" ? "option" : p)) as string[];
    const comboUsing = comboMods.length ? ` using {${comboMods.map((m) => `${m} down`).join(", ")}}` : "";
    const code = KEY_CODES[keyName.toLowerCase()];
    if (code !== undefined) lines.push(`  key code ${code}${comboUsing}`);
    else if (keyName.length === 1) lines.push(`  keystroke ${asString(keyName)}${comboUsing}`);
    else return failed(`unknown key "${keyName}" in combo "${combo}"`);
  }
  lines.push("end tell");

  const res = await run("/usr/bin/osascript", ["-e", lines.join("\n")], { timeoutMs: 60_000 });
  if (!res.ok) return failed(axError(`${res.err} ${res.out}`) ?? `keystroke failed: ${res.err || res.out}`);
  const what =
    args.action === "type"
      ? `Typed ${args.text?.length ?? 0} character(s)`
      : args.action === "key"
        ? `Pressed ${args.key}`
        : `Sent ${args.keys?.join("+") ?? args.key}`;
  return good(`${what}${args.app ? ` to ${args.app}` : ""}.`);
}

// --- accessibility tree ----------------------------------------------------

const AX_PRELUDE = `
ObjC.import('ApplicationServices');
ObjC.import('Foundation');
var ARGS = __ARGS__;
var STOP = { apiDisabled: false, other: null };
function attr(el, name) {
  try {
    var ref = Ref();
    var err = $.AXUIElementCopyAttributeValue(el, $(name), ref);
    if (err !== 0) {
      if (err === -25211) STOP.apiDisabled = true;
      else if (!STOP.other) STOP.other = err;
      return null;
    }
    // AXUIElementCopyAttributeValue writes a CFTypeRef into a raw Ref. On
    // current JXA runtimes ref[0] is the pointer wrapper itself; unwrapping it
    // directly produces "[object Ref]". Cast the CF reference back to an ObjC
    // object first, then unwrap the actual value.
    var v = ObjC.castRefToObject(ref[0]);
    try { return ObjC.unwrap(v); } catch (e) { return v; }
  } catch (e) { return null; }
}
function childrenOf(el) {
  function arrayAttr(name) {
    try {
      var ref = Ref();
      if ($.AXUIElementCopyAttributeValue(el, $(name), ref) !== 0 || !ref[0]) return [];
      var arr = ObjC.castRefToObject(ref[0]);
      var n = 0;
      try { n = Number(arr.count); } catch (e) { n = 0; }
      var out = [];
      for (var i = 0; i < n; i++) out.push(arr.objectAtIndex(i));
      return out;
    } catch (e) { return []; }
  }
  var role = attr(el, 'AXRole');

  // Application roots are inconsistent across macOS apps. Finder exposes useful
  // AXChildren, while Pages Creator Studio currently exposes application proxy
  // children that point back into the application and recurse forever. Windows
  // and the menu bar are the stable top-level containers for an application.
  if (String(role || '') === 'AXApplication') {
    // Creator Studio 15.4 currently reports AXApplication proxies inside
    // AXWindows. They are not windows and recursively point back into the app.
    // Keep only actual non-application top-level objects.
    var appWindows = arrayAttr('AXWindows').filter(function (child) {
      return String(attr(child, 'AXRole') || '') !== 'AXApplication';
    });
    var top = appWindows.slice();
    try {
      var topMenuRef = Ref();
      if ($.AXUIElementCopyAttributeValue(el, $('AXMenuBar'), topMenuRef) === 0 && topMenuRef[0]) {
        top.push(ObjC.castRefToObject(topMenuRef[0]));
      }
    } catch (e) { /* no menu */ }
    if (top.length) return top;
  }

  var children = arrayAttr('AXChildren');
  if (children.length) return children;

  // Non-application containers can also expose AXWindows instead of children.
  var windows = arrayAttr('AXWindows');
  if (windows.length) return windows;

  // Menus are useful when an application has no ordinary window (or only a
  // hidden one) and also make menu-driven recovery discoverable.
  try {
    var menuRef = Ref();
    if ($.AXUIElementCopyAttributeValue(el, $('AXMenuBar'), menuRef) === 0 && menuRef[0]) {
      return [ObjC.castRefToObject(menuRef[0])];
    }
  } catch (e) { /* no menu bar */ }
  return [];
}
function pointOf(el, name) {
  try {
    var ref = Ref();
    if ($.AXUIElementCopyAttributeValue(el, $(name), ref) !== 0) return null;
    var v = ref[0];
    var out = Ref();
    var type = name === 'AXPosition' ? 1 : 2;   // kAXValueCGPointType / kAXValueCGSizeType
    if (!$.AXValueGetValue(v, type, out)) return null;
    return name === 'AXPosition' ? { x: out[0].x, y: out[0].y } : { width: out[0].width, height: out[0].height };
  } catch (e) { return null; }
}
function appElement() {
  if (ARGS.pid) return $.AXUIElementCreateApplication(ARGS.pid);
  var sys = $.AXUIElementCreateSystemWide();

  // A tree without an explicit pid is supposed to describe the frontmost app,
  // not merely whichever individual control happens to own keyboard focus.
  // AXFocusedApplication is also available in states where there is no focused
  // UI element (for example, immediately after launching a headless MCP client).
  var appRef = Ref();
  var appErr = $.AXUIElementCopyAttributeValue(sys, $('AXFocusedApplication'), appRef);
  if (appErr === 0 && appRef[0]) return appRef[0];

  // NSWorkspace is a reliable fallback when the system-wide AX object has no
  // focused application (which can happen for a headless client process).
  try {
    var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
    if (front) {
      var frontPid = Number(front.processIdentifier);
      if (frontPid > 0) return $.AXUIElementCreateApplication(frontPid);
    }
  } catch (e) { /* continue to focused-element fallback */ }

  // Older/odd accessibility states can fail AXFocusedApplication while still
  // exposing a focused element, so retain that as a compatibility fallback.
  var ref = Ref();
  var err = $.AXUIElementCopyAttributeValue(sys, $('AXFocusedUIElement'), ref);
  if (err === 0 && ref[0]) return ref[0];

  // -25211 is "API disabled"; other codes (-25204 cannotComplete, -25205
  // notImplemented) also show up when the process simply is not trusted yet.
  STOP.other = appErr !== 0 ? appErr : err;
  try {
    if (typeof $.AXIsProcessTrusted === 'function' && !$.AXIsProcessTrusted()) STOP.apiDisabled = true;
    else if (appErr === -25211 || err === -25211) STOP.apiDisabled = true;
  } catch (e) { /* keep the raw error */ }
  return null;
}
function describe(el) {
  var role = attr(el, 'AXRole') || '';
  var node = {
    role: String(role),
    subrole: attr(el, 'AXSubrole') ? String(attr(el, 'AXSubrole')) : undefined,
    title: attr(el, 'AXTitle') ? String(attr(el, 'AXTitle')) : undefined,
    description: (function () {
      var d = attr(el, 'AXDescription') || attr(el, 'AXHelp') || attr(el, 'AXRoleDescription');
      return d ? String(d) : undefined;
    })(),
    value: attr(el, 'AXValue') !== null && typeof attr(el, 'AXValue') !== 'object' ? String(attr(el, 'AXValue')) : undefined,
    identifier: attr(el, 'AXIdentifier') ? String(attr(el, 'AXIdentifier')) : undefined,
    enabled: attr(el, 'AXEnabled') === false ? false : undefined,
    focused: attr(el, 'AXFocused') === true ? true : undefined,
    position: pointOf(el, 'AXPosition') || undefined,
    size: pointOf(el, 'AXSize') || undefined,
    actions: (function () {
      try {
        var ref = Ref();
        if ($.AXUIElementCopyActionNames(el, ref) !== 0) return undefined;
        var namesObj = ObjC.castRefToObject(ref[0]);
        var names = ObjC.deepUnwrap(namesObj) || [];
        return names.length ? names.map(String) : undefined;
      } catch (e) { return undefined; }
    })()
  };
  for (var k in node) if (node[k] === undefined) delete node[k];
  return node;
}
`;

export interface UiTreeArgs {
  app?: string;
  pid?: number;
  depth?: number;
  maxNodes?: number;
  role?: string;
  windowTitle?: string;
}

const AX_TREE_BODY = `
var root = appElement();
if (!root) { JSON.stringify({ error: 'no focused element and no pid given', stopped: STOP }); } else {
  var maxDepth = ARGS.depth || 6, maxNodes = ARGS.maxNodes || 300;
  var count = 0, out = [];
  function walk(el, depth, pathStr) {
    if (count >= maxNodes || depth > maxDepth || STOP.apiDisabled) return;
    var node = describe(el);
    if (ARGS.role && String(node.role).toLowerCase().indexOf(ARGS.role.toLowerCase()) < 0) {
      // still descend: containers may not match
    } else {
      node.path = pathStr;
      node.depth = depth;
      out.push(node);
    }
    count++;
    var kids = childrenOf(el);
    for (var i = 0; i < kids.length && count < maxNodes; i++) walk(kids[i], depth + 1, pathStr ? pathStr + '.' + i : String(i));
  }
  walk(root, 0, '');
  JSON.stringify({ nodes: out, stopped: STOP });
}
`;

export interface UiNode {
  role?: string;
  subrole?: string;
  title?: string;
  description?: string;
  value?: string;
  identifier?: string;
  enabled?: boolean;
  focused?: boolean;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  actions?: string[];
  path?: string;
  depth?: number;
}

export interface UiNodesResult {
  ok: boolean;
  nodes: UiNode[];
  error?: string;
}

/** The structured tree itself, shared by ui_tree and the action planner. */
export async function uiNodes(args: UiTreeArgs): Promise<UiNodesResult> {
  let pid = args.pid ?? (args.app ? await pidForApp(args.app) : undefined);
  if (!pid && !args.app) {
    const front = await run(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", 'ObjC.import("AppKit"); Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier)'],
      { timeoutMs: 5_000 },
    );
    const candidate = Number(front.out.trim().split("\n").filter(Boolean).pop());
    if (Number.isFinite(candidate) && candidate > 0) pid = candidate;
  }
  if (args.app && !pid) {
    return { ok: false, nodes: [], error: `No running app named "${args.app}". Try app_control action=list.` };
  }
  const script =
    AX_PRELUDE.replace("__ARGS__", JSON.stringify({ pid, role: args.role, depth: args.depth, maxNodes: args.maxNodes })) +
    AX_TREE_BODY;
  const res = await jxa(script, 45_000);
  const raw = res.out.trim().split("\n").pop() ?? "";
  if (!res.ok && !raw) return { ok: false, nodes: [], error: axError(`${res.err} ${res.out}`) ?? `ui_tree failed: ${res.err}` };
  type Payload = { nodes?: UiNode[]; stopped?: { apiDisabled?: boolean; other?: number }; error?: string };
  let payload: Payload = {};
  try {
    payload = JSON.parse(raw) as Payload;
  } catch {
    return { ok: false, nodes: [], error: `ui_tree returned unparsable output: ${truncate(raw, 500)}` };
  }
  if (payload.stopped?.apiDisabled) return { ok: false, nodes: [], error: AX_HELP };
  if (payload.error) return { ok: false, nodes: [], error: payload.error };
  return { ok: true, nodes: payload.nodes ?? [] };
}

export async function uiTree(args: UiTreeArgs): Promise<Outcome> {
  const result = await uiNodes(args);
  if (!result.ok) return failed(result.error ?? "ui_tree failed");
  const nodes = result.nodes;
  const lines = nodes.map((n) => {
    const pad = "  ".repeat(Number(n.depth ?? 0));
    const bits = [String(n.role)];
    for (const key of ["subrole", "title", "description", "value", "identifier"] as const) {
      if (n[key] !== undefined && n[key] !== "") bits.push(`${key}=${JSON.stringify(String(n[key]).slice(0, 120))}`);
    }
    const pos = n.position as { x: number; y: number } | undefined;
    const size = n.size as { width: number; height: number } | undefined;
    if (pos && size) bits.push(`@${Math.round(pos.x)},${Math.round(pos.y)} ${Math.round(size.width)}x${Math.round(size.height)}`);
    if (n.enabled === false) bits.push("disabled");
    if (n.focused === true) bits.push("FOCUSED");
    const actions = n.actions as string[] | undefined;
    if (actions?.length) bits.push(`actions=${actions.join(",")}`);
    bits.push(`path=${n.path ?? ""}`);
    return `${pad}${bits.join("  ")}`;
  });
  return good(`${nodes.length} node(s)${args.app ? ` in ${args.app}` : ""}:\n${lines.join("\n")}`);
}

export async function pidForApp(app: string): Promise<number | undefined> {
  const res = await run("/usr/bin/pgrep", ["-f", `/${app}.app/Contents/MacOS/`], { timeoutMs: 5_000 });
  const first = res.out.trim().split("\n").filter(Boolean)[0];
  if (first) return Number(first);
  const res2 = await run("/bin/ps", ["-ax", "-o", "pid=,comm="], { timeoutMs: 10_000 });
  const line = res2.out
    .split("\n")
    .find((l) => l.toLowerCase().includes(`/${app.toLowerCase()}.app/contents/macos/`.replace(/ /g, " ")));
  if (!line) return undefined;
  return Number(line.trim().split(/\s+/)[0]);
}

export interface UiFindArgs {
  app?: string;
  pid?: number;
  text?: string;
  role?: string;
  maxNodes?: number;
  depth?: number;
}

const AX_FIND_BODY = `
var root = appElement();
if (!root) { JSON.stringify({ error: 'no focused element and no pid given', stopped: STOP }); } else {
  var maxDepth = ARGS.depth || 12, maxNodes = ARGS.maxNodes || 800;
  var needle = (ARGS.text || '').toLowerCase(), roleNeedle = (ARGS.role || '').toLowerCase();
  var count = 0, hits = [];
  function matches(node) {
    if (roleNeedle && String(node.role || '').toLowerCase().indexOf(roleNeedle) < 0) return false;
    if (!needle) return true;
    var fields = [node.title, node.description, node.value, node.identifier];
    for (var i = 0; i < fields.length; i++) {
      if (fields[i] && String(fields[i]).toLowerCase().indexOf(needle) >= 0) return true;
    }
    return false;
  }
  function walk(el, depth, pathStr) {
    if (count >= maxNodes || depth > maxDepth || STOP.apiDisabled || hits.length >= 40) return;
    var node = describe(el);
    node.path = pathStr;
    count++;
    if (matches(node)) hits.push(node);
    var kids = childrenOf(el);
    for (var i = 0; i < kids.length && count < maxNodes && hits.length < 40; i++) walk(kids[i], depth + 1, pathStr ? pathStr + '.' + i : String(i));
  }
  walk(root, 0, '');
  JSON.stringify({ hits: hits, scanned: count, stopped: STOP });
}
`;

export async function uiFind(args: UiFindArgs): Promise<Outcome> {
  const pid = args.pid ?? (args.app ? await pidForApp(args.app) : undefined);
  if (args.app && !pid) return failed(`No running app named "${args.app}".`);
  if (!args.text && !args.role) return failed("Give text to search for, a role, or both.");
  const script =
    AX_PRELUDE.replace(
      "__ARGS__",
      JSON.stringify({ pid, text: args.text, role: args.role, depth: args.depth, maxNodes: args.maxNodes }),
    ) + AX_FIND_BODY;
  const res = await jxa(script, 45_000);
  const raw = res.out.trim().split("\n").pop() ?? "";
  type Payload = { hits?: Array<Record<string, unknown>>; scanned?: number; stopped?: { apiDisabled?: boolean }; error?: string };
  let payload: Payload = {};
  try {
    payload = JSON.parse(raw) as Payload;
  } catch {
    return failed(axError(`${res.err} ${res.out}`) ?? `ui_find failed: ${truncate(raw, 500)}`);
  }
  if (payload.stopped?.apiDisabled) return failed(AX_HELP);
  if (payload.error) return failed(payload.error);
  const hits = payload.hits ?? [];
  if (!hits.length) return good(`No match for ${JSON.stringify(args.text ?? args.role)} after scanning ${payload.scanned ?? 0} node(s).`);
  const lines = hits.map((n, i) => {
    const pos = n.position as { x: number; y: number } | undefined;
    const size = n.size as { width: number; height: number } | undefined;
    const where = pos ? ` @${Math.round(pos.x)},${Math.round(pos.y)}` : "";
    const dims = size ? ` ${Math.round(size.width)}x${Math.round(size.height)}` : "";
    const label = n.title ?? n.description ?? n.value ?? "";
    return `  [${i}] ${n.role}${label ? ` "${String(label).slice(0, 100)}"` : ""}${where}${dims}  path=${n.path ?? ""}`;
  });
  return good(`${hits.length} match(es) in ${payload.scanned ?? 0} node(s):\n${lines.join("\n")}`);
}

export interface UiActArgs {
  app?: string;
  pid?: number;
  text?: string;
  role?: string;
  action?: "press" | "confirm" | "show_menu" | "focus" | "set_value" | "raise";
  value?: string;
  index?: number;
}

const AX_ACT_BODY = `
var root = appElement();
if (!root) { JSON.stringify({ error: 'no focused element and no pid given', stopped: STOP }); } else {
  var maxDepth = 14, maxNodes = 1200, count = 0;
  var needle = (ARGS.text || '').toLowerCase(), roleNeedle = (ARGS.role || '').toLowerCase();
  var hits = [];
  function matches(node) {
    if (roleNeedle && String(node.role || '').toLowerCase().indexOf(roleNeedle) < 0) return false;
    if (!needle) return true;
    var fields = [node.title, node.description, node.value, node.identifier];
    for (var i = 0; i < fields.length; i++) if (fields[i] && String(fields[i]).toLowerCase().indexOf(needle) >= 0) return true;
    return false;
  }
  function walk(el, depth, pathStr) {
    if (count >= maxNodes || depth > maxDepth || STOP.apiDisabled || hits.length >= 40) return;
    var node = describe(el);
    node.__el = el;
    node.path = pathStr;
    count++;
    if (matches(node)) hits.push(node);
    var kids = childrenOf(el);
    for (var i = 0; i < kids.length && count < maxNodes && hits.length < 40; i++) walk(kids[i], depth + 1, pathStr ? pathStr + '.' + i : String(i));
  }
  walk(root, 0, '');
  var target = hits[ARGS.index || 0];
  if (!target) {
    JSON.stringify({ error: 'no matching element', scanned: count });
  } else if (ARGS.action === 'set_value') {
    var err = $.AXUIElementSetAttributeValue(target.__el, $('AXValue'), $(ARGS.value === undefined ? '' : String(ARGS.value)));
    JSON.stringify(err === 0 ? { done: 'set_value', node: describe(target.__el), path: target.path } : { error: 'set value failed (AXError ' + err + ')' });
  } else {
    var actionName = ARGS.action === 'press' ? 'AXPress' : ARGS.action === 'confirm' ? 'AXConfirm' : ARGS.action === 'show_menu' ? 'AXShowMenu' : ARGS.action === 'raise' ? 'AXRaise' : 'AXFocusedUIElement';
    var ref = Ref();
    var err = $.AXUIElementPerformAction(target.__el, $(actionName));
    JSON.stringify(err === 0 ? { done: actionName, node: describe(target.__el), path: target.path } : { error: actionName + ' failed (AXError ' + err + ')' });
  }
}
`;

export async function uiAct(args: UiActArgs): Promise<Outcome> {
  const pid = args.pid ?? (args.app ? await pidForApp(args.app) : undefined);
  if (args.app && !pid) return failed(`No running app named "${args.app}".`);
  if (!args.text && !args.role) return failed("Give text (the label to match) and/or role so the right element is chosen.");
  const script = AX_PRELUDE.replace("__ARGS__", JSON.stringify({ pid, text: args.text, role: args.role, index: args.index ?? 0, action: args.action ?? "press", value: args.value })) + AX_ACT_BODY;
  const res = await jxa(script, 45_000);
  const raw = res.out.trim().split("\n").pop() ?? "";
  type Payload = { done?: string; node?: Record<string, unknown>; path?: string; error?: string; scanned?: number };
  let payload: Payload = {};
  try {
    payload = JSON.parse(raw) as Payload;
  } catch {
    return failed(axError(`${res.err} ${res.out}`) ?? `ui_act failed: ${truncate(raw, 500)}`);
  }
  if (payload.error) return failed(payload.error);
  const node = payload.node ?? {};
  const label = node.title ?? node.description ?? node.value ?? "";
  return good(`Did ${payload.done} on ${node.role}${label ? ` "${String(label).slice(0, 100)}"` : ""} (path ${payload.path}).`);
}

export interface UiActPathArgs {
  app?: string;
  pid?: number;
  path: string;
  action?: "press" | "confirm" | "show_menu" | "focus" | "set_value" | "raise";
  value?: string;
}

const AX_PATH_BODY = `
var root = appElement();
if (!root) { JSON.stringify({ error: 'no focused element and no pid given', stopped: STOP }); } else {
  var segs = String(ARGS.path === undefined ? '' : ARGS.path).split('.');
  var el = root;
  for (var i = 0; i < segs.length && el; i++) {
    var kids = childrenOf(el);
    var idx = Number(segs[i]);
    el = isNaN(idx) ? null : kids[idx];
  }
  if (!el) {
    JSON.stringify({ error: 'path no longer resolves - the element moved or was rebuilt' });
  } else if (ARGS.action === 'set_value') {
    var err = $.AXUIElementSetAttributeValue(el, $('AXValue'), $(ARGS.value === undefined ? '' : String(ARGS.value)));
    JSON.stringify(err === 0 ? { done: 'set_value', node: describe(el) } : { error: 'set value failed (AXError ' + err + ')' });
  } else {
    var actionName = ARGS.action === 'press' ? 'AXPress' : ARGS.action === 'confirm' ? 'AXConfirm' : ARGS.action === 'show_menu' ? 'AXShowMenu' : ARGS.action === 'raise' ? 'AXRaise' : 'AXFocusedUIElement';
    var err2 = $.AXUIElementPerformAction(el, $(actionName));
    JSON.stringify(err2 === 0 ? { done: actionName, node: describe(el) } : { error: actionName + ' failed (AXError ' + err2 + ')' });
  }
}
`;

/** Act on one exact node by its tree path - no re-matching, so the element that
 *  was inspected is the element that gets pressed, even in a busy window. */
export async function uiActPath(args: UiActPathArgs): Promise<Outcome> {
  const pid = args.pid ?? (args.app ? await pidForApp(args.app) : undefined);
  if (args.app && !pid) return failed(`No running app named "${args.app}".`);
  const script =
    AX_PRELUDE.replace("__ARGS__", JSON.stringify({ pid, path: args.path, action: args.action ?? "press", value: args.value })) +
    AX_PATH_BODY;
  const res = await jxa(script, 45_000);
  const raw = res.out.trim().split("\n").pop() ?? "";
  type Payload = { done?: string; node?: Record<string, unknown>; error?: string; stopped?: { apiDisabled?: boolean } };
  let payload: Payload = {};
  try {
    payload = JSON.parse(raw) as Payload;
  } catch {
    return failed(axError(`${res.err} ${res.out}`) ?? `ui_act_path failed: ${truncate(raw, 400)}`);
  }
  if (payload.stopped?.apiDisabled) return failed(AX_HELP);
  if (payload.error) return failed(payload.error);
  const node = payload.node ?? {};
  const label = node.title ?? node.description ?? node.value ?? "";
  return good(`Did ${payload.done} on ${node.role}${label ? ` "${String(label).slice(0, 90)}"` : ""} (path ${args.path}).`);
}

// --- window_control (System Events) ---------------------------------------

export interface WindowControlArgs {
  action: "focus" | "move" | "resize" | "minimize" | "restore" | "zoom" | "fullscreen" | "tile_left" | "tile_right";
  app: string;
  window?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export async function windowControl(args: WindowControlArgs): Promise<Outcome> {
  const win = Math.max(1, Math.round(args.window ?? 1));
  const app = asString(args.app);
  const lines: string[] = [
    'tell application "System Events"',
    `  if not (exists process ${app}) then error "no running process named ${args.app}"`,
    `  tell process ${app}`,
    `    set w to window ${win}`,
  ];
  if (args.action === "focus") {
    lines.push("    set frontmost to true", "    perform action \"AXRaise\" of w");
  } else if (args.action === "move") {
    if (typeof args.x !== "number" || typeof args.y !== "number") return failed("action=move needs x and y");
    lines.push(`    set position of w to {${Math.round(args.x)}, ${Math.round(args.y)}}`);
  } else if (args.action === "resize") {
    if (typeof args.width !== "number" || typeof args.height !== "number") return failed("action=resize needs width and height");
    lines.push(`    set size of w to {${Math.round(args.width)}, ${Math.round(args.height)}}`);
  } else if (args.action === "minimize") {
    lines.push('    set value of attribute "AXMinimized" of w to true');
  } else if (args.action === "restore") {
    lines.push('    set value of attribute "AXMinimized" of w to false', "    set frontmost to true");
  } else if (args.action === "zoom") {
    lines.push('    perform action "AXZoomWindow" of w');
  } else if (args.action === "fullscreen") {
    lines.push('    perform action "AXFullScreen" of w');
  } else if (args.action === "tile_left" || args.action === "tile_right") {
    const half = Math.round((await displayWidth()) / 2);
    lines.push(
      `    set sh to item 2 of (size of w)`,
      args.action === "tile_left" ? `    set position of w to {0, 0}` : `    set position of w to {${half}, 0}`,
      `    set size of w to {${half}, sh}`,
    );
  }
  lines.push("  end tell", "end tell");
  const res = await run("/usr/bin/osascript", ["-e", lines.join("\n")], { timeoutMs: 45_000 });
  if (!res.ok) return failed(axError(`${res.err} ${res.out}`) ?? `window_control failed: ${res.err || res.out}`);
  return good(`${args.action} done on window ${win} of ${args.app}.`);
}

/** Main display width in points, straight from CoreGraphics. */
async function displayWidth(): Promise<number> {
  const res = await jxa(
    `ObjC.import('CoreGraphics');var b=$.CGDisplayBounds($.CGMainDisplayID());JSON.stringify({w:b.size.width,h:b.size.height});`,
    10_000,
  );
  try {
    const parsed = JSON.parse(res.out.trim()) as { w?: number };
    if (parsed.w && Number.isFinite(parsed.w)) return parsed.w;
  } catch {
    /* fall through */
  }
  return 1440;
}

// --- app_control ----------------------------------------------------------

export interface AppControlArgs {
  action: "list" | "front" | "activate" | "launch" | "hide" | "show" | "quit" | "relaunch" | "force_quit";
  app?: string;
}

export async function appControl(args: AppControlArgs): Promise<Outcome> {
  if (args.action === "list" || args.action === "front") {
    const res = await jxa(
      `
ObjC.import('CoreGraphics');
var ref = $.CGWindowListCopyWindowInfo(1 | (1 << 4), 0);
var out = [];
if (ref) {
  var a = ObjC.castRefToObject(ref);
  var seen = {};
  for (var i = 0; i < a.count; i++) {
    var d = a.objectAtIndex(i);
    var name = String(ObjC.unwrap(d.objectForKey('kCGWindowOwnerName')) || '');
    if (!name || seen[name]) continue;
    seen[name] = true;
    out.push({ app: name, pid: ObjC.unwrap(d.objectForKey('kCGWindowOwnerPID')) });
  }
}
JSON.stringify(out);
`,
      20_000,
    );
    if (!res.ok) return failed(`app list failed: ${res.err || res.out}`);
    let apps: Array<{ app: string; pid: number }> = [];
    try {
      apps = JSON.parse(res.out.trim()) as Array<{ app: string; pid: number }>;
    } catch {
      return failed("app list returned unparsable output");
    }
    if (args.action === "front") {
      const front = await run("/usr/bin/osascript", ["-e", 'tell application "System Events" to get name of first process whose frontmost is true'], { timeoutMs: 15_000 });
      if (front.ok) return good(`Frontmost app: ${front.out.trim()}`);
      const first = apps[0]?.app;
      return first ? good(`Frontmost app (best guess): ${first}`) : failed(axError(front.err) ?? `could not read frontmost app: ${front.err}`);
    }
    apps.sort((a, b) => a.app.localeCompare(b.app));
    return good(`${apps.length} app(s) with a window right now:\n${apps.map((a) => `  - ${a.app} (pid ${a.pid})`).join("\n")}`);
  }

  if (!args.app) return failed(`action=${args.action} needs app`);
  const name = asString(args.app);

  if (args.action === "activate" || args.action === "launch") {
    const args_ = args.action === "activate" ? ["-a", args.app] : ["-gja", args.app];
    const res = await run("/usr/bin/open", args_, { timeoutMs: 30_000 });
    if (!res.ok) return failed(`could not ${args.action} ${args.app}: ${res.err || res.out}`);
    return good(`${args.action === "activate" ? "Activated" : "Launched"} ${args.app}.`);
  }

  if (args.action === "quit" || args.action === "relaunch") {
    const res = await run("/usr/bin/osascript", ["-e", `with timeout of 30 seconds\n  tell application ${name} to quit\nend timeout`], { timeoutMs: 45_000 });
    if (!res.ok) return failed(axError(`${res.err} ${res.out}`) ?? `quit failed: ${res.err || res.out}`);
    if (args.action === "quit") return good(`Asked ${args.app} to quit (anything unsaved stays open for the user to decide).`);
    await new Promise((r) => setTimeout(r, 1200));
    const again = await run("/usr/bin/open", ["-a", args.app], { timeoutMs: 30_000 });
    return again.ok ? good(`Relaunched ${args.app}.`) : failed(`quit worked but relaunch failed: ${again.err}`);
  }

  if (args.action === "force_quit") {
    const res = await run("/usr/bin/pkill", ["-9", "-f", `/${args.app}.app/Contents/MacOS/`], { timeoutMs: 10_000 });
    if (!res.ok && res.code !== 1) return failed(`force quit failed: ${res.err || res.out}`);
    return good(`Force quit ${args.app}. Unsaved work in it is gone.`);
  }

  // hide / show
  const res = await run(
    "/usr/bin/osascript",
    ["-e", `tell application "System Events"\n  if not (exists process ${name}) then error "no running process named ${args.app}"\n  set visible of process ${name} to ${args.action === "hide" ? "false" : "true"}\nend tell`],
    { timeoutMs: 30_000 },
  );
  if (!res.ok) return failed(axError(`${res.err} ${res.out}`) ?? `${args.action} failed: ${res.err || res.out}`);
  return good(`${args.action === "hide" ? "Hid" : "Showed"} ${args.app}.`);
}
