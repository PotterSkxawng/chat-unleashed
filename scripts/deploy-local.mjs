#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error(`Local Mac requires Apple Silicon macOS (darwin-arm64), not ${process.platform}-${process.arch}.`);
}

const project = path.resolve(import.meta.dirname, "..");
const source = path.join(project, "dist", "index.js");
if (!fs.existsSync(source)) throw new Error("dist/index.js is missing. Run npm run build first.");

const root = process.env.LOCAL_AGENT_RUNTIME_HOME?.trim()
  ? path.resolve(process.env.LOCAL_AGENT_RUNTIME_HOME)
  : path.join(os.homedir(), ".local", "share", "local-agent-mcp");
const target = path.join(root, "dist", "index.js");
const staged = path.join(path.dirname(target), `.index.js.${process.pid}.tmp`);
const previous = `${target}.previous`;
const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
try {
  fs.copyFileSync(source, staged, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(staged, 0o755);
  const expected = digest(source);
  if (digest(staged) !== expected) throw new Error("staged bundle hash does not match the validated source");
  if (fs.existsSync(target)) fs.copyFileSync(target, previous);
  fs.renameSync(staged, target);
  if (digest(target) !== expected) throw new Error("installed bundle hash mismatch after deployment");
  process.stdout.write(`deployed runtime -> ${target}\nsha256: ${expected}\n`);
} finally {
  try { fs.unlinkSync(staged); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
