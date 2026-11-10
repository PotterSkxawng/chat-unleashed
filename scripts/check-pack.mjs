#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  encoding: "utf8",
  maxBuffer: 8 * 1024 * 1024,
});
const [manifest] = JSON.parse(output);
const paths = new Set((manifest?.files ?? []).map((file) => file.path));
const required = ["dist/index.js", "README.md", "docs/TROUBLESHOOTING.md", "scripts/deploy-local.mjs", "scripts/deferred-update.mjs"];
const forbidden = [...paths].filter((file) => /(^|\/)(\.env[^/]*|logs|\.ui-evidence|\.smoke[^/]*|\.test|\.stress|node_modules)(\/|$)|\.(?:pem|p12|key|sqlite|db|log)$/.test(file));
const missing = required.filter((file) => !paths.has(file));
if (missing.length || forbidden.length) {
  if (missing.length) console.error(`missing package files: ${missing.join(", ")}`);
  if (forbidden.length) console.error(`private/package artifacts: ${forbidden.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log(`package dry run passed (${paths.size} files, no private artifacts)`);
}
