// Verification vocabulary.
//
// A step is only done when a check says so. Checks are declarative so they can
// be stored inside a task file, replayed later, and reported with the evidence
// that produced the verdict. One shape covers shell commands, files, window
// titles, accessibility text, other tools, and polling until a condition holds.
import fs from "node:fs";
import { resolveUserPath } from "./config.js";
import { uiNodes, windowList } from "./computer.js";
import { run, sh, truncate } from "./exec.js";
import { qaPdf } from "./docqa.js";
import { handlerFor, toolCanVerify, type ToolOutcome } from "./registry.js";

export type CheckKind = "shell" | "file" | "absent" | "windowTitle" | "uiText" | "tool" | "wait" | "pdf";

export interface CheckSpec {
  kind: CheckKind;
  /** shell: the command. wait: the condition is the nested check. */
  cmd?: string;
  cwd?: string;
  /** file / absent: path to test. */
  path?: string;
  /** windowTitle / uiText / shell output: regular expression, case-insensitive. */
  pattern?: string;
  /** windowTitle / uiText: limit to one app. */
  app?: string;
  /** tool: which registered tool to call, and with what args. */
  tool?: string;
  args?: Record<string, unknown>;
  /** tool / shell: extra regular expression the result must match. */
  expect?: string;
  /** wait: the condition to poll, reusing any other kind. */
  until?: CheckSpec;
  /** wait: how long to keep polling. Default 30. */
  seconds?: number;
  /** pdf: expected page count, when the count matters. */
  pages?: number;
}

export interface CheckResult {
  ok: boolean;
  detail: string;
  waitedMs: number;
}

export type CheckToolExecutor = (
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number,
) => Promise<ToolOutcome>;

function regex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

function oneLine(value: string, limit = 220): string {
  return truncate(value.replace(/\s+/g, " ").trim(), limit);
}

async function checkOnce(
  spec: CheckSpec,
  executeTool?: CheckToolExecutor,
  toolTimeoutMs = 120_000,
): Promise<{ ok: boolean; detail: string }> {
  switch (spec.kind) {
    case "shell": {
      if (!spec.cmd) return { ok: false, detail: "shell check needs cmd" };
      const result = await sh(spec.cmd, { cwd: spec.cwd ? resolveUserPath(spec.cwd) : undefined, timeoutMs: toolTimeoutMs });
      const output = `${result.out}\n${result.err}`.trim();
      if (!result.ok) return { ok: false, detail: `exit ${result.code}: ${oneLine(output)}` };
      const wanted = spec.pattern ?? spec.expect;
      if (wanted) {
        const re = regex(wanted);
        if (!re) return { ok: false, detail: `invalid pattern ${JSON.stringify(wanted)}` };
        return re.test(output)
          ? { ok: true, detail: `exit 0 and output matched /${wanted}/` }
          : { ok: false, detail: `exit 0 but output did not match /${wanted}/: ${oneLine(output)}` };
      }
      return { ok: true, detail: `exit 0${output ? `: ${oneLine(output)}` : ""}` };
    }
    case "file": {
      if (!spec.path) return { ok: false, detail: "file check needs path" };
      const target = resolveUserPath(spec.path);
      if (!fs.existsSync(target)) return { ok: false, detail: `missing: ${target}` };
      const size = fs.statSync(target).size;
      if (size === 0) return { ok: false, detail: `empty file: ${target}` };
      return { ok: true, detail: `${target} (${size} bytes)` };
    }
    case "absent": {
      if (!spec.path) return { ok: false, detail: "absent check needs path" };
      const target = resolveUserPath(spec.path);
      return fs.existsSync(target) ? { ok: false, detail: `still present: ${target}` } : { ok: true, detail: `gone: ${target}` };
    }
    case "windowTitle": {
      const listed = await windowList({ app: spec.app, includeOffscreen: true });
      if (!listed.ok) return { ok: false, detail: oneLine(listed.message) };
      const titles = listed.windows.map((w) => `${w.app} ${w.title}`).join("\n");
      if (!spec.pattern) return { ok: false, detail: "windowTitle check needs pattern" };
      const re = regex(spec.pattern);
      if (!re) return { ok: false, detail: `invalid pattern ${JSON.stringify(spec.pattern)}` };
      return re.test(titles)
        ? { ok: true, detail: `a window title matched /${spec.pattern}/` }
        : { ok: false, detail: `no window title matched /${spec.pattern}/ (${listed.windows.length} window(s))` };
    }
    case "uiText": {
      if (!spec.pattern) return { ok: false, detail: "uiText check needs pattern" };
      const tree = await uiNodes({ app: spec.app, depth: 10, maxNodes: 900 });
      if (!tree.ok) return { ok: false, detail: oneLine(tree.error ?? "no accessibility tree") };
      const text = tree.nodes
        .map((n) => [n.title, n.description, n.value].filter(Boolean).join(" "))
        .filter(Boolean)
        .join("\n");
      const re = regex(spec.pattern);
      if (!re) return { ok: false, detail: `invalid pattern ${JSON.stringify(spec.pattern)}` };
      return re.test(text)
        ? { ok: true, detail: `interface text matched /${spec.pattern}/` }
        : { ok: false, detail: `no interface text matched /${spec.pattern}/ (${tree.nodes.length} node(s) read)` };
    }
    case "tool": {
      if (!spec.tool) return { ok: false, detail: "tool check needs tool" };
      if (!toolCanVerify(spec.tool, spec.args ?? {})) {
        return { ok: false, detail: `tool check refuses action that is not verification-safe: ${spec.tool}` };
      }
      const handler = handlerFor(spec.tool);
      if (!handler) return { ok: false, detail: `unknown tool ${spec.tool}` };
      const result = executeTool
        ? await executeTool(spec.tool, spec.args ?? {}, toolTimeoutMs)
        : await handler(spec.args ?? {});
      if (!result.ok) return { ok: false, detail: `${spec.tool} failed: ${oneLine(result.message)}` };
      if (spec.expect) {
        const re = regex(spec.expect);
        if (!re) return { ok: false, detail: `invalid pattern ${JSON.stringify(spec.expect)}` };
        return re.test(result.message)
          ? { ok: true, detail: `${spec.tool} matched /${spec.expect}/` }
          : { ok: false, detail: `${spec.tool} succeeded but did not match /${spec.expect}/: ${oneLine(result.message)}` };
      }
      return { ok: true, detail: `${spec.tool}: ${oneLine(result.message)}` };
    }
    case "wait": {
      if (!spec.until) return { ok: false, detail: "wait check needs until" };
      return checkOnce(spec.until, executeTool, toolTimeoutMs);
    }
    case "pdf": {
      if (!spec.path) return { ok: false, detail: "pdf check needs path" };
      let report;
      try {
        report = await qaPdf({ file: spec.path });
      } catch (error) {
        return { ok: false, detail: oneLine((error as Error).message) };
      }
      if (report.pages === 0) return { ok: false, detail: "the PDF has no pages" };
      if (spec.pages !== undefined && report.pages !== spec.pages) {
        return { ok: false, detail: `expected ${spec.pages} page(s), the PDF has ${report.pages}` };
      }
      if (report.problems.length) {
        return {
          ok: false,
          detail: `${report.problems.length} page problem(s): ${report.problems.slice(0, 3).join("; ")}`,
        };
      }
      return {
        ok: true,
        detail: `${report.pages} page(s) rendered cleanly (${report.totals.chars} characters, no empty, clipped or crowded pages)`,
      };
    }
    default:
      return { ok: false, detail: `unknown check kind ${String(spec.kind)}` };
  }
}

/** Runs a check, polling when the kind is `wait` or a timeout is supplied. */
export async function runCheck(
  spec: CheckSpec,
  timeoutSeconds = 0,
  executeTool?: CheckToolExecutor,
): Promise<CheckResult> {
  const started = Date.now();
  const limit = (spec.kind === "wait" ? (spec.seconds ?? 30) : timeoutSeconds) * 1000;
  const defaultAttemptMs = 120_000;
  let last: { ok: boolean; detail: string } = { ok: false, detail: "not run" };
  do {
    const elapsed = Date.now() - started;
    const remaining = limit > 0 ? Math.max(100, limit - elapsed) : defaultAttemptMs;
    const attemptTimeoutMs = Math.min(defaultAttemptMs, remaining);
    last = await checkOnce(spec, executeTool, attemptTimeoutMs);
    if (last.ok) return { ok: true, detail: last.detail, waitedMs: Date.now() - started };
    if (limit <= 0 || Date.now() - started >= limit) break;
    const sleepMs = Math.min(300, Math.max(0, limit - (Date.now() - started)));
    if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
  } while (true);
  return { ok: false, detail: last.detail, waitedMs: Date.now() - started };
}

export function describeCheck(spec: CheckSpec): string {
  switch (spec.kind) {
    case "shell":
      return `shell: ${spec.cmd ?? ""}${spec.pattern ? ` matching /${spec.pattern}/` : ""}`;
    case "file":
      return `file exists: ${spec.path ?? ""}`;
    case "absent":
      return `file absent: ${spec.path ?? ""}`;
    case "windowTitle":
      return `window title matching /${spec.pattern ?? ""}/${spec.app ? ` in ${spec.app}` : ""}`;
    case "uiText":
      return `interface text matching /${spec.pattern ?? ""}/${spec.app ? ` in ${spec.app}` : ""}`;
    case "tool":
      return `tool ${spec.tool ?? ""}${spec.expect ? ` matching /${spec.expect}/` : ""} succeeds`;
    case "wait":
      return `wait up to ${spec.seconds ?? 30}s until ${spec.until ? describeCheck(spec.until) : "(no condition)"}`;
    case "pdf":
      return `rendered PDF ${spec.path ?? ""} has no blank, clipped or crowded pages${spec.pages ? ` and ${spec.pages} pages` : ""}`;
    default:
      return String(spec.kind);
  }
}

/** Small helper for the `open` step type: a URL or path opened with the OS. */
export async function openPath(target: string, app?: string): Promise<{ ok: boolean; detail: string }> {
  const args = app ? ["-a", app, resolveUserPath(target)] : [resolveUserPath(target)];
  const result = await run("/usr/bin/open", args, { timeoutMs: 30_000 });
  return result.ok
    ? { ok: true, detail: `opened ${target}${app ? ` with ${app}` : ""}` }
    : { ok: false, detail: oneLine(result.err || result.out) };
}
