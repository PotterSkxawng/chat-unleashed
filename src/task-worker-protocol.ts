import type { ToolOutcome } from "./registry.js";

export const TASK_WORKER_PREFIX = "@@CHAT_UNLEASHED_TASK_WORKER_V1@@";

export interface TaskWorkerRequest {
  id: number;
  tool: string;
  args: Record<string, unknown>;
}

export interface TaskWorkerResponse {
  id: number;
  result?: ToolOutcome;
  error?: string;
}
