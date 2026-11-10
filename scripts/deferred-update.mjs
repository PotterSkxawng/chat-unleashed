#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(scriptPath), "..");
const runtimeRoot = path.resolve(process.env.LOCAL_AGENT_RUNTIME_HOME?.trim() || path.join(os.homedir(), ".local", "share", "local-agent-mcp"));
const updateRoot = path.resolve(process.env.LOCAL_AGENT_UPDATER_HOME?.trim() || path.join(runtimeRoot, "updates"));
const target = path.join(runtimeRoot, "dist", "index.js");
const pendingFile = path.join(updateRoot, "pending.json");
const statusFile = path.join(updateRoot, "last-status.json");
const serverLabel = process.env.LOCAL_AGENT_SERVER_LABEL || "com.local-agent-mcp.server";
const updaterLabel = "com.local-agent-mcp.updater";
const idleSeconds = 20 * 60;
const serverEndpoint = process.env.LOCAL_AGENT_SERVER_HEALTH_URL || "http://127.0.0.1:3344/health";
const tunnelEndpoint = process.env.LOCAL_AGENT_TUNNEL_HEALTH_URL || "http://127.0.0.1:8080/health?details=true";

function ensureMac() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(`The deferred updater requires Apple Silicon macOS, not ${process.platform}-${process.arch}`);
  }
}
function safeDir(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
function hash(file) { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function atomicCopy(from, to, mode = 0o755) {
  safeDir(path.dirname(to));
  const temp = path.join(path.dirname(to), `.${path.basename(to)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.copyFileSync(from, temp, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, to);
  } finally { try { fs.unlinkSync(temp); } catch (e) { if (e?.code !== "ENOENT") throw e; } }
}
function writeJson(file, value) {
  safeDir(path.dirname(file));
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch (e) { if (e?.code !== "ENOENT") throw e; } }
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { if (e?.code === "ENOENT") return null; throw e; }
}
function locked(fn) {
  safeDir(updateRoot);
  const lock = path.join(updateRoot, "update.lock");
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (e) {
    if (e?.code !== "EEXIST") throw e;
    const marker = readJson(path.join(lock, "owner.json"));
    if (!marker?.pid || !Number.isInteger(marker.pid)) throw new Error("Updater lock is held; inspect the lock before retrying");
    try { process.kill(marker.pid, 0); throw new Error(`Updater already running (PID ${marker.pid})`); }
    catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    fs.rmSync(lock, { recursive: true, force: true });
    fs.mkdirSync(lock, { mode: 0o700 });
  }
  writeJson(path.join(lock, "owner.json"), { pid: process.pid, at: new Date().toISOString() });
  return Promise.resolve().then(fn).finally(() => fs.rmSync(lock, { recursive: true, force: true }));
}
function assertLoopback(value) {
  const u = new URL(value);
  if (u.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) {
    throw new Error("Updater health endpoints must be unencrypted loopback URLs, never public network hosts");
  }
  return value;
}
async function fetchJson(url, timeout = 3000) {
  const res = await fetch(assertLoopback(url), { signal: AbortSignal.timeout(timeout), cache: "no-store" });
  if (!res.ok) throw new Error(`health check failed: HTTP ${res.status}`);
  return await res.json();
}
function timestamp(value) {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
function numeric(value) { return Number.isInteger(value) && value >= 0 ? value : null; }

/** Evaluate only server and tunnel observations, without changing any process. */
export function evaluateIdleHealth(server, tunnel, stagedAt, now = Date.now(), quietMs = idleSeconds * 1000, auditModifiedAt = 0) {
  if (server?.ok !== true || !Number.isInteger(server?.pid) || server.pid < 1) return { idle: false, reason: "server health unavailable" };
  if (tunnel?.live !== true || tunnel?.ready !== true || !tunnel?.runtime?.instance_id) return { idle: false, reason: "tunnel health unavailable" };
  const dispatcher = tunnel.components?.dispatcher?.details;
  const queue = tunnel.components?.queue?.details;
  const delivery = tunnel.components?.["response-delivery"]?.details;
  const c = server.toolCapacity;
  const h = server.http;
  if (![c?.active, c?.queued, h?.active, dispatcher?.active, queue?.depth, delivery?.in_progress].every((v) => numeric(v) !== null)) {
    return { idle: false, reason: "missing in-flight telemetry (fail closed)" };
  }
  if (c.active || c.queued || h.active || dispatcher.active || queue.depth || delivery.in_progress) {
    return { idle: false, reason: "in-flight local or remote requests" };
  }
  const remoteTimes = [tunnel.runtime.started_at, dispatcher.last_start, dispatcher.last_completion, queue.last_enqueue,
    queue.last_dequeue, delivery.last_accepted, delivery.last_completed].map(timestamp).filter((n) => n !== null);
  const stagedTime = timestamp(stagedAt);
  if (!stagedTime || !remoteTimes.length || !Number.isFinite(server.uptime) || server.uptime < 0) {
    return { idle: false, reason: "missing activity timestamps (fail closed)" };
  }
  const latest = Math.max(stagedTime, ...remoteTimes, now - server.uptime * 1000, auditModifiedAt);
  if (latest > now + 5000) return { idle: false, reason: "future activity timestamp (clock mismatch)" };
  const remainingMs = latest + quietMs - now;
  if (remainingMs > 0) return { idle: false, reason: `quiet window not reached (${Math.ceil(remainingMs / 1000)} s remaining)`, latest };
  return {
    idle: true,
    reason: "no local or remote commands during quiet window",
    latest,
    serverPid: server.pid,
    tunnelInstance: tunnel.runtime.instance_id,
    fingerprint: JSON.stringify([server.pid, tunnel.runtime.instance_id, c.completed, h.rejected,
      dispatcher.last_start, dispatcher.last_completion, queue.enqueued, queue.dequeued,
      delivery.accepted, delivery.completed]),
  };
}
async function observe(manifest, now = Date.now(), quietMs = idleSeconds * 1000) {
  const [server, tunnel] = await Promise.all([fetchJson(serverEndpoint), fetchJson(tunnelEndpoint)]);
  const stateHome = process.env.LOCAL_AGENT_MCP_HOME?.trim()
    ? path.resolve(process.env.LOCAL_AGENT_MCP_HOME.trim())
    : path.join(os.homedir(), "Library", "Application Support", "local-agent-mcp");
  const auditFile = path.join(stateHome, "logs", "audit.log");
  let lastAudit = 0;
  try { lastAudit = fs.statSync(auditFile).mtimeMs; } catch (e) { if (e?.code !== "ENOENT") throw e; }
  return evaluateIdleHealth(server, tunnel, manifest.createdAt, now, quietMs, lastAudit);
}
async function availablePort() {
  const s = net.createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const p = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return p;
}
async function preflight(bundle) {
  const syntax = spawnSync(process.execPath, ["--check", bundle], { encoding: "utf8", timeout: 15000 });
  if (syntax.status !== 0) throw new Error(`bundle syntax check failed: ${(syntax.stderr || "").slice(0, 500)}`);
  const port = await availablePort();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "local-agent-stage-"));
  const child = spawn(process.execPath, [bundle, "--http", "--port", String(port)], {
    stdio: "ignore", env: { ...process.env, LOCAL_AGENT_MCP_HOME: scratch },
  });
  try {
    const until = Date.now() + 8000;
    while (Date.now() < until && child.exitCode === null) {
      try {
        const health = await fetchJson(`http://127.0.0.1:${port}/health`, 500);
        if (health?.ok === true && Number.isInteger(health.pid)) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 120));
    }
    throw new Error("candidate did not start a healthy isolated HTTP MCP server");
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([once(child, "exit").catch(() => {}), new Promise((r) => setTimeout(r, 2500))]);
    if (child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
function checkedManifest() {
  const manifest = readJson(pendingFile);
  if (!manifest) return null;
  if (!/^[0-9a-f]{64}$/.test(manifest.sha256 || "")) throw new Error("invalid pending digest");
  const expectedStage = path.join(updateRoot, "staged", manifest.sha256, "index.js");
  if (manifest.stagedPath !== expectedStage) throw new Error("pending update points outside its content-addressed stage");
  if (!fs.existsSync(expectedStage) || hash(expectedStage) !== manifest.sha256) throw new Error("staged bundle was changed or removed");
  if (manifest.target !== target) throw new Error("pending update targets a different installed runtime");
  return manifest;
}
async function stage(source) {
  const file = path.resolve(source || path.join(packageRoot, "dist", "index.js"));
  if (!fs.existsSync(file)) throw new Error(`No candidate bundle: ${file}`);
  await preflight(file);
  const sha256 = hash(file);
  const stagedPath = path.join(updateRoot, "staged", sha256, "index.js");
  if (fs.existsSync(stagedPath) && hash(stagedPath) !== sha256) throw new Error("existing stage directory has a different bundle");
  if (!fs.existsSync(stagedPath)) atomicCopy(file, stagedPath);
  writeJson(pendingFile, { version: 1, sha256, target, stagedPath, createdAt: new Date().toISOString(), serverLabel, quietSeconds: idleSeconds });
  writeJson(statusFile, { state: "staged", sha256, at: new Date().toISOString() });
  console.log(`Staged ${sha256}. No live process has been restarted. Requires ${idleSeconds / 60} minutes without tool activity.`);
}
function serviceTargetVerified() {
  const domain = `gui/${process.getuid()}/${serverLabel}`;
  const result = spawnSync("/bin/launchctl", ["print", domain], { encoding: "utf8", timeout: 6000 });
  if (result.status !== 0) throw new Error(`server launchd job ${serverLabel} is unavailable`);
  if (!result.stdout.includes(target)) throw new Error("server launchd job does not point at the installed runtime target");
  return domain;
}
function restartServer(domain) {
  const result = spawnSync("/bin/launchctl", ["kickstart", "-k", domain], { encoding: "utf8", timeout: 10000 });
  if (result.status !== 0) throw new Error(`server-only launchd restart failed: ${(result.stderr || "").trim().slice(0, 200)}`);
}
async function verifyNewProcess(previousPid, tunnelInstance, readServer = () => fetchJson(serverEndpoint), readTunnel = () => fetchJson(tunnelEndpoint)) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    try {
      const [server, tunnel] = await Promise.all([readServer(), readTunnel()]);
      if (server?.ok && server.pid !== previousPid && tunnel?.live && tunnel?.ready && tunnel.runtime?.instance_id === tunnelInstance) return server.pid;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("replacement server did not become healthy while the existing tunnel stayed ready");
}

/** Exposed for isolated regression tests; only the CLI uses launchctl. */
export async function switchBundle(manifest, oldPid, tunnelInstance, options = {}) {
  const installed = options.target || target;
  const candidate = options.candidate || manifest.stagedPath;
  const previous = `${installed}.previous`;
  const expected = manifest.sha256;
  const restart = options.restart || restartServer;
  const verify = options.verify || verifyNewProcess;
  const domain = options.domain || "";
  if (hash(candidate) !== expected) throw new Error("staged content digest changed");
  if (!fs.existsSync(installed)) throw new Error("installed runtime is missing; refusing an unbacked update");
  const current = hash(installed);
  if (current !== expected) atomicCopy(installed, previous);
  else if (!fs.existsSync(previous) || hash(previous) === expected) {
    throw new Error("installed bundle already matches stage but no distinct rollback version is available");
  }
  let attempted = false;
  try {
    attempted = true;
    if (current !== expected) atomicCopy(candidate, installed);
    if (hash(installed) !== expected) throw new Error("installed candidate digest mismatch");
    await restart(domain);
    const newPid = await verify(oldPid, tunnelInstance);
    return { ok: true, newPid, sha256: expected };
  } catch (error) {
    if (!attempted) throw error;
    atomicCopy(previous, installed);
    let recovered = false;
    try {
      await restart(domain);
      await verify(oldPid, tunnelInstance);
      recovered = true;
    } catch {}
    throw new Error(`update rolled back${recovered ? " and recovered" : " but recovery could not be confirmed"}: ${error.message}`);
  }
}
async function check() {
  const manifest = checkedManifest();
  if (!manifest) return;
  const last = readJson(statusFile);
  if (last?.state === "applied" && last.sha256 === manifest.sha256 &&
      fs.existsSync(target) && hash(target) === manifest.sha256) {
    fs.unlinkSync(pendingFile);
    return;
  }
  if (last?.state === "activating") {
    console.log("Blocked: prior activation was interrupted; inspect the server and restage deliberately.");
    return;
  }
  let first;
  try { first = await observe(manifest); }
  catch (e) { return writeDeferred(`health unavailable: ${e.message}`); }
  if (!first.idle) return writeDeferred(first.reason);
  const domain = serviceTargetVerified();
  await preflight(manifest.stagedPath);
  await new Promise((r) => setTimeout(r, 2000));
  let second;
  try { second = await observe(manifest); }
  catch (e) { return writeDeferred(`health changed: ${e.message}`); }
  if (!second.idle || first.fingerprint !== second.fingerprint) return writeDeferred("new activity arrived during final check");
  try {
    writeJson(statusFile, { state: "activating", at: new Date().toISOString(), sha256: manifest.sha256, oldPid: first.serverPid });
    const result = await switchBundle(manifest, first.serverPid, first.tunnelInstance, { domain });
    writeJson(statusFile, { state: "applied", at: new Date().toISOString(), ...result });
    fs.unlinkSync(pendingFile);
    console.log(`Activated staged bundle on local server PID ${result.newPid}. Tunnel was not restarted.`);
  } catch (error) {
    writeJson(statusFile, { state: "failed", at: new Date().toISOString(), reason: error.message, sha256: manifest.sha256 });
    fs.unlinkSync(pendingFile); // Failure requires deliberate restaging; never restart-loop.
    throw error;
  }
}
function writeDeferred(reason) {
  const existing = readJson(statusFile);
  if (existing?.state !== "deferred" || existing.reason !== reason) writeJson(statusFile, { state: "deferred", at: new Date().toISOString(), reason });
  console.log(`Deferred: ${reason}`);
}
function stableNodeExecutable() {
  const canonical = fs.realpathSync(process.execPath);
  const candidates = [
    ...((process.env.PATH || "").split(path.delimiter)),
    "/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local", "bin"),
  ];
  for (const directory of candidates) {
    if (!directory || directory.includes("/Cellar/")) continue;
    const candidate = path.join(directory, "node");
    try {
      if (fs.realpathSync(candidate) === canonical) return candidate;
    } catch {}
  }
  return process.execPath;
}
function escapeXml(s) { return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function arrayXml(items) { return `<array>${items.map((s) => `<string>${escapeXml(s)}</string>`).join("")}</array>`; }
function installWatcher() {
  serviceTargetVerified();
  const script = path.join(updateRoot, "deferred-update.mjs");
  const log = path.join(updateRoot, "updater.log");
  const plist = path.join(os.homedir(), "Library", "LaunchAgents", `${updaterLabel}.plist`);
  safeDir(path.dirname(plist));
  const envVars = {
    LOCAL_AGENT_RUNTIME_HOME: runtimeRoot,
    LOCAL_AGENT_UPDATER_HOME: updateRoot,
    LOCAL_AGENT_SERVER_LABEL: serverLabel,
    LOCAL_AGENT_SERVER_HEALTH_URL: assertLoopback(serverEndpoint),
    LOCAL_AGENT_TUNNEL_HEALTH_URL: assertLoopback(tunnelEndpoint),
  };
  if (process.env.LOCAL_AGENT_MCP_HOME?.trim()) envVars.LOCAL_AGENT_MCP_HOME = path.resolve(process.env.LOCAL_AGENT_MCP_HOME.trim());
  const env = `<dict>${Object.entries(envVars).map(([key, value]) => `<key>${key}</key><string>${escapeXml(value)}</string>`).join("")}</dict>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${updaterLabel}</string><key>ProgramArguments</key>${arrayXml([stableNodeExecutable(), script, "check"])}<key>EnvironmentVariables</key>${env}<key>RunAtLoad</key><false/><key>StartInterval</key><integer>60</integer><key>StandardOutPath</key><string>${escapeXml(log)}</string><key>StandardErrorPath</key><string>${escapeXml(log)}</string><key>ProcessType</key><string>Background</string></dict></plist>`;
  const prior = fs.existsSync(plist) ? fs.readFileSync(plist, "utf8") : null;
  const domain = `gui/${process.getuid()}/${updaterLabel}`;
  const print = spawnSync("/bin/launchctl", ["print", domain], { stdio: "ignore", timeout: 6000 });
  if (print.status === 0 && prior !== xml) {
    throw new Error("Updater LaunchAgent is loaded with different configuration; do not replace it in place");
  }
  atomicCopy(scriptPath, script, 0o700);
  if (prior !== xml) {
    const temp = `${plist}.${process.pid}.tmp`;
    fs.writeFileSync(temp, xml, { mode: 0o600 });
    fs.renameSync(temp, plist);
  }
  if (print.status !== 0) {
    const boot = spawnSync("/bin/launchctl", ["bootstrap", `gui/${process.getuid()}`, plist], { encoding: "utf8", timeout: 10000 });
    if (boot.status !== 0) throw new Error(`Could not register update watcher: ${(boot.stderr || "").trim()}`);
  }
  console.log(`Installed independent update watcher (${updaterLabel}). It will only restart ${serverLabel} after a quiet window.`);
}
async function runCli() {
  ensureMac();
  const action = process.argv[2] || "status";
  if (action === "status") {
    const pending = readJson(pendingFile);
    const last = readJson(statusFile);
    console.log(JSON.stringify({ pending: pending && { sha256: pending.sha256, createdAt: pending.createdAt, quietSeconds: pending.quietSeconds }, last, watcher: updaterLabel, serverLabel }, null, 2));
  } else if (action === "install") {
    await locked(() => installWatcher());
  } else if (action === "stage") {
    await locked(() => stage(process.argv[3]));
  } else if (action === "check") {
    await locked(check);
  } else if (action === "cancel") {
    await locked(() => { try { fs.unlinkSync(pendingFile); } catch (e) { if (e.code !== "ENOENT") throw e; } writeJson(statusFile, { state: "cancelled", at: new Date().toISOString() }); console.log("Pending update cancelled. No process was restarted."); });
  } else throw new Error("Usage: deferred-update.mjs [install|stage [bundle]|check|status|cancel]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  runCli().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
