import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function validBundle(candidate: string): boolean {
  return fs.existsSync(path.join(candidate, "Contents", "Info.plist"));
}

function launchServicesPath(bundleId: string): string | null {
  try {
    const script =
      "ObjC.import('AppKit');" +
      `var u=$.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(${JSON.stringify(bundleId)});` +
      "if (u) console.log(ObjC.unwrap(u.path));";
    const out = execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString("utf8")
      .trim();
    return out && out !== "undefined" && validBundle(out) ? out : null;
  } catch {
    return null;
  }
}

function spotlightPath(bundleId: string): string | null {
  try {
    const query = `kMDItemCFBundleIdentifier == "${bundleId.replace(/"/g, '\\"')}"`;
    const out = execFileSync("/usr/bin/mdfind", [query], {
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString("utf8")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && validBundle(line));
    return out ?? null;
  } catch {
    return null;
  }
}

/** Locate an installed macOS app without assuming a fixed install directory. */
export function findApplicationByBundleId(bundleId: string, candidates: string[] = []): string | null {
  const launchServices = launchServicesPath(bundleId);
  if (launchServices) return launchServices;

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate.replace(/^~(?=\/|$)/, os.homedir()));
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (validBundle(resolved)) return resolved;
  }

  return spotlightPath(bundleId);
}

/** Resolve an app bundle's executable from CFBundleExecutable. */
export function applicationExecutable(appPath: string): string | null {
  try {
    const executable = execFileSync(
      "/usr/bin/plutil",
      ["-extract", "CFBundleExecutable", "raw", "-o", "-", path.join(appPath, "Contents", "Info.plist")],
      { timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] },
    )
      .toString("utf8")
      .trim();
    if (!executable) return null;
    const full = path.join(appPath, "Contents", "MacOS", executable);
    return fs.existsSync(full) ? full : null;
  } catch {
    return null;
  }
}

/** Common app locations used only as fallbacks when Launch Services has no record. */
export function applicationCandidates(...names: string[]): string[] {
  const roots = ["/Applications", path.join(os.homedir(), "Applications"), "/System/Applications"];
  return roots.flatMap((root) => names.map((name) => path.join(root, name)));
}
