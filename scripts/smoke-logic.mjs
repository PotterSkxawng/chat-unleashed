#!/usr/bin/env node
// Unit checks for the decision logic behind the planner, the browser locators,
// the coding helpers and the skill router.
//
//   node scripts/smoke-logic.mjs
//
// These run against the modules themselves, not the bundle, so a failure names the
// function that broke. Build them first with:
//   npx esbuild src/targeting.ts src/web.ts src/coding.ts src/skills.ts --bundle --platform=node --format=esm --outdir=.test
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const load = async (name) => import(path.join(root, ".test", `${name}.js`));

const targeting = await load("targeting");
const web = await load("web");
const coding = await load("coding");
const skills = await load("skills");
const audit = await load("audit");
const config = await load("config");
const ws = await load("ws");
const orchestrator = await load("orchestrator");

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

const sanitized = audit.sanitizeAuditArgs({
  env: { PATH: "/usr/bin", OPENAI_API_KEY: "sk" + "-" + "example-secret-value-that-must-not-log" },
  authorization: "Bearer top-secret-value-123456789",
  nested: { token: "abc" + "123456789", note: "safe" },
  command: "curl 'https://example.test/?api_key=supersecretvalue'",
  text: "private text typed into an app",
  body: "private note body",
});
const sanitizedConfig = audit.sanitizeAuditArgs({ action: "set", key: "integrations.secrets.example", value: "very-secret-value" });
const sanitizedText = JSON.stringify({ sanitized, sanitizedConfig });
check("audit redacts environment values", sanitized.env.PATH === "[REDACTED]" && sanitized.env.OPENAI_API_KEY === "[REDACTED]");
check("audit redacts secret-named fields", sanitized.authorization === "[REDACTED]" && sanitized.nested.token === "[REDACTED]");
check("audit redacts private content fields", String(sanitized.text).startsWith("[REDACTED CONTENT") && String(sanitized.body).startsWith("[REDACTED CONTENT"));
check("audit redacts config values at secret paths", sanitizedConfig.value === "[REDACTED]");
check("audit redacts secrets embedded in strings", !sanitizedText.includes("supersecretvalue") && !sanitizedText.includes("very-secret-value") && sanitizedText.includes("[REDACTED]"));

check("config rejects unknown settings", (() => {
  try { config.mergeConfig(config.defaultConfig(), { madeUpSetting: true }); return false; } catch { return true; }
})());
check("config keeps free-form integration secret names", (() => {
  const merged = config.mergeConfig(config.defaultConfig(), { integrations: { secrets: { exampleService: "x" } } });
  return merged.integrations.secrets.exampleService === "x";
})());

const saveButton = { role: "AXButton", title: "Save", path: "0.2.1", actions: ["AXPress"], enabled: true, position: { x: 10, y: 10 }, size: { width: 60, height: 24 }, depth: 3 };
const saveLabel = { role: "AXStaticText", title: "Save", path: "0.2.0", depth: 4 };
const saveItem = { role: "AXMenuItem", title: "Save", path: "3.1", actions: [], enabled: true, depth: 5 };
const nameless = { role: "AXButton", title: "", description: "", path: "9", actions: [], position: { x: 0, y: 0 }, size: { width: 0, height: 0 }, depth: 2 };

const ranked = targeting.rankCandidates([saveLabel, saveItem, saveButton], { name: "save", role: "AXButton" });
check("exact title match is found", ranked.length === 1 && ranked[0].node.path === "0.2.1", ranked.length ? `path ${ranked[0].node.path}` : "no hits");
check("role filter excludes a static text label", !ranked.some((candidate) => candidate.node.role === "AXStaticText"));
check("a pressable element scores above a plain label", (() => {
  const both = targeting.rankCandidates([saveLabel, saveButton], { name: "save" });
  return both[0].node.role === "AXButton";
})());
check("a missing name returns nothing", targeting.rankCandidates([saveLabel, saveButton], { name: "Delete" }).length === 0);

const capsAX = { accessible: true, scriptable: true, shortcuts: { save: ["cmd", "s"] }, commands: {} };
const capsNoAX = { accessible: false, scriptable: true, shortcuts: { save: ["cmd", "s"] }, commands: {} };
const capsScript = { accessible: false, scriptable: true, shortcuts: {}, commands: { "new document": 'tell application "Pages" to make new document' } };

const planAX = targeting.chooseMethod(saveButton, { app: "Pages", capabilities: capsAX });
check("a pressable element plans an accessibility press", planAX.method === "ax_press" && planAX.confidence === "high", planAX.method);
check("an accessibility press keeps a fallback", planAX.fallbacks.includes("pointer_click"));

const planShortcut = targeting.chooseMethod(saveItem, { app: "Pages", intent: "save", capabilities: capsNoAX });
check("without accessibility the planner uses the shortcut", planShortcut.method === "shortcut" && planShortcut.keys.join("+") === "cmd+s", planShortcut.method);

const planScript = targeting.chooseMethod(saveItem, { app: "Pages", intent: "new document", capabilities: capsScript });
check("a scriptable app gets its scripting command before geometry", planScript.method === "applescript_command" && /make new document/.test(planScript.script ?? ""), planScript.method);

const boundedItem = { role: "AXMenuItem", title: "Save", path: "3.1", actions: [], enabled: true, position: { x: 100, y: 50 }, size: { width: 80, height: 20 } };
const planClick = targeting.chooseMethod(boundedItem, { app: "Preview", capabilities: { accessible: false, scriptable: false, shortcuts: {} } });
check("geometry is the last resort", planClick.method === "pointer_click" && planClick.point?.x === 140 && planClick.point?.y === 60, JSON.stringify(planClick.point));

const planNone = targeting.chooseMethod(nameless, { app: "Preview", capabilities: { accessible: false, scriptable: false, shortcuts: {} } });
check("an element with no bounds reports blocked instead of guessing", planNone.method === "none" && Boolean(planNone.blocked));

const planValue = targeting.chooseMethod(
  { role: "AXTextField", title: "Name", path: "1.2", actions: ["AXPress"], enabled: true },
  { app: "Notes", capabilities: capsAX, value: "Report" },
);
check("a fillable field plans a direct value set", planValue.method === "ax_set_value" && planValue.confidence === "high");

const dialogNodes = [
  { role: "AXWindow", title: "Terminal wants to control System Events", path: "0" },
  { role: "AXSheet", title: "Terminal wants to control System Events", path: "0.4" },
  { role: "AXButton", title: "OK", path: "0.4.0" },
];
const flags = targeting.detectState(dialogNodes);
check("a permission prompt is recognised", flags.dialog && flags.permissionPrompt, JSON.stringify({ dialog: flags.dialog, permissionPrompt: flags.permissionPrompt }));
check("the modal is reported with its path", flags.modals[0]?.path === "0.4");

const loading = targeting.detectState([{ role: "AXProgressIndicator", path: "2" }, { role: "AXStaticText", title: "Opening document", path: "3" }]);
check("a loading state is recognised", loading.loading);

const changed = targeting.verifyTransition(
  { title: "Untitled", thumbprint: "aaa", flags: { dialog: false, permissionPrompt: false, loading: false, menuOpen: false, modals: [] } },
  { title: "Saved", thumbprint: "bbb", flags: { dialog: false, permissionPrompt: false, loading: false, menuOpen: false, modals: [] } },
  planAX,
);
check("a title change verifies the action", changed.verified && !changed.weak, changed.evidence.join("; "));

const same = targeting.verifyTransition({ title: "A", thumbprint: "x" }, { title: "A", thumbprint: "x" }, planAX);
check("no change means not verified", !same.verified);

const pixelOnly = targeting.verifyTransition({ title: "A", thumbprint: "x" }, { title: "A", thumbprint: "y" }, planAX);
check("pixels alone are reported as weak evidence", pixelOnly.verified && pixelOnly.weak);

const vanishing = targeting.verifyTransition({ title: "A", nodes: [saveButton] }, { title: "A", nodes: [] }, { ...planAX, path: "0.2.1" });
check("a pressed element that disappears counts as verified", vanishing.verified && vanishing.evidence.some((line) => line.includes("no longer present")));

check("css locator is recognised", web.parseLocator("#main").kind === "css");
check("text locator is the default", web.parseLocator("Save").kind === "text" && web.parseLocator("Save").value === "Save");
check("role locator keeps its value", (() => { const loc = web.parseLocator("role=button"); return loc.kind === "role" && loc.value === "button"; })());
check("xpath locator survives", web.parseLocator("xpath=//button[1]").kind === "xpath");
check("a dotted class is treated as css", web.parseLocator(".toolbar-item").kind === "css");

async function localSocketServer(onRequest) {
  const server = net.createServer((socket) => {
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk.toString("latin1");
      if (request.includes("\r\n\r\n")) onRequest(socket, request);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

const missingAcceptServer = await localSocketServer((socket) => {
  socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
});
const missingAcceptRejected = await ws.MiniSocket.connect(`ws://127.0.0.1:${missingAcceptServer.port}/devtools`).then(
  (socket) => { socket.close(); return false; },
  () => true,
);
missingAcceptServer.server.close();
check("websocket handshake requires Sec-WebSocket-Accept", missingAcceptRejected);

const hugeHandshakeServer = await localSocketServer((socket) => {
  socket.write("HTTP/1.1 101 Switching Protocols\r\nX-Fill: " + "a".repeat(70 * 1024));
});
const hugeHandshakeRejected = await ws.MiniSocket.connect(`ws://127.0.0.1:${hugeHandshakeServer.port}/devtools`).then(
  (socket) => { socket.close(); return false; },
  () => true,
);
hugeHandshakeServer.server.close();
check("websocket handshake memory is bounded", hugeHandshakeRejected);

const oversizedFrameServer = await localSocketServer((socket, request) => {
  const key = /Sec-WebSocket-Key:\s*(\S+)/i.exec(request)?.[1] ?? "";
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  setTimeout(() => {
    const header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(64 * 1024 * 1024 + 1), 2);
    socket.write(header);
  }, 30);
});
const oversizedSocket = await ws.MiniSocket.connect(`ws://127.0.0.1:${oversizedFrameServer.port}/devtools`);
const oversizedError = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(""), 1000);
  oversizedSocket.onError((error) => { clearTimeout(timer); resolve(error.message); });
});
oversizedSocket.close();
oversizedFrameServer.server.close();
check("websocket frames have a hard size cap", /frame exceeds/.test(String(oversizedError)), String(oversizedError));

const hardHangDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "cu-hard-hang-"));
const hardHangWorker = path.join(hardHangDir, "worker.mjs");
fs.writeFileSync(
  hardHangWorker,
  [
    'import readline from "node:readline";',
    'const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
    'for await (const line of input) {',
    '  if (!line.trim()) continue;',
    '  while (true) {}',
    '}',
  ].join("\n"),
);
const oldWorkerEntry = process.env.CHAT_UNLEASHED_TASK_WORKER_ENTRY;
process.env.CHAT_UNLEASHED_TASK_WORKER_ENTRY = hardHangWorker;
const hardHangStarted = Date.now();
let hardHangError = "";
try {
  await orchestrator.withIsolatedToolWorker(async (executeTool) => {
    await executeTool("non_yielding_test_handler", {}, 500);
  });
} catch (error) {
  hardHangError = error.message;
} finally {
  if (oldWorkerEntry === undefined) delete process.env.CHAT_UNLEASHED_TASK_WORKER_ENTRY;
  else process.env.CHAT_UNLEASHED_TASK_WORKER_ENTRY = oldWorkerEntry;
  fs.rmSync(hardHangDir, { recursive: true, force: true });
}
const hardHangElapsed = Date.now() - hardHangStarted;
check(
  "hard deadline kills a non-yielding in-process handler",
  /hard task deadline/.test(hardHangError) && hardHangElapsed >= 400 && hardHangElapsed < 2_500,
  String(hardHangElapsed) + "ms",
);


const tsSymbols = coding.parseSymbols(
  ["export function runTask(id: string) {", "class Task {", "  private helper() {", "export interface Step {", "type Kind = 'a' | 'b';", "const LIMIT = 5;"].join("\n"),
  "typescript",
  "tasks.ts",
);
check("typescript declarations are indexed", tsSymbols.some((hit) => hit.name === "runTask" && hit.line === 1), tsSymbols.map((hit) => hit.name).join(","));
check("interfaces and types are indexed", tsSymbols.some((hit) => hit.name === "Step") && tsSymbols.some((hit) => hit.name === "Kind"));
check("an indented method is not mistaken for a declaration", !tsSymbols.some((hit) => hit.name === "helper"));

const swiftSymbols = coding.parseSymbols(
  ["public func forward(_ x: Tensor) -> Tensor {", "@MainActor final class Trainer {", "    private func step() {", "struct Batch {", "protocol Model {"].join("\n"),
  "swift",
  "Trainer.swift",
);
check("swift declarations are indexed", swiftSymbols.some((hit) => hit.name === "forward") && swiftSymbols.some((hit) => hit.name === "Trainer"), swiftSymbols.map((hit) => hit.name).join(","));
check("swift protocol is indexed", swiftSymbols.some((hit) => hit.kind === "protocol" && hit.name === "Model"));

const kernelSymbols = coding.parseSymbols(["kernel void add_arrays(device const float *a) {"].join("\n"), "metal", "add.metal");
check("metal kernels are indexed", kernelSymbols.some((hit) => hit.kind === "kernel" && hit.name === "add_arrays"));

const stack = coding.detectStack(["package.json", "src/index.ts", "src/tool.metal"], (file) =>
  file === "package.json" ? JSON.stringify({ scripts: { test: "npm test", bench: "node bench.mjs" }, dependencies: { hono: "4" } }) : undefined,
);
check("stack detection reads the manifest", stack.language === "javascript" && stack.frameworks.includes("hono"), JSON.stringify(stack.frameworks));
check("a bench script becomes the benchmark command", stack.benchmarkCommand === "npm run bench", stack.benchmarkCommand ?? "none");
check("metal is noticed alongside javascript", stack.frameworks.includes("metal"));

const at = (value, iso) => ({ name: "bolt", channel: "kernel", metric: "ms_per_token", value, at: iso, device: "M3" });
const regressed = coding.compareBenchmarks([at(10, "2026-01-01"), at(14, "2026-01-02")], "bolt", 5);
check("a slower kernel time is a regression", regressed[0].verdict === "regression", JSON.stringify(regressed[0]));
const improved = coding.compareBenchmarks([at(14, "2026-01-01"), at(10, "2026-01-02")], "bolt", 5);
check("a faster kernel time is an improvement", improved[0].verdict === "improvement");
const mixed = coding.compareBenchmarks(
  [at(10, "2026-01-01"), at(12, "2026-01-02"), { name: "bolt", channel: "model", metric: "ms_per_token", value: 400, at: "2026-01-01" }, { name: "bolt", channel: "model", metric: "ms_per_token", value: 420, at: "2026-01-02" }],
  "bolt",
  5,
);
check("channels are compared separately", mixed.length === 2 && mixed.some((item) => item.channel === "model"), mixed.map((item) => `${item.channel}:${item.verdict}`).join(","));
check("a single sample reports no baseline", coding.compareBenchmarks([at(10, "2026-01-01")], "bolt")[0].verdict === "no-baseline");

const resources = await coding.assessResources();
check("resource check reports the machine", typeof resources.load === "number" && resources.cores > 0 && typeof resources.note === "string", resources.note);

check("a new skill's rate is smoothed, not perfect", Math.abs(skills.successRate({ runs: 0, passed: 0, failed: 0, totalMs: 0 }) - 0.5) < 0.0001);
check("one pass does not read as certainty", skills.successRate({ runs: 1, passed: 1, failed: 0, totalMs: 0 }) < 0.8);

const veteran = skills.normalizeSkill({ id: "skill_old", name: "Export a page as PDF", when: ["export pdf", "pages pdf"], stats: { runs: 10, passed: 9, failed: 1, totalMs: 1000 } });
const rookie = skills.normalizeSkill({ id: "skill_new", name: "Export a page as PDF", when: ["export pdf", "pages pdf"], stats: { runs: 0, passed: 0, failed: 0, totalMs: 0 } });
const unrelated = skills.normalizeSkill({ id: "skill_x", name: "Rename files", when: ["rename batch"], stats: { runs: 10, passed: 10, failed: 0, totalMs: 900 } });

const matches = skills.matchSkills("export pdf from pages to send", [rookie, unrelated, veteran]);
check("a matching skill is returned", matches.length > 0 && matches.every((match) => match.skill.id !== "skill_x"));
check("history breaks a tie between identical skills", matches[0].skill.id === "skill_old", matches.map((match) => `${match.skill.id}:${match.score}`).join(","));
check("an unrelated skill is not returned for another request", skills.matchSkills("rename batch of photos", [veteran, unrelated])[0].skill.id === "skill_x");
check("a request with no overlap returns nothing", skills.matchSkills("book a flight", [veteran]).length === 0);

const compiled = skills.compileSkill(veteran, {});
check("a compiled skill keeps its acceptance criteria", compiled.title === veteran.name && compiled.steps === veteran.steps);
check("skill ids reject path traversal", (() => {
  try { skills.normalizeSkill({ id: "../escape", name: "unsafe" }); return false; } catch { return true; }
})());
check("goal ids reject path traversal", (() => {
  try { coding.goalHistory("../escape"); return false; } catch { return true; }
})());

const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "lap-logic-"));
fs.writeFileSync(path.join(dir, "a.ts"), "export function alpha() {}\nexport class Beta {}\n");
const index = await coding.indexRepo({ root: dir });
check("indexing a folder records symbols", index.symbols === 2 && index.files >= 1, `${index.files} files, ${index.symbols} symbols`);
const found = await coding.findSymbols({ root: dir, query: "beta" });
check("symbol search is case insensitive", found.hits.length === 1 && found.hits[0].name === "Beta");
fs.writeFileSync(path.join(dir, "todo.ts"), "// TODO: first\n// FIXME: second\nexport const done = true;\n");
const summary = await coding.projectSummary(dir);
check("project summary counts real TODO/FIXME markers", summary.todos === 2, `count ${summary.todos}`);
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
for (const module of ["targeting", "web", "coding", "skills", "audit", "config", "ws", "orchestrator"]) {
  fs.rmSync(path.join(root, ".test", `${module}.js`), { force: true });
}
try { fs.rmdirSync(path.join(root, ".test")); } catch {}
process.exit(fail ? 1 : 0);
