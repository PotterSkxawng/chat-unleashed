// The hybrid browser driver.
//
// Structured control first: a Chromium browser with a debugging port gives real
// element locators, DOM reads, console and network capture, and screenshots, so
// nothing has to be aimed at pixels. When no Chromium is available the driver
// falls back to Safari's AppleScript tab control for navigation and text, and says
// plainly what is missing. The browser it starts uses its own profile, so it never
// touches the profile the person is signed into; a page that needs their session
// has to be signed into once in this profile, and that is stated in the reply
// rather than worked around.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appHome, resolveUserPath } from "./config.js";
import { applicationCandidates, applicationExecutable, findApplicationByBundleId } from "./mac-paths.js";
import { runAppleScript } from "./applescript.js";
import { failed, good, run, truncate, type Outcome } from "./exec.js";
import { MiniSocket } from "./ws.js";

const BROWSER_APPS = [
  { bundleId: "com.google.Chrome", names: ["Google Chrome.app"] },
  { bundleId: "com.microsoft.edgemac", names: ["Microsoft Edge.app"] },
  { bundleId: "org.chromium.Chromium", names: ["Chromium.app"] },
  { bundleId: "com.brave.Browser", names: ["Brave Browser.app"] },
  { bundleId: "company.thebrowser.Browser", names: ["Arc.app"] },
  { bundleId: "com.vivaldi.Vivaldi", names: ["Vivaldi.app"] },
] as const;

export interface Locator {
  kind: "css" | "text" | "role" | "label" | "id" | "xpath";
  value: string;
}

/** Locators are written as kind=value, with a bare string treated as text. */
export function parseLocator(input: string): Locator {
  const trimmed = String(input ?? "").trim();
  const match = /^(css|text|role|label|id|xpath)\s*=\s*(.+)$/i.exec(trimmed);
  if (match) {
    const kind = match[1].toLowerCase() as Locator["kind"];
    return { kind, value: match[2].trim() };
  }
  if (trimmed.startsWith("#") || trimmed.startsWith(".") || trimmed.startsWith("[") || /^[a-z]+\s*[>+~]/.test(trimmed)) {
    return { kind: "css", value: trimmed };
  }
  return { kind: "text", value: trimmed };
}

function binary(): string | undefined {
  const override = process.env.LOCAL_AGENT_BROWSER_EXECUTABLE?.trim();
  if (override && fs.existsSync(override)) return path.resolve(override);
  for (const browser of BROWSER_APPS) {
    const app = findApplicationByBundleId(browser.bundleId, applicationCandidates(...browser.names));
    if (!app) continue;
    const executable = applicationExecutable(app);
    if (executable) return executable;
  }
  return undefined;
}

const PROFILE_DIR = () => path.join(appHome(), "browser-profile");

async function httpJson(port: number, resource: string, method = "GET"): Promise<unknown | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${resource}`, { method, signal: controller.signal });
    if (!res.ok) return undefined;
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export interface Target {
  id: string;
  title: string;
  url: string;
  type: string;
  webSocketDebuggerUrl?: string;
}

export interface BrowserHandle {
  port: number;
  started: boolean;
  binary: string;
  profile: string;
}

/** Attach to a Chromium debugging port, starting one in its own profile when the
 *  machine has a Chromium browser but nothing is listening. */
export async function ensureBrowser(preferredPort?: number): Promise<BrowserHandle> {
  const ports = preferredPort ? [preferredPort] : [9222, 9223, 9333];
  for (const port of ports) {
    const version = (await httpJson(port, "/json/version")) as { Browser?: string } | undefined;
    if (version?.Browser) return { port, started: false, binary: binary() ?? "", profile: "attached" };
  }
  const exe = binary();
  if (!exe) throw new Error("No Chromium browser found. Install Chrome or Edge, or call web with action=tabs and engine=safari for the AppleScript fallback.");
  const port = preferredPort ?? ports[0];
  const profile = PROFILE_DIR();
  fs.mkdirSync(profile, { recursive: true });
  const child = spawn(
    exe,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate",
      "about:blank",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const version = (await httpJson(port, "/json/version")) as { Browser?: string } | undefined;
    if (version?.Browser) return { port, started: true, binary: exe, profile };
  }
  throw new Error(`Started ${path.basename(exe)} but no debugging port answered on ${port} within 20s.`);
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** One DevTools session on one target. */
export class Cdp {
  private socket: MiniSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  readonly events: Array<{ method: string; params: Record<string, unknown>; at: number }> = [];

  private constructor(socket: MiniSocket) {
    this.socket = socket;
    socket.onMessage((text) => this.handle(text));
  }

  static async attach(wsUrl: string): Promise<Cdp> {
    const socket = await MiniSocket.connect(wsUrl, { timeoutMs: 8000 });
    const cdp = new Cdp(socket);
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");
    return cdp;
  }

  private handle(text: string): void {
    let message: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message ?? "protocol error"));
      else entry.resolve(message.result);
      return;
    }
    if (message.method) {
      this.events.push({ method: message.method, params: message.params ?? {}, at: Date.now() });
      if (this.events.length > 400) this.events.splice(0, this.events.length - 400);
    }
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs = 25_000): Promise<T> {
    const id = this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T = unknown>(expression: string, awaitPromise = true): Promise<T> {
    const result = await this.send<{ result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise, userGesture: true },
    );
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "evaluation failed");
    }
    return result.result?.value as T;
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // Already gone.
    }
  }
}

const LOCATE_JS = `
(function (kind, value, limit) {
  function visible(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    var s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || '1') > 0.05;
  }
  function nameOf(el) {
    return (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.value || '').replace(/\\s+/g, ' ').trim();
  }
  function roleOf(el) {
    var explicit = el.getAttribute('role');
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'input') return el.type || 'textbox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return tag;
  }
  var pool;
  if (kind === 'css') { try { pool = Array.prototype.slice.call(document.querySelectorAll(value)); } catch (e) { return { error: 'bad css selector: ' + value }; } }
  else if (kind === 'xpath') { try { var snap = document.evaluate(value, document, null, 7, null); pool = []; for (var i = 0; i < snap.snapshotLength; i++) pool.push(snap.snapshotItem(i)); } catch (e) { return { error: 'bad xpath: ' + value }; } }
  else if (kind === 'id') { var byId = document.getElementById(value); pool = byId ? [byId] : []; }
  else {
    pool = Array.prototype.slice.call(document.querySelectorAll('a,button,input,textarea,select,[role],[aria-label],[title],h1,h2,h3,h4,li,td,label,summary'));
    var needle = String(value).toLowerCase();
    pool = pool.filter(function (el) {
      if (kind === 'role') return roleOf(el).toLowerCase() === needle;
      if (kind === 'label') return String(el.getAttribute('aria-label') || '').toLowerCase().indexOf(needle) >= 0;
      return nameOf(el).toLowerCase().indexOf(needle) >= 0 || String(el.value || '').toLowerCase().indexOf(needle) >= 0;
    });
  }
  var out = [];
  for (var j = 0; j < pool.length && out.length < limit; j++) {
    var el = pool[j];
    if (!el || el.nodeType !== 1) continue;
    var shown = visible(el);
    var r = el.getBoundingClientRect();
    var marker = el.getAttribute('data-lap-id');
    if (!marker) { marker = 'lap-' + Math.random().toString(36).slice(2, 8); el.setAttribute('data-lap-id', marker); }
    out.push({
      id: marker,
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      name: nameOf(el).slice(0, 140),
      visible: shown,
      rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
      selector: 'css=[data-lap-id="' + marker + '"]',
      css: '[data-lap-id="' + marker + '"]'
    });
  }
  return { matches: out, total: pool.length };
})
`;

const OUTLINE_JS = `
(function (limit) {
  var nodes = Array.prototype.slice.call(document.querySelectorAll('a,button,input,textarea,select,[role],h1,h2,h3,h4,label,td,li,summary'));
  var out = [];
  for (var i = 0; i < nodes.length && out.length < limit; i++) {
    var el = nodes[i];
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    var s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none') continue;
    var marker = el.getAttribute('data-lap-id');
    if (!marker) { marker = 'lap-' + Math.random().toString(36).slice(2, 8); el.setAttribute('data-lap-id', marker); }
    var label = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim();
    out.push({ id: marker, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || el.tagName.toLowerCase(), name: label.slice(0, 120), type: el.type || '', y: Math.round(r.top) });
  }
  return { url: location.href, title: document.title, items: out, scrollY: Math.round(window.scrollY) };
})
`;

export interface WebStateSnapshot {
  url: string;
  title: string;
  textHash: string;
  nodes: number;
  at: string;
}

function stateFile(): string {
  return path.join(appHome(), "web-state.json");
}

/** The tab this session last worked with, so consecutive calls act on the same
 *  page instead of whichever tab the browser happens to list first. */
function tabFile(): string {
  return path.join(appHome(), "web-tab.json");
}

function rememberTab(id: string): void {
  try {
    fs.mkdirSync(path.dirname(tabFile()), { recursive: true });
    fs.writeFileSync(tabFile(), JSON.stringify({ id, at: new Date().toISOString() }), { mode: 0o600 });
  } catch {
    // Remembering the tab is a convenience, not a requirement.
  }
}

function rememberedTab(): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(tabFile(), "utf8")) as { id?: string };
    return parsed.id;
  } catch {
    return undefined;
  }
}

function readState(): Record<string, WebStateSnapshot> {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8")) as Record<string, WebStateSnapshot>;
  } catch {
    return {};
  }
}

function writeState(state: Record<string, WebStateSnapshot>): void {
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch {
    // State is a convenience, not a requirement.
  }
}

function hash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

/** Downloads land in the tool's own folder unless the caller names another one,
 *  so a page cannot scatter files across the person's Downloads directory. */
function downloadsDir(): string {
  return path.join(appHome(), "downloads");
}

function snapshotTextFile(url: string): string {
  const key = createHash("sha1").update(url).digest("hex").slice(0, 16);
  return path.join(appHome(), "web-snapshots", `${key}.txt`);
}

function readSnapshotText(url: string): string | undefined {
  try {
    return fs.readFileSync(snapshotTextFile(url), "utf8");
  } catch {
    return undefined;
  }
}

function writeSnapshotText(url: string, text: string): void {
  try {
    fs.mkdirSync(path.dirname(snapshotTextFile(url)), { recursive: true });
    fs.writeFileSync(snapshotTextFile(url), text, { mode: 0o600 });
  } catch {
    // A snapshot that cannot be stored is reported by the caller as a missing
    // baseline, which is honest and costs nothing.
  }
}

function textLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Multiset difference, so two identical lines removed are reported twice and
 *  reordering alone is not invented as a change. */
export function lineDiff(before: string, after: string): { added: string[]; removed: string[] } {
  const counts = (lines: string[]): Map<string, number> => {
    const map = new Map<string, number>();
    for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const older = counts(textLines(before));
  const newer = counts(textLines(after));
  const removed: string[] = [];
  const added: string[] = [];
  for (const [line, count] of older) for (let i = count - (newer.get(line) ?? 0); i > 0; i--) removed.push(line);
  for (const [line, count] of newer) for (let i = count - (older.get(line) ?? 0); i > 0; i--) added.push(line);
  return { added, removed };
}

interface DownloadFile {
  file: string;
  size: number;
  finished: boolean;
}

/** The newest regular file in a directory that was touched after `since`.
 *  Chromium writes a .crdownload companion while a transfer is still running. */
function newestDownload(dir: string, since: number): DownloadFile | undefined {
  let handle: fs.Dir;
  try {
    handle = fs.opendirSync(dir);
  } catch {
    return undefined;
  }
  let best: DownloadFile | undefined;
  let bestTime = -1;
  try {
    for (;;) {
      const entry = handle.readSync();
      if (!entry) break;
      if (!entry.isFile() || entry.name.startsWith(".") || entry.name.endsWith(".crdownload")) continue;
      const file = path.join(dir, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (stat.mtimeMs < since - 5_000) continue;
      const active = fs.existsSync(`${file}.crdownload`);
      if (stat.mtimeMs > bestTime) {
        best = { file, size: stat.size, finished: !active };
        bestTime = stat.mtimeMs;
      }
    }
  } finally {
    try { handle.closeSync(); } catch { /* already closed */ }
  }
  return best;
}

function recentDownloads(dir: string, limit = 20, scanCap = 100_000): { files: Array<{ name: string; size: number; at: string }>; scanned: number; capped: boolean } {
  let handle: fs.Dir;
  try {
    handle = fs.opendirSync(dir);
  } catch {
    return { files: [], scanned: 0, capped: false };
  }
  const files: Array<{ name: string; size: number; at: string }> = [];
  let scanned = 0;
  let capped = false;
  try {
    for (;;) {
      if (scanned >= scanCap) { capped = true; break; }
      const entry = handle.readSync();
      if (!entry) break;
      scanned++;
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      try {
        const stat = fs.statSync(path.join(dir, entry.name));
        files.push({ name: entry.name, size: stat.size, at: stat.mtime.toISOString() });
        files.sort((a, b) => b.at.localeCompare(a.at));
        if (files.length > limit) files.length = limit;
      } catch {
        /* file disappeared while listing */
      }
    }
  } finally {
    try { handle.closeSync(); } catch { /* already closed */ }
  }
  return { files, scanned, capped };
}

async function pageTarget(port: number, prefer?: string): Promise<Target> {
  const targets = ((await httpJson(port, "/json/list")) as Target[] | undefined) ?? [];
  const pages = targets.filter((target) => target.type === "page");
  if (prefer) {
    const requested = pages.find((target) => target.id === prefer || target.url.includes(prefer));
    if (requested) return requested;
  }
  const remembered = rememberedTab();
  const known = remembered ? pages.find((target) => target.id === remembered) : undefined;
  return known ?? pages[0] ?? { id: "", title: "", url: "", type: "none" };
}

export interface WebActionArgs {
  action:
    | "tabs"
    | "open"
    | "goto"
    | "dom"
    | "find"
    | "click"
    | "type"
    | "text"
    | "screenshot"
    | "console"
    | "network"
    | "wait"
    | "eval"
    | "snapshot"
    | "changes"
    | "download"
    | "downloads"
    | "close"
    | "status";
  url?: string;
  locator?: string;
  value?: string;
  text?: string;
  script?: string;
  timeoutSeconds?: number;
  path?: string;
  port?: number;
  tab?: string;
  limit?: number;
  engine?: "auto" | "chromium" | "safari";
}

async function withPage<T>(args: WebActionArgs, body: (cdp: Cdp, target: Target, handle: BrowserHandle) => Promise<T>): Promise<T> {
  const handle = await ensureBrowser(args.port);
  const target = await pageTarget(handle.port, args.tab);
  if (!target.webSocketDebuggerUrl) throw new Error("No page target with a debugging socket. Open a tab first with action=open.");
  const cdp = await Cdp.attach(target.webSocketDebuggerUrl);
  try {
    return await body(cdp, target, handle);
  } finally {
    cdp.close();
  }
}

async function waitForLoad(cdp: Cdp, seconds: number): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const state = await cdp.evaluate<string>("document.readyState");
    if (state === "complete") return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

const SAFARI_LIST = `
tell application "Safari"
  set out to ""
  repeat with w in windows
    repeat with t in tabs of w
      set out to out & (name of t) & "\\t" & (URL of t) & "\\n"
    end repeat
  end repeat
  return out
end tell
`;

/** Safari has no debugging port we can rely on, so it gets navigation and tab
 *  reading only. Its DOM needs "Allow JavaScript from Apple Events", which has to
 *  be turned on by hand; the reply says so instead of pretending it worked. */
async function safariAction(args: WebActionArgs): Promise<Outcome> {
  if (args.action === "tabs" || args.action === "status") {
    const res = await runAppleScript(SAFARI_LIST, 20_000);
    if (!res.ok) return failed(`Could not read Safari tabs: ${res.error}`);
    const lines = res.out.trim().split("\n").filter(Boolean);
    return good(`${lines.length} Safari tab(s):\n${lines.join("\n")}\n\nSafari exposes navigation and tab text through AppleScript. DOM control needs a Chromium browser; the driver starts one in its own profile on request.`);
  }
  if (args.action === "open" || args.action === "goto") {
    if (!args.url) return failed("This action needs url.");
    const script = `tell application "Safari"\n  activate\n  if (count of windows) = 0 then\n    make new document with properties {URL:${JSON.stringify(args.url)}}\n  else\n    set URL of current tab of front window to ${JSON.stringify(args.url)}\n  end if\nend tell`;
    const res = await runAppleScript(script, 30_000);
    return res.ok ? good(`Safari is showing ${args.url}.`) : failed(`Safari refused: ${res.error}`);
  }
  if (args.action === "text") {
    const script = `tell application "Safari" to do JavaScript "document.body.innerText" in current tab of front window`;
    const res = await runAppleScript(script, 25_000);
    if (!res.ok) {
      return failed(
        `Safari would not run JavaScript (${res.error ?? "refused"}). Turn on Develop menu > Allow JavaScript from Apple Events, or use a Chromium browser for structured control.`,
      );
    }
    return good(truncate(res.out.trim(), 4000));
  }
  return failed(`The Safari fallback supports tabs, status, open, goto and text. action=${args.action} needs Chromium.`);
}

export async function runWeb(args: WebActionArgs): Promise<Outcome> {
  const engine = args.engine ?? "auto";
  if (engine === "safari") return safariAction(args);

  try {
    switch (args.action) {
      case "status": {
        const handle = await ensureBrowser(args.port);
        const version = (await httpJson(handle.port, "/json/version")) as { Browser?: string; "webSocketDebuggerUrl"?: string } | undefined;
        const targets = ((await httpJson(handle.port, "/json/list")) as Target[] | undefined) ?? [];
        const pages = targets.filter((target) => target.type === "page");
        return good(
          [
            `browser: ${version?.Browser ?? "unknown"} on port ${handle.port}${handle.started ? " (started by this tool)" : " (already running)"}`,
            `profile: ${handle.profile}`,
            `tabs: ${pages.length}`,
            ...pages.slice(0, 10).map((page) => `  ${page.title || "(untitled)"} - ${page.url}`),
          ].join("\n"),
        );
      }
      case "tabs": {
        const handle = await ensureBrowser(args.port);
        const targets = ((await httpJson(handle.port, "/json/list")) as Target[] | undefined) ?? [];
        const pages = targets.filter((target) => target.type === "page");
        if (!pages.length) return good(`No page tabs are open in the debugging browser on port ${handle.port}.`);
        return good(pages.map((page) => `${page.title || "(untitled)"}\t${page.url}\t${page.id}`).join("\n"));
      }
      case "open": {
        if (!args.url) return failed("open needs a url.");
        const handle = await ensureBrowser(args.port);
        const created = (await httpJson(handle.port, `/json/new?${encodeURIComponent(args.url)}`, "PUT")) as Target | undefined;
        if (!created?.id) return failed("The browser refused to open a tab.");
        rememberTab(created.id);
        if (created.webSocketDebuggerUrl) {
          const cdp = await Cdp.attach(created.webSocketDebuggerUrl);
          try {
            await waitForLoad(cdp, args.timeoutSeconds ?? 20);
            const title = await cdp.evaluate<string>("document.title");
            return good(`Opened ${args.url} in a new tab.\ntitle: ${title}\ntab: ${created.id}`);
          } finally {
            cdp.close();
          }
        }
        return good(`Opened ${args.url} in a new tab (${created.id}).`);
      }
      case "goto": {
        if (!args.url) return failed("goto needs a url.");
        return await withPage(args, async (cdp, target) => {
          await cdp.send("Page.navigate", { url: args.url });
          const loaded = await waitForLoad(cdp, args.timeoutSeconds ?? 25);
          const info = await cdp.evaluate<{ url: string; title: string }>("({url: location.href, title: document.title})");
          return loaded
            ? good(`${target.url} -> ${info.url}\nreached ${info.title || "(untitled)"} in ${args.timeoutSeconds ?? 25}s or less.`)
            : failed(`Navigation to ${args.url} did not report a complete document in ${args.timeoutSeconds ?? 25}s. Current url: ${info.url}`);
        });
      }
      case "dom": {
        return await withPage(args, async (cdp) => {
          const outline = await cdp.evaluate<{ url: string; title: string; items: Array<Record<string, unknown>>; scrollY: number }>(
            `${OUTLINE_JS}(${Math.min(Math.max(args.limit ?? 120, 5), 500)})`,
          );
          const lines = outline.items.map(
            (item) => `${String(item.role).padEnd(12)} ${String(item.name || "(no name)").slice(0, 70).padEnd(70)} id=${item.id} y=${item.y}`,
          );
          return good(
            [`${outline.title || "(untitled)"} - ${outline.url}`, `${outline.items.length} interactive element(s), scrollY ${outline.scrollY}`, ...lines].join("\n"),
          );
        });
      }
      case "find": {
        if (!args.locator) return failed("find needs a locator.");
        const locator = parseLocator(args.locator);
        return await withPage(args, async (cdp) => {
          const found = await cdp.evaluate<{ matches?: Array<Record<string, unknown>>; total?: number; error?: string }>(
            `${LOCATE_JS}(${JSON.stringify(locator.kind)}, ${JSON.stringify(locator.value)}, ${Math.min(args.limit ?? 10, 50)})`,
          );
          if (found.error) return failed(found.error);
          const matches = found.matches ?? [];
          if (!matches.length) return failed(`Nothing matched ${locator.kind}=${locator.value}. ${found.total ?? 0} candidate element(s) were searched.`);
          return good(
            [
              `${matches.length} of ${found.total ?? matches.length} match(es) for ${locator.kind}=${locator.value}:`,
              ...matches.map((m) => `${String(m.role).padEnd(10)} ${String(m.name || "(no name)").slice(0, 70).padEnd(70)} ${m.selector} ${m.visible ? "" : "hidden"} rect=${JSON.stringify(m.rect)}`),
            ].join("\n"),
          );
        });
      }
      case "click": {
        if (!args.locator) return failed("click needs a locator.");
        const locator = parseLocator(args.locator);
        return await withPage(args, async (cdp) => {
          const before = await cdp.evaluate<{ url: string; text: string }>("({url: location.href, text: document.body ? document.body.innerText.slice(0, 20000) : ''})");
          const found = await cdp.evaluate<{ matches?: Array<Record<string, unknown>>; error?: string }>(
            `${LOCATE_JS}(${JSON.stringify(locator.kind)}, ${JSON.stringify(locator.value)}, 5)`,
          );
          if (found.error) return failed(found.error);
          const match = found.matches?.[0];
          if (!match) return failed(`Nothing matched ${locator.kind}=${locator.value}, so nothing was clicked.`);
          const clicked = await cdp.evaluate<{ ok?: boolean; error?: string }>(`(function(){
            var el = document.querySelector('${String(match.css ?? match.selector).replace(/'/g, "\\'")}');
            if (!el) return { error: 'the element disappeared before the click' };
            el.scrollIntoView({block: 'center'});
            try { el.focus({preventScroll: true}); } catch (e) {}
            el.click();
            return { ok: true };
          })()`);
          if (clicked.error) return failed(clicked.error);
          await new Promise((resolve) => setTimeout(resolve, 350));
          const after = await cdp.evaluate<{ url: string; text: string }>("({url: location.href, text: document.body ? document.body.innerText.slice(0, 20000) : ''})");
          const urlChanged = before.url !== after.url;
          const textChanged = hash(before.text) !== hash(after.text);
          const verified = urlChanged || textChanged;
          return verified
            ? good(`Clicked ${match.role} "${String(match.name ?? "").slice(0, 60)}".\nverified: ${urlChanged ? `navigation to ${after.url}` : "page text changed"}`)
            : failed(`Clicked ${match.role} "${String(match.name ?? "").slice(0, 60)}" but the url and the page text stayed the same. The click may have been swallowed by an overlay.`);
        });
      }
      case "type": {
        if (!args.locator) return failed("type needs a locator.");
        const value = args.value ?? args.text ?? "";
        const locator = parseLocator(args.locator);
        return await withPage(args, async (cdp) => {
          const found = await cdp.evaluate<{ matches?: Array<Record<string, unknown>>; error?: string }>(
            `${LOCATE_JS}(${JSON.stringify(locator.kind)}, ${JSON.stringify(locator.value)}, 3)`,
          );
          if (found.error) return failed(found.error);
          const match = found.matches?.[0];
          if (!match) return failed(`Nothing matched ${locator.kind}=${locator.value}, so nothing was typed.`);
          const result = await cdp.evaluate<{ value?: string; error?: string }>(`(function(){
            var el = document.querySelector('${String(match.css ?? match.selector).replace(/'/g, "\\'")}');
            if (!el) return { error: 'the field disappeared' };
            el.focus();
            var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            var setter = Object.getOwnPropertyDescriptor(proto, 'value');
            if (setter && setter.set) setter.set.call(el, ${JSON.stringify(value)}); else el.value = ${JSON.stringify(value)};
            el.dispatchEvent(new Event('input', {bubbles: true}));
            el.dispatchEvent(new Event('change', {bubbles: true}));
            el.blur();
            return { value: String(el.value).slice(0, 120) };
          })()`);
          if (result.error) return failed(result.error);
          const matches = String(result.value ?? "") === value;
          return matches
            ? good(`Typed into ${match.role} "${String(match.name ?? "").slice(0, 50)}". verified: the field now holds ${JSON.stringify(result.value)}`)
            : failed(`Typed but the field reports ${JSON.stringify(result.value)} instead of ${JSON.stringify(value)}.`);
        });
      }
      case "text": {
        return await withPage(args, async (cdp) => {
          const page = await cdp.evaluate<{ url: string; title: string; text: string; length: number }>(
            `({url: location.href, title: document.title, text: document.body ? document.body.innerText : '', length: document.body ? document.body.innerText.length : 0})`,
          );
          const wanted = Math.min(Math.max(args.limit ?? 6000, 200), 40_000);
          return good(
            `${page.title} - ${page.url}\n${page.length} characters${page.length > wanted ? `, showing the first ${wanted}` : ""}:\n${page.text.slice(0, wanted)}`,
          );
        });
      }
      case "screenshot": {
        return await withPage(args, async (cdp, target) => {
          const shot = await cdp.send<{ data?: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
          if (!shot.data) return failed("The browser returned no image data.");
          const file = args.path
            ? resolveUserPath(args.path)
            : path.join(os.tmpdir(), `lap-web-${Date.now()}.png`);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
          const small = `${file}.small.png`;
          let fingerprint = "";
          try {
            const res = await run("/usr/bin/sips", ["-Z", "80", file, "--out", small], { timeoutMs: 15_000 });
            const source = res.ok && fs.existsSync(small) ? small : file;
            fingerprint = hash(fs.readFileSync(source).toString("base64"));
          } catch {
            // Fingerprint is optional.
          }
          return good(`Screenshot of ${target.url} saved to ${file}${fingerprint ? `\nvisual fingerprint: ${fingerprint}` : ""}`);
        });
      }
      case "console": {
        return await withPage(args, async (cdp) => {
          const entries = cdp.events.filter((event) => event.method === "Runtime.consoleAPICalled" || event.method === "Log.entryAdded");
          const lines = entries.slice(-Math.min(args.limit ?? 40, 200)).map((event) => {
            if (event.method === "Log.entryAdded") {
              const entry = event.params.entry as { level?: string; text?: string } | undefined;
              return `[${entry?.level ?? "log"}] ${truncate(entry?.text ?? "", 300)}`;
            }
            const argsList = (event.params.args as Array<{ value?: unknown; description?: string }> | undefined) ?? [];
            const text = argsList.map((item) => (item.value !== undefined ? String(item.value) : item.description ?? "")).join(" ");
            return `[${String(event.params.type ?? "log")}] ${truncate(text, 300)}`;
          });
          if (!lines.length) return good("No console messages were captured in this session. Console capture starts when the tool connects, so reload the page to see early messages.");
          return good(`${lines.length} console message(s) (newest last):\n${lines.join("\n")}`);
        });
      }
      case "network": {
        return await withPage(args, async (cdp) => {
          const requests = cdp.events.filter((event) => event.method === "Network.requestWillBeSent");
          const responses = cdp.events.filter((event) => event.method === "Network.responseReceived");
          const failures = cdp.events.filter((event) => event.method === "Network.loadingFailed");
          const lines = requests.slice(-Math.min(args.limit ?? 30, 200)).map((event) => {
            const request = event.params.request as { method?: string; url?: string } | undefined;
            return `${request?.method ?? "GET"} ${truncate(request?.url ?? "", 160)}`;
          });
          const bad = failures.map((event) => `failed: ${truncate(String((event.params as { errorText?: string }).errorText ?? "unknown"), 120)}`);
          if (!lines.length) return good("No requests were captured in this session. Network capture starts when the tool connects, so reload the page to see earlier requests.");
          return good(
            [`${requests.length} request(s), ${responses.length} response(s), ${failures.length} failure(s) since the tool connected:`, ...lines, ...bad].join("\n"),
          );
        });
      }
      case "wait": {
        const locator = args.locator ? parseLocator(args.locator) : undefined;
        const seconds = Math.min(Math.max(args.timeoutSeconds ?? 15, 1), 120);
        return await withPage(args, async (cdp) => {
          const deadline = Date.now() + seconds * 1000;
          const startedAt = Date.now();
          let last = "";
          while (Date.now() < deadline) {
            if (locator) {
              const probe = await cdp.evaluate<{ matches?: unknown[]; total?: number; error?: string }>(
                `${LOCATE_JS}(${JSON.stringify(locator.kind)}, ${JSON.stringify(locator.value)}, 1)`,
              );
              if (probe.error) return failed(probe.error);
              if ((probe.matches?.length ?? 0) > 0) {
                return good(`${locator.kind}=${locator.value} appeared after ${Math.round((Date.now() - startedAt) / 100) / 10}s.`);
              }
              last = `no match yet (${probe.total ?? 0} candidates)`;
            } else if (args.text) {
              const probe = await cdp.evaluate<{ text: string }>("({text: document.body ? document.body.innerText : ''})");
              if (String(probe.text ?? "").includes(args.text)) return good(`"${args.text}" is on the page.`);
              last = "text not found yet";
            }
            await new Promise((resolve) => setTimeout(resolve, 400));
          }
          return failed(`Waited ${seconds}s and the condition never held. Last state: ${last || "unchanged"}.`);
        });
      }
      case "eval": {
        if (!args.script) return failed("eval needs a script.");
        return await withPage(args, async (cdp) => {
          const value = await cdp.evaluate<unknown>(args.script ?? "");
          return good(truncate(typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value), 6000));
        });
      }
      case "snapshot": {
        return await withPage(args, async (cdp) => {
          const page = await cdp.evaluate<{ url: string; title: string; text: string; nodes: number }>(
            `({url: location.href, title: document.title, text: document.body ? document.body.innerText : '', nodes: document.querySelectorAll('a,button,input,textarea,select,[role]').length})`,
          );
          const snapshot: WebStateSnapshot = {
            url: page.url,
            title: page.title,
            textHash: hash(page.text),
            nodes: page.nodes,
            at: new Date().toISOString(),
          };
          writeSnapshotText(page.url, page.text);
          const state = readState();
          const previous = state[page.url];
          state[page.url] = snapshot;
          writeState(state);
          const lines = [`${snapshot.title} - ${snapshot.url}`, `text hash ${snapshot.textHash}, ${snapshot.nodes} interactive element(s)`];
          if (previous) {
            lines.push(
              previous.textHash === snapshot.textHash && previous.nodes === snapshot.nodes
                ? "unchanged since the previous snapshot"
                : `changed since ${previous.at}: text ${previous.textHash === snapshot.textHash ? "same" : "different"}, elements ${previous.nodes} -> ${snapshot.nodes}`,
            );
          } else {
            lines.push("first snapshot for this url, so there is nothing to compare against yet");
          }
          return good(lines.join("\n"));
        });
      }
      case "changes": {
        return await withPage(args, async (cdp) => {
          const page = await cdp.evaluate<{ url: string; title: string; text: string }>(
            "({url: location.href, title: document.title, text: document.body ? document.body.innerText : ''})",
          );
          const previous = readSnapshotText(page.url);
          if (previous === undefined) {
            writeSnapshotText(page.url, page.text);
            return good(`${page.title || page.url}\nno earlier snapshot for this url, so it was stored now (${textLines(page.text).length} text line(s)). Call changes again after the page moves to see what changed.`);
          }
          if (previous === page.text) {
            return good(`${page.title || page.url}\nthe page text is identical to the stored snapshot, so nothing changed.`);
          }
          const { added, removed } = lineDiff(previous, page.text);
          writeSnapshotText(page.url, page.text);
          const lines = [
            `${page.title || page.url}`,
            `changed since the stored snapshot: ${added.length} line(s) added, ${removed.length} removed`,
          ];
          for (const line of added.slice(0, 15)) lines.push(`  + ${line.slice(0, 160)}`);
          if (added.length > 15) lines.push(`  + ${added.length - 15} more added line(s)`);
          for (const line of removed.slice(0, 15)) lines.push(`  - ${line.slice(0, 160)}`);
          if (removed.length > 15) lines.push(`  - ${removed.length - 15} more removed line(s)`);
          lines.push("the new text is now the baseline for the next comparison");
          return good(lines.join("\n"));
        });
      }
      case "downloads": {
        const dir = args.path ? resolveUserPath(args.path) : downloadsDir();
        const recent = recentDownloads(dir, 20);
        if (!recent.files.length) return good(`No downloads yet in ${dir}.`);
        const header = recent.capped
          ? `20 newest file(s) found while scanning the first ${recent.scanned}+ entries in ${dir}:`
          : `${recent.files.length} newest file(s) in ${dir} (scanned ${recent.scanned} entries):`;
        return good([header, ...recent.files.map((file) => `  ${file.name} ${file.size} bytes ${file.at}`)].join("\n"));
      }
      case "download": {
        const dir = args.path ? resolveUserPath(args.path) : downloadsDir();
        try {
          fs.mkdirSync(dir, { recursive: true });
        } catch (error) {
          return failed(`Could not create ${dir}: ${(error as Error).message}`);
        }
        const started = Date.now();
        return await withPage(args, async (cdp) => {
          try {
            await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir, eventsEnabled: true });
          } catch {
            await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: dir });
          }
          let clicked = "no locator was given, so nothing was clicked";
          if (args.locator) {
            const locator = parseLocator(args.locator);
            const found = await cdp.evaluate<{ matches?: Array<Record<string, unknown>>; error?: string }>(
              `${LOCATE_JS}(${JSON.stringify(locator.kind)}, ${JSON.stringify(locator.value)}, 5)`,
            );
            if (found.error) return failed(found.error);
            const match = found.matches?.[0];
            if (!match) return failed(`Nothing matched ${locator.kind}=${locator.value}, so no download was started.`);
            const selector = String(match.css ?? match.selector ?? "").replace(/'/g, "\\'");
            const clickedResult = await cdp.evaluate<{ ok?: boolean; error?: string }>(`(function(){
              var el = document.querySelector('${selector}');
              if (!el) return { error: 'the element disappeared before the click' };
              el.scrollIntoView({block: 'center'});
              el.click();
              return { ok: true };
            })()`);
            if (clickedResult.error) return failed(clickedResult.error);
            clicked = `clicked ${String(match.role ?? "element")} "${String(match.name ?? "").slice(0, 60)}"`;
          }
          const waitSeconds = Math.min(Math.max(args.timeoutSeconds ?? 30, 2), 300);
          const deadline = Date.now() + waitSeconds * 1000;
          let seen: DownloadFile | undefined;
          while (Date.now() < deadline) {
            seen = newestDownload(dir, started);
            if (seen?.finished) break;
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
          if (!seen) {
            return failed(`No file appeared in ${dir} within ${waitSeconds}s after ${clicked}.`);
          }
          if (!seen.finished) {
            return failed(`A download started (${path.basename(seen.file)}, ${seen.size} bytes so far) but had not finished after ${waitSeconds}s. It is still writing to ${dir}.`);
          }
          return good(`Downloaded ${path.basename(seen.file)} (${seen.size} bytes) to ${dir}.\n${clicked}.`);
        });
      }
      case "close": {
        if (!args.tab) return failed("close needs tab (an id from action=tabs).");
        const handle = await ensureBrowser(args.port);
        const res = await fetch(`http://127.0.0.1:${handle.port}/json/close/${args.tab}`);
        return res.ok ? good(`Closed tab ${args.tab}.`) : failed(`The browser refused to close ${args.tab} (HTTP ${res.status}).`);
      }
      default:
        return failed(`Unknown action ${String(args.action)}.`);
    }
  } catch (error) {
    const message = (error as Error).message;
    if (/ECONNREFUSED|fetch failed|no page target/i.test(message)) {
      const safari = await safariAction({ ...args, engine: "safari" });
      if (safari.ok) return good(`${safari.message}\n\n(Chromium control was unavailable: ${message})`);
    }
    return failed(`Browser driver: ${message}`);
  }
}
