#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(args, { allowNoMatch = false } = {}) {
  const result = spawnSync("/usr/bin/git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (allowNoMatch && result.status === 1) return "";
  if (result.status !== 0) throw new Error((result.stderr || `git ${args.join(" ")} failed`).trim());
  return result.stdout;
}

const commits = git(["rev-list", "--all"]).trim().split("\n").filter(Boolean);
const sensitiveName = /(^|\/)(?:\.env(?:\..+)?|\.npmrc|id_rsa|id_ed25519|[^/]+\.(?:pem|key|p12|pfx))$/i;
const names = git(["log", "--all", "--name-only", "--pretty=format:"])
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

const failures = [];
for (const file of new Set(names)) {
  if (sensitiveName.test(file) && !file.endsWith(".env.example")) {
    failures.push(`${file}: sensitive filename tracked in Git history`);
  }
}

const patterns = [
  "-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----",
  "gh[pousr]_[A-Za-z0-9]{20,}",
  "github_pat_[A-Za-z0-9_]{30,}",
  "sk-[A-Za-z0-9_-]{20,}",
  "xox[baprs]-[A-Za-z0-9-]{20,}",
  "AKIA[0-9A-Z]{16}",
  "tunnel_([a-z0-9]{4}_)?[a-z0-9]{32}",
  "/" + "Users/" + "[^/[:space:]\"'\x60]+/",
  "CONTROL_PLANE_API_KEY[[:space:]]*=[[:space:]]*[\"']?[^\"'[:space:]$<]{16,}",
];

if (commits.length) {
  const args = ["grep", "-n", "-I", "-E"];
  for (const pattern of patterns) args.push("-e", pattern);
  args.push(
    ...commits,
    "--",
    ".",
    ":(exclude)scripts/check-history.mjs",
    ":(exclude)scripts/check-public.mjs",
  );
  const hits = git(args, { allowNoMatch: true }).trim();
  if (hits) failures.push(...hits.split("\n").slice(0, 100));
}

const unique = [...new Set(failures)];
if (unique.length) {
  console.error(`git history hygiene failed (${unique.length}):`);
  for (const failure of unique) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`git history hygiene passed (${commits.length} commits, Git-native content scan)`);
