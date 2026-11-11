#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "cli", "chat-unleashed.mjs");
const packageVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const publicBeta = packageVersion.match(/public-beta\.(\d+)$/i);

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 15_000,
  });
}

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok  ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

check("version reports package semver and release channel", () => {
  const result = run(["--version"]);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes(packageVersion));
  if (publicBeta) assert.ok(result.stdout.includes(`Preview (Public Beta ${publicBeta[1]})`));
});

check("help exposes every supported maintenance flag", () => {
  const result = run(["help"]);
  assert.equal(result.status, 0);
  for (const flag of ["--check", "--force", "--fresh", "--stage", "--status", "--cancel", "--verbose", "--json", "--no-color"]) {
    assert.match(result.stdout, new RegExp(flag.replaceAll("-", "\\-")));
  }
});

check("named options work before or after the command", () => {
  assert.equal(run(["--profile", "local-mac", "help"]).status, 0);
  assert.equal(run(["help", "--profile", "local-mac"]).status, 0);
  assert.equal(run(["help", "--profile", "../bad"]).status, 2);
});

check("piped output exits cleanly on EPIPE", () => {
  const result = spawnSync("/bin/zsh", ["-lc", `${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} help | head -n 1 >/dev/null`], {
    cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }, timeout: 15_000,
  });
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, /EPIPE|Unhandled 'error'/);
});

check("default update implementation never stops live services", () => {
  const source = fs.readFileSync(cli, "utf8");
  const start = source.indexOf("async function updateCommand()");
  const end = source.indexOf("// Help / Command Reference", start);
  assert.ok(start >= 0 && end > start);
  const update = source.slice(start, end);
  assert.doesNotMatch(update, /stopServices\s*\(/);
  assert.doesNotMatch(update, /launchctl[^\n]*bootout/);
  assert.match(update, /updaterAction\('stage'\)/);
  assert.match(update, /git', \['pull', '--ff-only'/);
});

check("setup validates platform and minimum Node before installation", () => {
  const source = fs.readFileSync(cli, "utf8");
  assert.match(source, /supportedPlatform\(\)/);
  assert.match(source, /nodeSupported\(\)/);
  assert.match(source, /Node\.js 20\.11\.1 or newer required/);
});

if (!process.exitCode) console.log(`CLI safety: ${passed} checks passed`);
