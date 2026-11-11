// Global backpressure for tool execution.
//
// MCP clients can issue calls concurrently. Without a bound, a burst of shell,
// browser, indexing and document operations can oversubscribe a laptop until
// every request gets slower and the OS starts swapping. A small FIFO semaphore
// keeps throughput high while making overload predictable.
const DEFAULT_MAX_ACTIVE = 24;
const DEFAULT_MAX_QUEUED = 256;
const DEFAULT_WAIT_MS = 30_000;

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? Math.max(min, Math.min(max, Math.round(raw))) : fallback;
}

const MAX_ACTIVE = envInt("CHAT_UNLEASHED_MAX_INFLIGHT", DEFAULT_MAX_ACTIVE, 1, 128);
const MAX_QUEUED = envInt("CHAT_UNLEASHED_MAX_QUEUE", DEFAULT_MAX_QUEUED, 0, 4096);
const WAIT_MS = envInt("CHAT_UNLEASHED_QUEUE_WAIT_MS", DEFAULT_WAIT_MS, 100, 300_000);

let active = 0;
let rejected = 0;
let completed = 0;
let peakActive = 0;
let peakQueued = 0;

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const queue: Waiter[] = [];

function makeRelease(): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    active = Math.max(0, active - 1);
    completed += 1;
    drain();
  };
}

function drain(): void {
  while (active < MAX_ACTIVE && queue.length) {
    const waiter = queue.shift() as Waiter;
    clearTimeout(waiter.timer);
    active += 1;
    peakActive = Math.max(peakActive, active);
    waiter.resolve(makeRelease());
  }
}

export async function acquireToolSlot(): Promise<() => void> {
  if (active < MAX_ACTIVE) {
    active += 1;
    peakActive = Math.max(peakActive, active);
    return makeRelease();
  }
  if (queue.length >= MAX_QUEUED) {
    rejected += 1;
    throw new Error(`server busy: ${active} tool call(s) active and ${queue.length} queued; retry shortly`);
  }
  return new Promise<() => void>((resolve, reject) => {
    const waiter: Waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        rejected += 1;
        reject(new Error(`server busy: waited ${WAIT_MS}ms for a tool execution slot`));
      }, WAIT_MS),
    };
    queue.push(waiter);
    peakQueued = Math.max(peakQueued, queue.length);
  });
}

export function capacityStatus(): {
  active: number;
  queued: number;
  maxActive: number;
  maxQueued: number;
  completed: number;
  rejected: number;
  peakActive: number;
  peakQueued: number;
} {
  return {
    active,
    queued: queue.length,
    maxActive: MAX_ACTIVE,
    maxQueued: MAX_QUEUED,
    completed,
    rejected,
    peakActive,
    peakQueued,
  };
}
