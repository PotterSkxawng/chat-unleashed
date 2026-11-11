#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const ignoredDirs = new Set(["node_modules", ".git"]);
const textExts = new Set([".ts", ".js", ".mjs", ".cjs", ".json", ".md", ".txt", ".sh", ".toml", ".yaml", ".yml"]);
const forbiddenTop = [
  ".env",
  ".env.tunnel",
  "logs",
  ".ui-evidence",
  ".smoke-home",
  ".smoke-targets",
  ".smoke-tasks",
  ".test",
  ".stress",
];

const failures = [];
for (const name of forbiddenTop) {
  if (fs.existsSync(path.join(root, name))) failures.push(`forbidden release artifact: ${name}`);
}

for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  if (/\.log$/i.test(entry.name)) failures.push(`root log file must not ship: ${entry.name}`);
  if (/^\.(?:patch|tmp|scenario|app-|sdk-|tsc-)/i.test(entry.name)) {
    failures.push(`temporary root file must not ship: ${entry.name}`);
  }
}

const home = os.homedir();
const user = process.env.USER?.trim();
const host = os.hostname();
const personalNeedles = [
  home,
  user && user.length >= 3 ? user : null,
  host && host.length >= 3 ? host : null,
].filter(Boolean);

const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\btunnel_(?:[a-z0-9]{4}_)?[a-z0-9]{32}\b/,
  /CONTROL_PLANE_API_KEY\s*=\s*["']?[^"'\s$<]{16,}/,
];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

for (const file of walk(root)) {
  const rel = path.relative(root, file);
  if (rel.startsWith("dist" + path.sep) && !textExts.has(path.extname(file))) continue;
  if (!textExts.has(path.extname(file)) && ![".gitignore"].includes(rel)) continue;
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }

  if (/\/Users\/[^/\s"'`]+\//.test(text)) failures.push(`${rel}: contains an absolute user-home path`);
  if (/\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/.test(text)) {
    failures.push(`${rel}: contains a private-network address from a specific environment`);
  }
  for (const needle of personalNeedles) {
    if (needle && text.toLowerCase().includes(String(needle).toLowerCase())) {
      failures.push(`${rel}: contains current-machine identifier ${JSON.stringify(needle)}`);
      break;
    }
  }
  for (const pattern of secretPatterns) {
    if (pattern.test(text)) {
      failures.push(`${rel}: matches a secret/private-key pattern`);
      break;
    }
  }
  if ((rel === "README.md" || rel.endsWith(".md")) && text.includes("—")) {
    failures.push(`${rel}: contains an em dash; public copy must pass the antislop text gate`);
  }
}

const unique = [...new Set(failures)];
if (unique.length) {
  console.error(`public release check failed (${unique.length}):`);
  for (const failure of unique) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("public release check passed");
