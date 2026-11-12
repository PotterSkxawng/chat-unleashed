import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

let failures = 0;
function check(name, ok, detail = "") {
  console.log((ok ? "ok  " : "FAIL") + " " + name + (detail ? "  " + detail : ""));
  if (!ok) failures++;
}

async function freePort() {
  const s = net.createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const addr = s.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  await new Promise((resolve) => s.close(resolve));
  return port;
}

function request(port, options, body = "") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, ...options }, (res) => {
      const chunks = [];
      res.on("data", (b) => chunks.push(b));
      res.on("end", () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function partialUpload(port, bytes, declared) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.on("error", reject);
    socket.on("data", (b) => { response += b.toString("utf8"); });
    socket.once("connect", () => {
      socket.write(
        "POST / HTTP/1.1\r\n" +
        "Host: 127.0.0.1:" + port + "\r\n" +
        "Content-Type: application/json\r\n" +
        "Content-Length: " + declared + "\r\n" +
        "Connection: keep-alive\r\n\r\n",
      );
      socket.write(Buffer.alloc(bytes, 0x78), () => resolve({ socket, response: () => response }));
    });
  });
}

const cwd = process.cwd();
const publicBind = spawnSync(process.execPath, [path.join(cwd, "dist/index.js"), "--http", "--host", "0.0.0.0"], {
  cwd,
  encoding: "utf8",
  timeout: 5000,
});
check("unauthenticated HTTP listener refuses non-loopback binds", publicBind.status === 2 && /loopback/i.test(publicBind.stderr), publicBind.stderr.trim());

const port = await freePort();
const child = spawn(process.execPath, [path.join(cwd, "dist/index.js"), "--http", "--port", String(port)], {
  cwd,
  env: { ...process.env, MCP_HTTP_MAX_INFLIGHT: "4", MCP_MAX_BODY_BYTES: String(8 * 1024 * 1024), MCP_HTTP_BODY_BUDGET_BYTES: String(8 * 1024 * 1024) },
  stdio: ["ignore", "pipe", "pipe"],
});
let childLog = "";
child.stdout.on("data", (b) => { childLog += b.toString(); });
child.stderr.on("data", (b) => { childLog += b.toString(); });

try {
  let health;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await request(port, { path: "/health", method: "GET" });
      if (r.status === 200) { health = JSON.parse(r.text); break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 30));
  }
  check("isolated HTTP server starts", Boolean(health), childLog.slice(-500));
  check("health exposes capacity/memory telemetry", health?.http?.maxActive === 4 && health?.toolCapacity?.maxActive >= 1 && health?.memory?.rss > 0);

  const badHost = await request(port, {
    path: "/",
    method: "POST",
    headers: { Host: "evil.invalid", "Content-Type": "application/json", "Content-Length": "4" },
  }, "null");
  check("invalid Host is rejected before MCP handling", badHost.status === 403, "status " + badHost.status);

  const apiBadHost = await request(port, {
    path: "/api/config",
    method: "GET",
    headers: { Host: "invalid.example" },
  });
  check("settings API rejects foreign Host headers", apiBadHost.status === 403, "status " + apiBadHost.status);

  const apiBadOrigin = await request(port, {
    path: "/api/config",
    method: "GET",
    headers: { Origin: "https://invalid.example" },
  });
  check("settings API rejects cross-origin reads", apiBadOrigin.status === 403, "status " + apiBadOrigin.status);

  const apiBadPreflight = await request(port, {
    path: "/api/config/reset",
    method: "OPTIONS",
    headers: { Origin: "https://invalid.example", "Access-Control-Request-Method": "POST" },
  });
  check("settings API rejects cross-origin preflight", apiBadPreflight.status === 403, "status " + apiBadPreflight.status);

  const apiLocal = await request(port, { path: "/api/health", method: "GET" });
  check("same-origin settings API stays accessible", apiLocal.status === 200, "status " + apiLocal.status);

  const held = [];
  for (let i = 0; i < 4; i++) {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    await once(socket, "connect");
    // Under overload the server may reset intentionally incomplete requests.
    socket.on("error", () => {});
    socket.write(
      "POST / HTTP/1.1\r\n" +
      "Host: 127.0.0.1:" + port + "\r\n" +
      "Content-Type: application/json\r\n" +
      "Content-Length: 100000\r\n" +
      "Connection: keep-alive\r\n\r\n{",
    );
    held.push(socket);
  }
  await new Promise((r) => setTimeout(r, 80));
  const overloaded = await request(port, {
    path: "/",
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": "4" },
  }, "null");
  check("HTTP overload returns 503 instead of accepting more work", overloaded.status === 503, "status " + overloaded.status);
  held.forEach((s) => s.destroy());
  await new Promise((r) => setTimeout(r, 100));
  const health2 = await request(port, { path: "/health", method: "GET" });
  const h2 = JSON.parse(health2.text);
  check("held requests release capacity after disconnect", h2.http.active === 0 && h2.http.rejected >= 1, JSON.stringify(h2.http));

  let tooLarge;
  try {
    tooLarge = await request(
      port,
      { path: "/", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": String(9 * 1024 * 1024) } },
      Buffer.alloc(9 * 1024 * 1024, 0x78),
    );
  } catch (error) {
    tooLarge = { status: 0, text: String(error) };
  }
  check("per-request body cap rejects >8MiB", tooLarge.status === 413, "status " + tooLarge.status);

  const bodyA = await partialUpload(port, 6 * 1024 * 1024, 7 * 1024 * 1024);
  await new Promise((r) => setTimeout(r, 80));
  const bodyB = await partialUpload(port, 3 * 1024 * 1024, 4 * 1024 * 1024);
  await new Promise((r) => setTimeout(r, 120));
  // TCP delivery can lag behind the server-side body-budget counter.
  for (let i = 0; i < 40 && !/503 Service Unavailable/.test(bodyB.response()); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const bodyBudgetRejected = /503 Service Unavailable/.test(bodyB.response());
  check("global request-body budget rejects concurrent large uploads", bodyBudgetRejected, bodyB.response().split("\r\n")[0] || "(no response)");
  bodyA.socket.destroy();
  bodyB.socket.destroy();
  await new Promise((r) => setTimeout(r, 120));
  const health3 = await request(port, { path: "/health", method: "GET" });
  const h3 = JSON.parse(health3.text);
  check("large upload disconnects release body budget", h3.http.bodyBytes === 0 && h3.http.active === 0, JSON.stringify(h3.http));
} finally {
  child.kill("SIGINT");
  await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 2000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

if (failures) process.exitCode = 1;
else console.log("http stress: all checks passed");