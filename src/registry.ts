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

const handlers = new Map<string, ToolHandler>();
const listeners = new Set<ToolCallListener>();
const descriptions = new Map<string, string>();

export function registerHandler(name: string, handler: ToolHandler, description = ""): void {
  handlers.set(name, handler);
  if (description) descriptions.set(name, description);
}

export function handlerFor(name: string): ToolHandler | undefined {
  return handlers.get(name);
}

export function describeTool(name: string): string {
  return descriptions.get(name) ?? "";
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
