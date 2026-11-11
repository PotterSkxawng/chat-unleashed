#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateIdleHealth, switchBundle } from "./deferred-update.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chat-unleashed-updater-test-"));
const now = Date.now();
const past = new Date(now - 40 * 60_000).toISOString();
const stagedAt = new Date(now - 30 * 60_000).toISOString();
const server = {
  ok: true, pid: 1234, uptime: 7200,
  toolCapacity: { active: 0, queued: 0, completed: 24 },
  http: { active: 0, rejected: 0 },
};
const tunnel = {
  live: true, ready: true, runtime: { instance_id: "tunnel-test", started_at: past },
  components: {
    dispatcher: { details: { active: 0, last_start: past, last_completion: past } },
    queue: { details: { depth: 0, enqueued: 24, dequeued: 24, last_enqueue: past, last_dequeue: past } },
    "response-delivery": { details: { in_progress: 0, accepted: 24, completed: 24, last_accepted: past, last_completed: past } },
  },
};
const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
let passed = 0;
function check(label, fn) {
  const result = fn();
  if (result instanceof Promise) return result.then(() => { passed++; console.log(`ok  ${label}`); });
  passed++; console.log(`ok  ${label}`);
}
const file = (name, content) => { const p = path.join(tmp, name); fs.writeFileSync(p, content); return p; };
try {
  check("quiet local server and tunnel become eligible", () => {
    assert.equal(evaluateIdleHealth(server, tunnel, stagedAt, now).idle, true);
  });
  check("remote command activity blocks update", () => {
    const busy = structuredClone(tunnel);
    busy.components.dispatcher.details.active = 1;
    assert.equal(evaluateIdleHealth(server, busy, stagedAt, now).idle, false);
  });
  check("remote queue and response delivery block update", () => {
    const pending = structuredClone(tunnel);
    pending.components.queue.details.depth = 1;
    assert.equal(evaluateIdleHealth(server, pending, stagedAt, now).idle, false);
    pending.components.queue.details.depth = 0;
    pending.components["response-delivery"].details.in_progress = 1;
    assert.equal(evaluateIdleHealth(server, pending, stagedAt, now).idle, false);
  });
  check("local tool calls block update", () => {
    assert.equal(evaluateIdleHealth({ ...server, toolCapacity: { ...server.toolCapacity, active: 1 } }, tunnel, stagedAt, now).idle, false);
    assert.equal(evaluateIdleHealth({ ...server, http: { ...server.http, active: 1 } }, tunnel, stagedAt, now).idle, false);
  });
  check("missing telemetry and unready tunnel fail closed", () => {
    const broken = structuredClone(tunnel);
    delete broken.components.dispatcher.details.active;
    assert.equal(evaluateIdleHealth(server, broken, stagedAt, now).idle, false);
    assert.equal(evaluateIdleHealth(server, { ...tunnel, ready: false }, stagedAt, now).idle, false);
  });
  check("new activity resets the quiet window", () => {
    const recent = structuredClone(tunnel);
    recent.components.dispatcher.details.last_start = new Date(now - 1000).toISOString();
    assert.equal(evaluateIdleHealth(server, recent, stagedAt, now).idle, false);
    assert.equal(evaluateIdleHealth(server, tunnel, stagedAt, now, 20 * 60_000, now - 500).idle, false);
  });

  const old = file("installed.js", "console.log('old');\n");
  const next = file("staged.js", "console.log('new');\n");
  const original = sha(old);
  const nextHash = sha(next);
  let restarts = 0;
  await check("healthy cutover installs exact stage and retains rollback", async () => {
    const result = await switchBundle({ stagedPath: next, sha256: nextHash }, 1234, "tunnel-test", {
      target: old,
      restart: async () => { restarts++; },
      verify: async () => 5678,
    });
    assert.equal(result.ok, true);
    assert.equal(result.newPid, 5678);
    assert.equal(sha(old), nextHash);
    assert.equal(sha(old + ".previous"), original);
    assert.equal(restarts, 1);
  });
  await check("already installed bundle still activates after idle", async () => {
    await switchBundle({ stagedPath: next, sha256: nextHash }, 1234, "tunnel-test", {
      target: old, restart: async () => { restarts++; }, verify: async () => 5678,
    });
    assert.equal(restarts, 2);
  });
  await check("failed health verification restores original bundle", async () => {
    fs.copyFileSync(old + ".previous", old);
    let attempts = 0;
    await assert.rejects(switchBundle({ stagedPath: next, sha256: nextHash }, 1234, "tunnel-test", {
      target: old,
      restart: async () => { attempts++; },
      verify: async () => { if (attempts === 1) throw new Error("health failed"); return 6789; },
    }), /rolled back and recovered/);
    assert.equal(sha(old), original);
    assert.equal(attempts, 2);
  });
  await check("digest mismatch and missing rollback prevent an unsafe restart", async () => {
    const prior = restarts;
    await assert.rejects(switchBundle({ stagedPath: next, sha256: "f".repeat(64) }, 1234, "tunnel-test", {
      target: old, restart: async () => { restarts++; },
    }), /digest changed/);
    fs.copyFileSync(next, old);
    fs.rmSync(old + ".previous");
    await assert.rejects(switchBundle({ stagedPath: next, sha256: nextHash }, 1234, "tunnel-test", {
      target: old, restart: async () => { restarts++; },
    }), /no distinct rollback/);
    assert.equal(restarts, prior);
  });

  await check("CLI stage is isolated and never changes the installed target", async () => {
    const runner = path.resolve("scripts/deferred-update.mjs");
    const source = path.resolve("dist/index.js");
    const runtime = path.join(tmp, "Runtime With Spaces");
    const updates = path.join(tmp, "Update State");
    const environment = { ...process.env, CHAT_UNLEASHED_RUNTIME_HOME: runtime, CHAT_UNLEASHED_UPDATER_HOME: updates };
    const stage = execFileSync(process.execPath, [runner, "stage", source], { env: environment, encoding: "utf8", timeout: 20000 });
    assert.match(stage, /Staged [a-f0-9]{64}/);
    assert.equal(fs.existsSync(path.join(runtime, "dist", "index.js")), false);
    const info = JSON.parse(fs.readFileSync(path.join(updates, "pending.json"), "utf8"));
    assert.equal(info.sha256, sha(source));
    assert.equal(sha(info.stagedPath), info.sha256);
    const checkResult = execFileSync(process.execPath, [runner, "check"], { env: {
      ...environment, CHAT_UNLEASHED_SERVER_HEALTH_URL: "http://127.0.0.1:1/health",
      CHAT_UNLEASHED_TUNNEL_HEALTH_URL: "http://127.0.0.1:1/health?details=true",
    }, encoding: "utf8", timeout: 10000 });
    assert.match(checkResult, /Deferred: health unavailable/);
    assert.equal(fs.existsSync(path.join(runtime, "dist", "index.js")), false);
    const cancel = execFileSync(process.execPath, [runner, "cancel"], { env: environment, encoding: "utf8" });
    assert.match(cancel, /No process was restarted/);
    assert.equal(fs.existsSync(path.join(updates, "pending.json")), false);
  });
  console.log(`deferred updater: ${passed} checks passed`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
