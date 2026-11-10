// Shared semantic Accessibility control for Pages, Numbers and Keynote Creator Studio.
//
// The iWork AppleScript dictionaries expose rich object models, but Creator
// Studio 15.4 currently has gaps (notably Pages' document collection and many
// inspector-only layout controls). This layer never relies on screen
// coordinates: it resolves real AX controls by title/description/role, scopes
// them to the requested document window, and acts on the exact inspected path.
import {
  appControl,
  pidForApp,
  uiActPath,
  uiNodes,
  type UiNode,
} from "./computer.js";
import { failed, good, type Outcome } from "./exec.js";

export type IWorkUiApp = "pages" | "numbers" | "keynote";

export const IWORK_UI_APPS: Record<IWorkUiApp, string> = {
  pages: "Pages Creator Studio",
  numbers: "Numbers Creator Studio",
  keynote: "Keynote Creator Studio",
};

export interface SemanticTarget {
  role?: string;
  title?: string;
  description?: string;
  identifier?: string;
  value?: string;
  text?: string;
  ancestorText?: string;
  windowTitle?: string;
  index?: number;
  allowDisabled?: boolean;
}

export interface SemanticActionOptions extends SemanticTarget {
  app: IWorkUiApp;
  dryRun?: boolean;
  depth?: number;
  maxNodes?: number;
}

export interface SemanticSetOptions extends SemanticActionOptions {
  newValue: string;
}

export interface SemanticChooseOptions extends SemanticActionOptions {
  option: string;
}

function norm(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function label(node: UiNode): string {
  return [node.title, node.description, node.value, node.identifier].filter(Boolean).join(" | ");
}

function pathParents(pathStr: string): string[] {
  if (!pathStr) return [];
  const parts = pathStr.split(".");
  const out: string[] = [];
  while (parts.length > 1) {
    parts.pop();
    out.push(parts.join("."));
  }
  return out;
}

function selectedWindowPrefix(nodes: UiNode[], wanted?: string): string | undefined {
  const windows = nodes.filter((n) => n.role === "AXWindow" && n.path !== undefined);
  if (!windows.length) return undefined;
  if (wanted) {
    const q = norm(wanted);
    const exact = windows.find((n) => norm(n.title) === q);
    if (exact?.path !== undefined) return exact.path;
    const contains = windows.find((n) => norm(n.title).includes(q));
    if (contains?.path !== undefined) return contains.path;
  }
  const focused = nodes.find((n) => n.focused && n.path);
  if (focused?.path) {
    const top = focused.path.split(".")[0];
    if (windows.some((w) => w.path === top)) return top;
  }
  return windows[0]?.path;
}

function withinPrefix(node: UiNode, prefix?: string): boolean {
  if (prefix === undefined) return true;
  const p = node.path ?? "";
  return p === prefix || p.startsWith(prefix + ".");
}

function hasAncestor(nodesByPath: Map<string, UiNode>, node: UiNode, wanted?: string): boolean {
  if (!wanted) return true;
  const q = norm(wanted);
  for (const parentPath of pathParents(node.path ?? "")) {
    const parent = nodesByPath.get(parentPath);
    if (!parent) continue;
    if (norm(label(parent)).includes(q)) return true;
  }
  return false;
}

function matches(node: UiNode, target: SemanticTarget): boolean {
  if (target.role && norm(node.role) !== norm(target.role)) return false;
  if (target.title !== undefined && norm(node.title) !== norm(target.title)) return false;
  if (target.description !== undefined && norm(node.description) !== norm(target.description)) return false;
  if (target.identifier !== undefined && norm(node.identifier) !== norm(target.identifier)) return false;
  if (target.value !== undefined && norm(node.value) !== norm(target.value)) return false;
  if (target.text) {
    const q = norm(target.text);
    if (!norm(label(node)).includes(q)) return false;
  }
  return true;
}

async function scan(app: IWorkUiApp, depth = 12, maxNodes = 2600): Promise<{ ok: boolean; nodes: UiNode[]; error?: string }> {
  const name = IWORK_UI_APPS[app];
  const pid = await pidForApp(name);
  if (!pid) return { ok: false, nodes: [], error: `${name} is not running.` };
  return uiNodes({ app: name, depth: Math.min(16, Math.max(1, depth)), maxNodes: Math.min(4000, Math.max(100, maxNodes)) });
}

async function resolveNode(
  options: SemanticActionOptions,
  global = false,
): Promise<{ ok: boolean; node?: UiNode; nodes?: UiNode[]; message?: string }> {
  const found = await scan(options.app, options.depth, options.maxNodes);
  if (!found.ok) return { ok: false, message: found.error ?? "could not read the Accessibility tree" };
  const byPath = new Map(found.nodes.filter((n) => n.path !== undefined).map((n) => [String(n.path), n]));
  const prefix = global ? undefined : selectedWindowPrefix(found.nodes, options.windowTitle);
  let candidates = found.nodes.filter((node) => {
    if (!global && !withinPrefix(node, prefix)) return false;
    if (!matches(node, options)) return false;
    if (!hasAncestor(byPath, node, options.ancestorText)) return false;
    return true;
  });
  const enabled = candidates.filter((n) => n.enabled !== false);
  if (!options.allowDisabled && enabled.length) candidates = enabled;
  if (!candidates.length) {
    const windowNote = options.windowTitle ? ` in window ${JSON.stringify(options.windowTitle)}` : "";
    return {
      ok: false,
      nodes: found.nodes,
      message: `No Accessibility control matched ${JSON.stringify(options.title ?? options.description ?? options.text ?? options.identifier ?? options.role)}${windowNote}.`,
    };
  }
  const index = Math.max(0, Math.round(options.index ?? 0));
  const node = candidates[index];
  if (!node) return { ok: false, nodes: found.nodes, message: `Only ${candidates.length} matching control(s); index ${index} is out of range.` };
  if (node.enabled === false && !options.allowDisabled) {
    return { ok: false, nodes: found.nodes, message: `Matched ${node.role} ${JSON.stringify(label(node))}, but it is disabled in the current selection/state.` };
  }
  return { ok: true, node, nodes: found.nodes };
}

export async function semanticInspect(options: SemanticActionOptions): Promise<Outcome> {
  const r = await resolveNode(options, options.role === "AXMenuItem");
  if (!r.ok || !r.node) return failed(r.message ?? "control not found");
  const n = r.node;
  return good(
    `${IWORK_UI_APPS[options.app]} control: ${n.role ?? "?"} ${JSON.stringify(label(n))} path=${n.path ?? "?"}` +
      `${n.enabled === false ? " [disabled]" : ""}${n.focused ? " [focused]" : ""}`,
  );
}

export async function semanticPress(options: SemanticActionOptions): Promise<Outcome> {
  const global = options.role === "AXMenuItem";
  const r = await resolveNode(options, global);
  if (!r.ok || !r.node?.path) return failed(r.message ?? "control not found");
  if (options.dryRun) {
    return good(`Would press ${r.node.role} ${JSON.stringify(label(r.node))} in ${IWORK_UI_APPS[options.app]} (path ${r.node.path}).`);
  }
  const appName = IWORK_UI_APPS[options.app];
  await appControl({ action: "activate", app: appName });
  const acted = await uiActPath({ app: appName, path: r.node.path, action: "press" });
  if (!acted.ok) return acted;
  return good(`${acted.message}`);
}

export async function semanticSet(options: SemanticSetOptions): Promise<Outcome> {
  const r = await resolveNode(options, false);
  if (!r.ok || !r.node?.path) return failed(r.message ?? "control not found");
  if (options.dryRun) {
    return good(
      `Would set ${r.node.role} ${JSON.stringify(label(r.node))} from ${JSON.stringify(r.node.value ?? "")} to ${JSON.stringify(options.newValue)} in ${IWORK_UI_APPS[options.app]}.`,
    );
  }
  const appName = IWORK_UI_APPS[options.app];
  await appControl({ action: "activate", app: appName });
  const acted = await uiActPath({ app: appName, path: r.node.path, action: "set_value", value: options.newValue });
  if (!acted.ok) return acted;
  if (r.node.actions?.includes("AXConfirm")) {
    await uiActPath({ app: appName, path: r.node.path, action: "confirm" });
  }
  await new Promise((resolve) => setTimeout(resolve, 120));
  const after = await resolveNode(options, false);
  const got = after.node?.value;
  return good(
    `${acted.message}${got !== undefined ? ` Current value: ${JSON.stringify(got)}.` : ""}`,
  );
}

export async function semanticToggle(
  options: SemanticActionOptions & { desired: boolean },
): Promise<Outcome> {
  const r = await resolveNode(options, false);
  if (!r.ok || !r.node?.path) return failed(r.message ?? "control not found");
  const on = ["1", "true", "yes", "on"].includes(norm(r.node.value));
  if (on === options.desired) return good(`${label(r.node)} is already ${options.desired ? "on" : "off"}.`);
  if (options.dryRun) {
    return good(`Would turn ${JSON.stringify(label(r.node))} ${options.desired ? "on" : "off"} in ${IWORK_UI_APPS[options.app]}.`);
  }
  const appName = IWORK_UI_APPS[options.app];
  await appControl({ action: "activate", app: appName });
  const acted = await uiActPath({ app: appName, path: r.node.path, action: "press" });
  if (!acted.ok) return acted;
  await new Promise((resolve) => setTimeout(resolve, 120));
  const after = await resolveNode(options, false);
  const now = after.node ? ["1", "true", "yes", "on"].includes(norm(after.node.value)) : undefined;
  if (now !== undefined && now !== options.desired) {
    return failed(`Pressed ${label(r.node)}, but its AX value is still ${JSON.stringify(after.node?.value)}.`);
  }
  return good(`Set ${label(r.node)} ${options.desired ? "on" : "off"}.`);
}

export async function semanticChoose(options: SemanticChooseOptions): Promise<Outcome> {
  const r = await resolveNode(options, false);
  if (!r.ok || !r.node?.path) return failed(r.message ?? "popup not found");
  if (options.dryRun) {
    return good(
      `Would choose ${JSON.stringify(options.option)} from ${r.node.role} ${JSON.stringify(label(r.node))} in ${IWORK_UI_APPS[options.app]}.`,
    );
  }
  const appName = IWORK_UI_APPS[options.app];
  await appControl({ action: "activate", app: appName });
  let opened = await uiActPath({ app: appName, path: r.node.path, action: "show_menu" });
  if (!opened.ok) opened = await uiActPath({ app: appName, path: r.node.path, action: "press" });
  if (!opened.ok) return opened;
  await new Promise((resolve) => setTimeout(resolve, 180));
  const option = await resolveNode(
    {
      app: options.app,
      role: "AXMenuItem",
      title: options.option,
      allowDisabled: false,
      depth: options.depth ?? 14,
      maxNodes: options.maxNodes ?? 3800,
    },
    true,
  );
  if (!option.ok || !option.node?.path) return failed(option.message ?? `option ${options.option} not found`);
  const picked = await uiActPath({ app: appName, path: option.node.path, action: "press" });
  if (!picked.ok) return picked;
  await new Promise((resolve) => setTimeout(resolve, 150));
  const after = await resolveNode(options, false);
  return good(
    `Chose ${JSON.stringify(options.option)} from ${label(r.node)}.` +
      `${after.node?.value !== undefined ? ` Current value: ${JSON.stringify(after.node.value)}.` : ""}`,
  );
}

export async function semanticReadMany(
  app: IWorkUiApp,
  targets: Array<{ name: string; target: SemanticTarget }>,
  options: { windowTitle?: string; depth?: number; maxNodes?: number } = {},
): Promise<Outcome> {
  const found = await scan(app, options.depth ?? 12, options.maxNodes ?? 3000);
  if (!found.ok) return failed(found.error ?? "could not read app");
  const prefix = selectedWindowPrefix(found.nodes, options.windowTitle);
  const byPath = new Map(found.nodes.filter((n) => n.path !== undefined).map((n) => [String(n.path), n]));
  const lines: string[] = [];
  for (const item of targets) {
    const candidates = found.nodes.filter((node) => {
      if (!withinPrefix(node, prefix)) return false;
      if (!matches(node, item.target)) return false;
      if (!hasAncestor(byPath, node, item.target.ancestorText)) return false;
      return true;
    });
    const node = candidates[0];
    lines.push(`${item.name}: ${node ? JSON.stringify(node.value ?? node.title ?? node.description ?? "") : "(not exposed in current inspector state)"}`);
  }
  return good(lines.join("\n"));
}

/** Switches an inspector segment only when it is not already selected. */
export async function ensureInspectorSegment(
  app: IWorkUiApp,
  description: string,
  windowTitle?: string,
  dryRun = false,
): Promise<Outcome> {
  const r = await resolveNode({ app, role: "AXRadioButton", description, windowTitle, depth: 12, maxNodes: 3000 }, false);
  if (!r.ok || !r.node?.path) return failed(r.message ?? `inspector segment ${description} not found`);
  if (norm(r.node.value) === "1") return good(`${description} inspector is already selected.`);
  if (dryRun) return good(`Would switch to the ${description} inspector.`);
  const appName = IWORK_UI_APPS[app];
  await appControl({ action: "activate", app: appName });
  return uiActPath({ app: appName, path: r.node.path, action: "press" });
}

export type ArrangeAction =
  | "bring_forward"
  | "bring_front"
  | "send_backward"
  | "send_back"
  | "align_left"
  | "align_center"
  | "align_right"
  | "align_top"
  | "align_middle"
  | "align_bottom"
  | "distribute_horizontal"
  | "distribute_vertical"
  | "distribute_evenly"
  | "flip_horizontal"
  | "flip_vertical"
  | "lock"
  | "unlock"
  | "group"
  | "ungroup";

const ARRANGE_LABELS: Record<ArrangeAction, string> = {
  bring_forward: "Bring Forward",
  bring_front: "Bring to Front",
  send_backward: "Send Backward",
  send_back: "Send to Back",
  align_left: "Left",
  align_center: "Centre",
  align_right: "Right",
  align_top: "Top",
  align_middle: "Middle",
  align_bottom: "Bottom",
  distribute_horizontal: "Horizontally",
  distribute_vertical: "Vertically",
  distribute_evenly: "Evenly",
  flip_horizontal: "Flip Horizontally",
  flip_vertical: "Flip Vertically",
  lock: "Lock",
  unlock: "Unlock",
  group: "Group",
  ungroup: "Ungroup",
};

export async function semanticArrange(
  app: IWorkUiApp,
  action: ArrangeAction,
  dryRun = false,
): Promise<Outcome> {
  const ancestorText = action.startsWith("align_")
    ? "Align Objects"
    : action.startsWith("distribute_")
      ? "Distribute Objects"
      : undefined;
  return semanticPress({
    app,
    role: "AXMenuItem",
    title: ARRANGE_LABELS[action],
    ancestorText,
    dryRun,
    depth: 14,
    maxNodes: 3800,
  });
}

