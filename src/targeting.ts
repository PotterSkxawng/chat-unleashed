// Target resolution and method choice, with no side effects.
//
// Everything here works on plain observations so the decision can be tested and
// explained without a screen. The planner picks the method from what the app can
// actually do: a real accessibility action when one exists, a menu command when
// the app is scriptable, a known shortcut after that, and pointer geometry only
// as the last resort, because geometry is the option that breaks when a window
// moves or a display changes scale.

export interface UiLike {
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

export interface TargetQuery {
  name?: string;
  role?: string;
  identifier?: string;
  text?: string;
  index?: number;
}

export interface Candidate {
  node: UiLike;
  score: number;
  reasons: string[];
}

function norm(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function roleMatches(node: UiLike, wanted: string): boolean {
  const have = norm(node.role);
  const want = norm(wanted);
  if (!want) return true;
  if (have === want) return true;
  // "button" should match AXButton, "text field" should match AXTextField.
  return have.replace(/^ax/, "") === want.replace(/^ax/, "").replace(/\s+/g, "");
}

function fieldScore(node: UiLike, query: TargetQuery, reasons: string[]): number {
  let score = 0;
  const name = norm(query.name ?? query.text);
  if (name) {
    const title = norm(node.title);
    const desc = norm(node.description);
    const value = norm(node.value);
    const ident = norm(node.identifier);
    if (title === name) {
      score += 70;
      reasons.push("title matches exactly");
    } else if (title.startsWith(name)) {
      score += 52;
      reasons.push("title starts with the name");
    } else if (title.includes(name)) {
      score += 42;
      reasons.push("title contains the name");
    } else if (ident === norm(query.identifier ?? "")) {
      score += 60;
      reasons.push("identifier matches");
    } else if (desc === name) {
      score += 34;
      reasons.push("description matches");
    } else if (desc.includes(name)) {
      score += 22;
      reasons.push("description contains the name");
    } else if (value === name) {
      score += 26;
      reasons.push("value matches");
    } else if (value.includes(name)) {
      score += 12;
      reasons.push("value contains the name");
    } else if (ident.includes(name)) {
      score += 18;
      reasons.push("identifier contains the name");
    } else {
      return 0;
    }
  }
  if (query.identifier) {
    const ident = norm(node.identifier);
    if (ident === norm(query.identifier)) {
      score += 30;
      reasons.push("identifier matches exactly");
    } else if (ident.includes(norm(query.identifier))) {
      score += 14;
      reasons.push("identifier contains the value");
    }
  }
  if (query.role && !roleMatches(node, query.role)) return 0;
  if (node.enabled === false) {
    score -= 25;
    reasons.push("disabled");
  }
  if (node.actions?.some((action) => norm(action) === "axpress")) {
    score += 12;
    reasons.push("supports press");
  }
  if (node.focused === true) {
    score += 6;
    reasons.push("focused");
  }
  // A deeper node with the same label is usually the label inside the control.
  score -= Math.min(Number(node.depth ?? 0), 12);
  return score;
}

/** Rank the nodes that could be the thing the caller meant. Ambiguity is visible:
 *  two candidates with close scores are reported together so the caller can pick. */
export function rankCandidates(nodes: UiLike[], query: TargetQuery, limit = 5): Candidate[] {
  const wanted = norm(query.name ?? query.text ?? "");
  const ranked: Candidate[] = [];
  for (const node of nodes) {
    if (!node.role && !node.title && !node.description) continue;
    if (wanted && !norm(`${node.title} ${node.description} ${node.value} ${node.identifier}`).includes(wanted)) {
      // Cheap prefilter only: a node whose identifier is queried directly still counts.
      if (!query.identifier || !norm(node.identifier).includes(norm(query.identifier))) continue;
    }
    const reasons: string[] = [];
    const score = fieldScore(node, query, reasons);
    if (score > 0) ranked.push({ node, score, reasons });
  }
  ranked.sort((a, b) => b.score - a.score);
  const start = Math.max(0, Number(query.index ?? 0));
  return ranked.slice(start, start + limit);
}

export interface ScreenFlags {
  dialog: boolean;
  permissionPrompt: boolean;
  loading: boolean;
  menuOpen: boolean;
  modals: Array<{ title: string; path: string }>;
}

const PERMISSION_TEXT = /(wants to (control|access|use|record)|would like to|requesting to|allow .* to|permission|accessibility access|screen recording|automation access)/i;
const LOADING_TEXT = /(loading|opening|rendering|preparing|importing|exporting|computing|please wait|syncing)/i;

/** Read the screen for the states that change what a plan should do next. */
export function detectState(nodes: UiLike[]): ScreenFlags {
  const flags: ScreenFlags = { dialog: false, permissionPrompt: false, loading: false, menuOpen: false, modals: [] };
  for (const node of nodes) {
    const role = norm(node.role);
    const subrole = norm(node.subrole);
    const label = `${node.title ?? ""} ${node.description ?? ""}`.trim();
    if (role === "axsheet" || role === "axdialog" || subrole === "axdialog" || subrole === "axsystemdialog") {
      flags.dialog = true;
      if (flags.modals.length < 5) flags.modals.push({ title: label.slice(0, 120), path: node.path ?? "" });
      if (PERMISSION_TEXT.test(label)) flags.permissionPrompt = true;
    }
    if (role === "axprogressindicator" || role === "axbusyindicator" || subrole === "axbusyindicator") flags.loading = true;
    if (!flags.loading && LOADING_TEXT.test(label) && (role === "axstatictext" || role === "axwindow")) flags.loading = true;
    if (role === "axmenu" && node.enabled !== false) flags.menuOpen = true;
  }
  return flags;
}

export interface Capabilities {
  /** Accessibility is answering for this app. */
  accessible: boolean;
  /** The app has a scripting dictionary we can address for menu commands. */
  scriptable: boolean;
  /** intents the app answers with a keyboard shortcut, lower case. */
  shortcuts: Record<string, string[]>;
  /** intents the app answers with an AppleScript command, keyed by intent. */
  commands?: Record<string, string>;
}

export type Method = "ax_press" | "ax_set_value" | "shortcut" | "applescript_command" | "pointer_click" | "none";

export interface ActionPlan {
  method: Method;
  confidence: "high" | "medium" | "low";
  why: string;
  path?: string;
  keys?: string[];
  script?: string;
  point?: { x: number; y: number };
  steps: string[];
  fallbacks: Method[];
  blocked?: string;
}

export function centerOf(node: UiLike): { x: number; y: number } | undefined {
  const size = node.size;
  const pos = node.position;
  if (!size || !pos) return undefined;
  if (!size.width || !size.height) return undefined;
  return { x: Math.round(pos.x + size.width / 2), y: Math.round(pos.y + size.height / 2) };
}

export interface PlanOptions {
  app: string;
  intent?: string;
  capabilities: Capabilities;
  /** Set when the caller wants to fill a field rather than press something. */
  value?: string;
}

const EDITABLE_ROLES = new Set(["axtextfield", "axtextarea", "axcombobox", "axsearchfield", "axsecuretextfield"]);

/** The ladder. Each rung is only used when the rung above it cannot work here. */
export function chooseMethod(node: UiLike, options: PlanOptions): ActionPlan {
  const caps = options.capabilities;
  const role = norm(node.role);
  const actions = (node.actions ?? []).map(norm);
  const fallbacks: Method[] = [];
  const canPress = actions.includes("axpress");
  const editable = EDITABLE_ROLES.has(role);

  if (options.value !== undefined && caps.accessible && editable && node.path) {
    return {
      method: "ax_set_value",
      confidence: "high",
      why: "the field exposes its value directly, so no typing or focus is needed",
      path: node.path,
      steps: [`set ${role} at path ${node.path} to the given value`, "re-read the field to confirm the value changed"],
      fallbacks: ["pointer_click"],
    };
  }

  if (caps.accessible && canPress && node.path !== undefined) {
    fallbacks.push("shortcut", "pointer_click");
    return {
      method: "ax_press",
      confidence: "high",
      why: "the element supports a real press action, which survives moves, scaling and display changes",
      path: node.path,
      steps: [`perform AXPress on path ${node.path}`, "confirm the element or window changed state"],
      fallbacks,
    };
  }

  const intent = norm(options.intent);
  const keys = intent ? caps.shortcuts[intent] : undefined;
  if (keys?.length) {
    fallbacks.push("pointer_click");
    return {
      method: "shortcut",
      confidence: "medium",
      why: `${options.app} binds "${intent}" to a menu shortcut, so the command runs without aiming at anything`,
      keys,
      steps: [`send ${keys.join("+")} to ${options.app}`, "confirm the window or document changed"],
      fallbacks,
    };
  }

  const script = intent ? caps.commands?.[intent] : undefined;
  if (caps.scriptable && script) {
    fallbacks.push("pointer_click");
    return {
      method: "applescript_command",
      confidence: "medium",
      why: `${options.app} answers this command through its scripting interface, so nothing has to be aimed at`,
      script,
      steps: [`run the AppleScript command for "${intent}"`, `confirm ${options.app} changed state`],
      fallbacks,
    };
  }

  const point = centerOf(node);
  if (point) {
    const label = node.title ?? node.description ?? node.value ?? "element";
    return {
      method: "pointer_click",
      confidence: "low",
      why: "no accessibility action and no shortcut is available, so this is geometry taken from the current bounds",
      point,
      steps: [
        `click ${point.x},${point.y} (center of "${String(label).slice(0, 60)}")`,
        "confirm something changed, otherwise re-observe before trying again",
      ],
      fallbacks: [],
    };
  }

  return {
    method: "none",
    confidence: "low",
    why: caps.accessible ? "the element has no action, no shortcut and no usable bounds" : "accessibility is not available for this app",
    steps: [],
    fallbacks: [],
    blocked: caps.accessible
      ? "Re-observe with a larger depth, or find the control by its menu command instead."
      : "Grant Accessibility access, or use the app's scripting interface instead of the interface tree.",
  };
}

export interface Observation {
  title?: string;
  focusedPath?: string;
  thumbprint?: string;
  nodes?: UiLike[];
  flags?: ScreenFlags;
}

/** Did the action actually do something? Pixel change alone is weak evidence, and
 *  is reported as such rather than as a pass. */
export function verifyTransition(
  before: Observation,
  after: Observation,
  plan: ActionPlan,
): { verified: boolean; weak: boolean; evidence: string[] } {
  const evidence: string[] = [];
  let strong = false;

  if (before.title !== undefined && after.title !== undefined && before.title !== after.title) {
    evidence.push(`window title changed: "${before.title}" -> "${after.title}"`);
    strong = true;
  }
  if (before.focusedPath !== undefined && after.focusedPath !== undefined && before.focusedPath !== after.focusedPath) {
    evidence.push(`focus moved: ${before.focusedPath} -> ${after.focusedPath}`);
    strong = true;
  }
  if (before.flags && after.flags) {
    if (!before.flags.dialog && after.flags.dialog) {
      evidence.push("a dialog appeared");
      strong = true;
    }
    if (before.flags.dialog && !after.flags.dialog) {
      evidence.push("the dialog closed");
      strong = true;
    }
    if (!before.flags.menuOpen && after.flags.menuOpen) {
      evidence.push("a menu opened");
      strong = true;
    }
    if (before.flags.menuOpen && !after.flags.menuOpen) {
      evidence.push("the menu closed");
      strong = true;
    }
    if (!before.flags.loading && after.flags.loading) {
      evidence.push("a progress indicator appeared");
      strong = true;
    }
  }

  // A pressed control that vanished or went disabled is usually the result of the press.
  if (plan.path && before.nodes && after.nodes) {
    const find = (nodes: UiLike[]) => nodes.find((node) => node.path === plan.path);
    const was = find(before.nodes);
    const now = find(after.nodes);
    if (was && !now) {
      evidence.push("the pressed element is no longer present");
      strong = true;
    } else if (was && now && was.enabled !== false && now.enabled === false) {
      evidence.push("the pressed element became disabled");
      strong = true;
    } else if (was && now) {
      if (was.value !== now.value && (was.value !== undefined || now.value !== undefined)) {
        evidence.push("the element value changed: " + JSON.stringify(was.value ?? "") + " -> " + JSON.stringify(now.value ?? ""));
        strong = true;
      }
      if (was.title !== now.title && (was.title !== undefined || now.title !== undefined)) {
        evidence.push("the element title changed: " + JSON.stringify(was.title ?? "") + " -> " + JSON.stringify(now.title ?? ""));
        strong = true;
      }
      if (was.focused !== now.focused && (was.focused !== undefined || now.focused !== undefined)) {
        evidence.push("the element focus state changed");
        strong = true;
      }
      const bp = was.position, ap = now.position, bs = was.size, as = now.size;
      if (
        bp && ap && bs && as &&
        (bp.x !== ap.x || bp.y !== ap.y || bs.width !== as.width || bs.height !== as.height)
      ) {
        evidence.push("the element moved or resized");
        strong = true;
      }
    }
  }

  const pixelsMoved = Boolean(before.thumbprint && after.thumbprint && before.thumbprint !== after.thumbprint);
  if (!strong && pixelsMoved) evidence.push("the screen changed but no structural evidence was found");
  if (strong) return { verified: true, weak: false, evidence };
  if (pixelsMoved) return { verified: true, weak: true, evidence };
  evidence.push("nothing observable changed");
  return { verified: false, weak: false, evidence };
}

export function describePlan(plan: ActionPlan): string {
  const lines = [`method: ${plan.method} (${plan.confidence} confidence)`, `why: ${plan.why}`];
  plan.steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  if (plan.fallbacks.length) lines.push(`fallback: ${plan.fallbacks.join(" then ")}`);
  if (plan.blocked) lines.push(`blocked: ${plan.blocked}`);
  return lines.join("\n");
}
