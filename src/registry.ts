// In-process tool registry.
//
// createServer() registers every tool handler here as it is declared. That lets
// the task orchestrator run a planned step by tool name without a round trip
// through the MCP protocol, and lets skills declare which tools they may use.
// The same registry feeds the call recorder that skill_record uses, so nothing
// has to be monkey-patched at runtime.

export interface ToolOutcome {
  ok: boolean;
  message: string;
  image?: { data: string; mimeType: string };
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolOutcome>;
export type ToolCallListener = (name: string, args: Record<string, unknown>) => void;

export interface ToolMetadata {
  readOnly?: boolean;
  destructive?: boolean;
}

const handlers = new Map<string, ToolHandler>();
const listeners = new Set<ToolCallListener>();
const descriptions = new Map<string, string>();
const metadata = new Map<string, ToolMetadata>();

export function registerHandler(name: string, handler: ToolHandler, description = "", meta: ToolMetadata = {}): void {
  handlers.set(name, handler);
  if (description) descriptions.set(name, description);
  metadata.set(name, { ...meta });
}

export function handlerFor(name: string): ToolHandler | undefined {
  return handlers.get(name);
}

export function describeTool(name: string): string {
  return descriptions.get(name) ?? "";
}

const VERIFICATION_SAFE_ACTIONS: Record<string, ReadonlySet<string>> = {
  code_index: new Set(["summary"]),
  code_loop: new Set(["history", "resources", "profile", "crashes"]),
  bench: new Set(["compare", "list"]),
};

const NON_DESTRUCTIVE_ACTIONS: Record<string, ReadonlySet<string>> = {
  code_loop: new Set(["history", "resources", "profile", "crashes"]),
};

export function toolCanVerify(name: string, args: Record<string, unknown> = {}): boolean {
  if (metadata.get(name)?.readOnly === true) return true;
  const action = typeof args.action === "string" ? args.action : "";
  return VERIFICATION_SAFE_ACTIONS[name]?.has(action) === true;
}

export function toolMayBeDestructive(name: string, args: Record<string, unknown> = {}): boolean {
  if (metadata.get(name)?.destructive !== true) return false;
  const action = typeof args.action === "string" ? args.action : "";
  return NON_DESTRUCTIVE_ACTIONS[name]?.has(action) !== true;
}

export function toolNames(): string[] {
  return [...handlers.keys()].sort();
}

export function onToolCall(listener: ToolCallListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called by the server wrapper for every invocation, including the ones the
 *  orchestrator makes directly, so a recording sees exactly what happened. */
export function noteToolCall(name: string, args: Record<string, unknown>): void {
  for (const listener of listeners) {
    try {
      listener(name, args);
    } catch {
      /* a recorder must never break the call it is observing */
    }
  }
}

/** Skill allowlists accept exact names and a trailing-star prefix form. */
export function matchesToolPattern(name: string, pattern: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  if (trimmed.endsWith("*")) return name.startsWith(trimmed.slice(0, -1));
  return name === trimmed;
}

export function allowedBy(name: string, allowlist: string[] | undefined): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  return allowlist.some((pattern) => matchesToolPattern(name, pattern));
}
