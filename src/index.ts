#!/usr/bin/env node
import http from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { audit, flushAuditSync } from "./audit.js";
import { capacityStatus } from "./capacity.js";
import {
  APP_VERSION,
  configPath,
  defaultConfig,
  loadConfig,
  mergeConfig,
  patchConfig,
  redactConfig,
  resetConfig,
  saveConfig,
  type AppConfig,
} from "./config.js";
import { allStatus, diagnose, openPane, processIdentity, requestPermissions, type PermKind } from "./permissions.js";
import { createServer } from "./server.js";
import { runTask } from "./orchestrator.js";

function assertSupportedPlatform(): void {
  if (process.platform === "darwin" && process.arch === "arm64") return;
  process.stderr.write(
    `Chat Unleashed supports Apple Silicon Macs (darwin-arm64); current platform is ${process.platform}-${process.arch}.\n`,
  );
  process.exit(1);
}

assertSupportedPlatform();

// --- local JSON API for the desktop frontend ---------------------------------
// Loopback callers only: this mutates the same settings the MCP tools expose.
const API_MAX_BODY = 1 << 20;

function envInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
}

const MCP_MAX_BODY = envInt("MCP_MAX_BODY_BYTES", 32 * 1024 * 1024, 1024 * 1024, 256 * 1024 * 1024);
const HTTP_MAX_INFLIGHT = envInt("MCP_HTTP_MAX_INFLIGHT", 32, 1, 512);
const HTTP_BODY_BUDGET = envInt("MCP_HTTP_BODY_BUDGET_BYTES", 256 * 1024 * 1024, 8 * 1024 * 1024, 2 * 1024 * 1024 * 1024);
let httpInflight = 0;
let httpPeak = 0;
let httpRejected = 0;
let httpBodyBytes = 0;
let httpPeakBodyBytes = 0;


function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,PATCH,PUT,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(body, null, 2));
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > API_MAX_BODY) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function isLoopback(req: http.IncomingMessage): boolean {
  const remote = req.socket.remoteAddress ?? "";
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const route = url.pathname.replace(/\/+$/, "");
  if (!isLoopback(req)) {
    sendJson(res, 403, { error: "the settings API is loopback only" });
    return;
  }
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  try {
    if (req.method === "GET" && route === "/api/health") {
      sendJson(res, 200, { ok: true, pid: process.pid, name: "chat-unleashed", uptime: Math.round(process.uptime()) });
      return;
    }
    if (req.method === "GET" && route === "/api/config") {
      sendJson(res, 200, {
        path: configPath(),
        config: redactConfig(loadConfig()),
        defaults: defaultConfig(),
      });
      return;
    }
    if ((req.method === "PATCH" || req.method === "PUT") && route === "/api/config") {
      const body = await readBody(req);
      let next: AppConfig;
      if (req.method === "PATCH") {
        next = patchConfig(body);
      } else {
        next = saveConfig(mergeConfig(defaultConfig(), body) as AppConfig);
      }
      audit({ event: "config_change", summary: `${req.method} /api/config` });
      sendJson(res, 200, { path: configPath(), config: redactConfig(next) });
      return;
    }
    if (req.method === "POST" && route === "/api/config/reset") {
      const next = resetConfig();
      audit({ event: "config_change", summary: "POST /api/config/reset" });
      sendJson(res, 200, { path: configPath(), config: redactConfig(next) });
      return;
    }
    if (req.method === "GET" && route === "/api/status") {
      const [permissions, identity] = await Promise.all([allStatus(), Promise.resolve(processIdentity())]);
      sendJson(res, 200, {
        ok: true,
        version: APP_VERSION,
        pid: process.pid,
        uptime: Math.round(process.uptime()),
        platform: `${process.platform}-${process.arch}`,
        configPath: configPath(),
        identity,
        permissions,
      });
      return;
    }
    if (req.method === "GET" && route === "/api/diagnose") {
      sendJson(res, 200, { text: await diagnose() });
      return;
    }
    if (req.method === "POST" && route === "/api/permissions/request") {
      const body = (await readBody(req)) as { kinds?: string[] };
      const kinds = (body.kinds?.length ? body.kinds : ["accessibility", "screenRecording"]) as PermKind[];
      const outcomes = await requestPermissions(kinds);
      audit({ event: "permission_request", summary: kinds.join(",") });
      sendJson(res, 200, { outcomes, permissions: await allStatus() });
      return;
    }
    if (req.method === "POST" && route === "/api/permissions/open") {
      const body = (await readBody(req)) as { kind?: string };
      const opened = await openPane((body.kind ?? "all") as PermKind | "all");
      sendJson(res, 200, { opened });
      return;
    }
    sendJson(res, 404, { error: `no API route for ${req.method} ${route}` });
  } catch (err) {
    sendJson(res, 400, { error: (err as Error).message });
  }
}

interface Cli {
  mode: "stdio" | "http";
  port: number;
  host: string;
  /** Headless task run: no MCP client, no conversation, just the plan on disk. */
  task: string | null;
  maxSteps: number | null;
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = { mode: "stdio", port: 3344, host: "127.0.0.1", task: null, maxSteps: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--http" || arg === "--http-server") cli.mode = "http";
    else if (arg === "--stdio") cli.mode = "stdio";
    else if (arg === "--run-task") cli.task = String(argv[++i] ?? "");
    else if (arg.startsWith("--run-task=")) cli.task = arg.slice(11);
    else if (arg === "--max-steps") cli.maxSteps = Number(argv[++i]);
    else if (arg.startsWith("--max-steps=")) cli.maxSteps = Number(arg.slice(12));
    else if (arg === "--port") cli.port = Number(argv[++i]);
    else if (arg.startsWith("--port=")) cli.port = Number(arg.slice(7));
    else if (arg === "--host") cli.host = String(argv[++i]);
    else if (arg.startsWith("--host=")) cli.host = arg.slice(7);
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Chat Unleashed MCP server",
          "",
          "Usage:",
          "  npm run stdio",
          "  npm run http",
          "  node dist/index.js --http --port 3344 --host 127.0.0.1",
          "  node dist/index.js --run-task <id> [--max-steps N]",
          "                                  run a saved task with no MCP client attached",
          "",
        ].join("\n"),
      );
      process.exit(0);
    }
  }
  if (!Number.isInteger(cli.port) || cli.port < 1 || cli.port > 65535) {
    process.stderr.write(`invalid --port\n`);
    process.exit(2);
  }
  return cli;
}

const cli = parseArgs(process.argv.slice(2));

async function main(): Promise<void> {
  if (cli.task) {
    audit({ event: "task_headless", summary: `task=${cli.task}` });
    // createServer() is what fills the in-process tool registry, so it has to
    // run even though no transport is connected.
    createServer();
    const report = await runTask(cli.task, { maxSteps: cli.maxSteps ?? undefined });
    process.stdout.write(`${report.message}\n`);
    const failed = report.stopped === "failure" || report.stopped === "locked";
    process.exit(failed ? 1 : 0);
  }
  if (cli.mode === "stdio") {
    audit({ event: "server_start", summary: "transport=stdio" });
    const server = createServer();
    await server.connect(new StdioServerTransport());
    audit({ event: "server_connected", summary: "transport=stdio" });
    process.stdin.on("end", () => process.exit(0));
    return;
  }

  // Stateless Streamable HTTP: a fresh server + transport per POST, loopback only.
  // MCP_ALLOWED_HOSTS=host1:port1,host2:port2 widens the Host pin (needed when a
  // tunnel or proxy rewrites the Host header on its way to 127.0.0.1).
  const extraHosts = (process.env.MCP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (extraHosts.length) {
    process.stderr.write(`[http] extra allowed Host values from MCP_ALLOWED_HOSTS: ${extraHosts.join(", ")}\n`);
  }
  const allowedHosts = [
    `${cli.host}:${cli.port}`,
    `127.0.0.1:${cli.port}`,
    `localhost:${cli.port}`,
    `[::1]:${cli.port}`,
    cli.host,
    "127.0.0.1",
    "localhost",
    "[::1]",
    ...extraHosts,
  ];

  const httpServer = http.createServer(async (req, res) => {
    const pathname = (() => {
      try {
        return new URL(req.url ?? "/", "http://localhost").pathname;
      } catch {
        return req.url ?? "/";
      }
    })();

    // This local listener is intentionally unauthenticated and loopback-only.
    // Return a real 404 for OAuth Protected Resource Metadata discovery so
    // tunnel-client correctly classifies it as a no-auth MCP target.
    if (
      req.method === "GET" &&
      (pathname === "/.well-known/oauth-protected-resource" ||
        pathname === "/.well-known/oauth-protected-resource/mcp")
    ) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("Not Found");
      return;
    }

    // Apply the same Host/Origin checks to the local settings API and MCP endpoint.
    const host = req.headers.host ?? "";
    if (!allowedHosts.includes(host)) {
      audit({ event: "rejected_host", ok: false, summary: `Host=${host}` });
      process.stderr.write(`[http] rejected Host header: ${host}\n`);
      res.writeHead(403, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ error: "rejected Host header" }));
      return;
    }
    const origin = req.headers.origin;
    if (origin && !allowedHosts.some((h) => [`http://${h}`, `https://${h}`].includes(origin))) {
      audit({ event: "rejected_origin", ok: false, summary: `Origin=${origin}` });
      process.stderr.write(`[http] rejected Origin header: ${origin}\n`);
      res.writeHead(403, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ error: "rejected Origin header" }));
      return;
    }

    if (pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({
        ok: true,
        pid: process.pid,
        name: "chat-unleashed",
        uptime: Math.round(process.uptime()),
        toolCapacity: capacityStatus(),
        http: { active: httpInflight, maxActive: HTTP_MAX_INFLIGHT, peak: httpPeak, rejected: httpRejected, maxBodyBytes: MCP_MAX_BODY, bodyBytes: httpBodyBytes, peakBodyBytes: httpPeakBodyBytes, bodyBudgetBytes: HTTP_BODY_BUDGET },
        memory: process.memoryUsage(),
      }));
      return;
    }

    if (httpInflight >= HTTP_MAX_INFLIGHT) {
      httpRejected += 1;
      res.writeHead(503, { "content-type": "application/json", "retry-after": "1", connection: "close" });
      res.end(JSON.stringify({ error: "server busy", active: httpInflight, maxActive: HTTP_MAX_INFLIGHT }));
      return;
    }
    httpInflight += 1;
    httpPeak = Math.max(httpPeak, httpInflight);
    let released = false;
    let requestBodyBytes = 0;
    const releaseHttp = () => {
      if (released) return;
      released = true;
      httpInflight = Math.max(0, httpInflight - 1);
      httpBodyBytes = Math.max(0, httpBodyBytes - requestBodyBytes);
      requestBodyBytes = 0;
    };
    res.once("finish", releaseHttp);
    res.once("close", releaseHttp);

    if (req.url?.startsWith("/api/")) {
      await handleApi(req, res);
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json", allow: "POST" });
      res.end(JSON.stringify({ error: "MCP Streamable HTTP accepts POST at /" }));
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        const bytes = (chunk as Buffer).length;
        size += bytes;
        requestBodyBytes += bytes;
        httpBodyBytes += bytes;
        httpPeakBodyBytes = Math.max(httpPeakBodyBytes, httpBodyBytes);
        if (size > MCP_MAX_BODY) {
          res.writeHead(413, { "content-type": "application/json", connection: "close" });
          res.end(JSON.stringify({ error: "request body too large", maxBodyBytes: MCP_MAX_BODY }));
          // Stop reading while Node flushes the response before closing this connection.
          req.pause();
          return;
        }
        if (httpBodyBytes > HTTP_BODY_BUDGET) {
          httpRejected += 1;
          res.writeHead(503, { "content-type": "application/json", "retry-after": "1", connection: "close" });
          res.end(JSON.stringify({ error: "request-body memory budget exhausted", bodyBudgetBytes: HTTP_BODY_BUDGET }));
          req.pause();
          return;
        }
        chunks.push(chunk as Buffer);
      }
    } catch (error) {
      audit({ event: "http_request_aborted", ok: false, summary: (error as Error).message });
      if (!res.destroyed && !res.headersSent) {
        res.writeHead(400, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ error: "request aborted while reading body" }));
      }
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid JSON body" }));
      return;
    }

    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      // The SDK matches the Host header and Origin verbatim, including the port.
      allowedHosts,
      allowedOrigins: [
        `http://${cli.host}:${cli.port}`,
        `http://127.0.0.1:${cli.port}`,
        `http://localhost:${cli.port}`,
        `http://[::1]:${cli.port}`,
      ],
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      audit({ event: "http_mcp_error", ok: false, summary: (error as Error).message });
      if (!res.destroyed && !res.headersSent) {
        res.writeHead(500, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ error: "MCP request failed" }));
      } else if (!res.destroyed && !res.writableEnded) {
        res.end();
      }
      void transport.close();
      void server.close();
    }
  });

  // Bound slow/malformed clients. requestTimeout covers receiving the request;
  // long-running tool execution can continue after the body has arrived.
  httpServer.headersTimeout = 30_000;
  httpServer.requestTimeout = 120_000;
  httpServer.keepAliveTimeout = 5_000;
  httpServer.maxHeadersCount = 100;
  httpServer.maxRequestsPerSocket = 1_000;

  httpServer.on("clientError", (err, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(cli.port, cli.host, resolve);
  });

  audit({ event: "server_start", summary: `transport=http url=http://${cli.host}:${cli.port}/` });
  process.stdout.write(
    `Chat Unleashed listening on http://${cli.host}:${cli.port}/ (Streamable HTTP MCP)\n` +
      `health: http://${cli.host}:${cli.port}/health\n`,
  );
  const stop = (signal: "SIGINT" | "SIGTERM") => {
    audit({ event: "server_stop", summary: `signal=${signal}` });
    flushAuditSync();
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((err) => {
  audit({ event: "fatal", ok: false, summary: (err as Error)?.message ?? String(err) });
  process.stderr.write(`fatal: ${(err as Error)?.stack ?? err}\n`);
  process.exit(1);
});