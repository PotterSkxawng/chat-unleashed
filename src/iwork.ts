// Cross-app iWork operations.
//
// Pages, Numbers and Keynote share one object model: documents hold shapes,
// images, text items, tables, charts, movies and lines, and every one of those
// is an `iWork item` with position, width, height, rotation and opacity. The
// only real difference is where a document keeps its content:
//
//   Pages    -> the document itself (body text, sections, pages)
//   Numbers  -> sheets, each holding tables
//   Keynote  -> slides
//
// So `containerExpr()` below is the single place that knows about that
// difference, and everything else here is written once for all three apps.
import fs from "node:fs";
import path from "node:path";
import {
  APP_KEYS,
  IWORK_APPS,
  US,
  RS,
  appForName,
  appForPath,
  appScript,
  appVersion,
  asLit,
  bad,
  colorList,
  explainFailure,
  failed,
  findAppPath,
  hexToApple,
  isAppRunning,
  ok,
  parseRecords,
  requireApp,
  resolveTarget,
  resolveUserPath,
  runAppleScript,
  type AppDef,
  type AppKey,
  type Result,
} from "./applescript.js";

/** Narrowing helper for pickApp's return type. */
function isErr(value: AppDef | Result): value is Result {
  return (value as Result).ok !== undefined && typeof (value as Result).message === "string";
}

/** Resolve an app from an explicit name or from the document's extension. */
function pickApp(appName?: string, docPath?: string): AppDef | Result {
  if (appName) {
    const app = appForName(appName);
    if (!app) return bad(`ERROR: unknown app "${appName}". Use one of: pages, numbers, keynote.`);
    return app;
  }
  if (docPath) {
    const app = appForPath(docPath);
    if (!app) return bad(`ERROR: cannot tell which app opens ${docPath}. Pass app explicitly.`);
    return app;
  }
  return bad("ERROR: pass `app` (pages/numbers/keynote) or `path` to a document so the app can be inferred.");
}

/** The AppleScript expression naming the container that holds a document's objects. */
function containerExpr(app: AppDef, slide?: number, sheet?: number): string {
  if (app.key === "keynote") return `slide ${slide ?? 1} of doc`;
  if (app.key === "numbers") return `sheet ${sheet ?? 1} of doc`;
  return "doc";
}

function containerLabel(app: AppDef, slide?: number, sheet?: number): string {
  if (app.key === "keynote") return `slide ${slide ?? 1}`;
  if (app.key === "numbers") return `sheet ${sheet ?? 1}`;
  return "document";
}

// --- iwork_apps ------------------------------------------------------------

export interface AppsOptions {
  includeDocuments?: boolean;
}

export async function iworkApps(opts: AppsOptions = {}): Promise<Result> {
  const includeDocs = opts.includeDocuments !== false;
  const lines: string[] = [];

  for (const key of APP_KEYS) {
    const app = IWORK_APPS[key];
    const appPath = findAppPath(app);
    if (!appPath) {
      lines.push(`${app.label.padEnd(9)} not installed`);
      continue;
    }
    const running = await isAppRunning(app);
    const version = appVersion(appPath);

    if (!running) {
      lines.push(`${app.label.padEnd(9)} ${version.padEnd(7)} not running`);
      continue;
    }
    if (!includeDocs) {
      lines.push(`${app.label.padEnd(9)} ${version.padEnd(7)} running`);
      continue;
    }

    // Only query an app that is already running - telling a stopped app to count
    // its documents would launch it, and launching apps is not our call.
    const script = [
      `with timeout of 60 seconds`,
      `  tell application id "${app.bundleId}"`,
      `  set out to ""`,
      `  repeat with d in documents`,
      `    set p to ""`,
      `    try`,
      `      set p to POSIX path of (file of d)`,
      `    end try`,
      `    set out to out & (name of d) & (ASCII character 30) & p & (ASCII character 31)`,
      `  end repeat`,
      `  return out`,
      `  end tell`,
      `end timeout`,
    ].join("\n");

    const res = await runAppleScript(script, 70_000);
    if (!res.ok) {
      lines.push(`${app.label.padEnd(9)} ${version.padEnd(7)} running (documents unreadable: ${res.code ?? "error"})`);
      continue;
    }
    const docs = parseRecords(res.out);
    lines.push(`${app.label.padEnd(9)} ${version.padEnd(7)} running, ${docs.length} document(s)`);
    for (const [name, filePath] of docs) {
      lines.push(`  - ${name}${filePath ? `  ${filePath}` : "  (unsaved)"}`);
    }
  }

  return ok(`iWork apps on this Mac:\n${lines.join("\n")}`);
}

// --- iwork_document --------------------------------------------------------

export interface DocInfoOptions {
  app?: string;
  path?: string;
}

export async function iworkDocument(opts: DocInfoOptions): Promise<Result> {
  const picked = pickApp(opts.app, opts.path);
  if (isErr(picked)) return picked;
  const app = picked;
  const missing = requireApp(app);
  if (missing) return missing;

  const target = opts.path ? resolveTarget(opts.path) : null;
  if (target && failed(target)) return target;

  const body: string[] = [
    `  set out to ""`,
    `  set docName to name of doc`,
    `  set docPath to ""`,
    `  try`,
    `    set docPath to POSIX path of (file of doc)`,
    `  end try`,
  ];

  const count = (varName: string, expr: string) =>
    body.push(`  set ${varName} to 0`, `  try`, `    set ${varName} to count of ${expr}`, `  end try`);

  if (app.key === "pages") {
    count("nParas", "paragraphs of body text of doc");
    count("nPages", "pages of doc");
    count("nSections", "sections of doc");
  }
  if (app.key === "numbers") count("nSheets", "sheets of doc");
  if (app.key === "keynote") count("nSlides", "slides of doc");

  count("nTables", "tables of doc");
  count("nShapes", "shapes of doc");
  count("nImages", "images of doc");
  count("nTextItems", "text items of doc");
  count("nCharts", "charts of doc");
  count("nMovies", "movies of doc");
  count("nLines", "lines of doc");

  // Numbers keeps tables on sheets, so the document-level count is often zero.
  if (app.key === "numbers") {
    body.push(
      `  try`,
      `    set nTables to 0`,
      `    repeat with s in sheets of doc`,
      `      set nTables to nTables + (count of tables of s)`,
      `    end repeat`,
      `  end try`,
    );
  }

  const fields = ["docName", "docPath"];
  if (app.key === "pages") fields.push("nParas", "nPages", "nSections");
  if (app.key === "numbers") fields.push("nSheets");
  if (app.key === "keynote") fields.push("nSlides");
  fields.push("nTables", "nShapes", "nImages", "nTextItems", "nCharts", "nMovies", "nLines");

  body.push(`  return ${fields.map((f) => `(${f} as text)`).join(` & (ASCII character 30) & `)}`);

  const res = await runAppleScript(appScript(app, target as string | null, body), 130_000);
  if (!res.ok) return bad(explainFailure(res, app.label));

  const f = res.out.split(US);
  const labels = ["name", "path"];
  if (app.key === "pages") labels.push("paragraphs", "pages", "sections");
  if (app.key === "numbers") labels.push("sheets");
  if (app.key === "keynote") labels.push("slides");
  labels.push("tables", "shapes", "images", "text boxes", "charts", "movies", "lines");

  const rows = labels.map((label, i) => `  ${label.padEnd(12)} ${f[i] || "0"}`);
  return ok(`${app.label} document:\n${rows.join("\n")}`);
}

// --- iwork_shapes ----------------------------------------------------------

export type ShapeAction = "list" | "add" | "format" | "delete";

export interface ShapesOptions {
  app?: string;
  path?: string;
  action: ShapeAction;
  slide?: number;
  sheet?: number;
  index?: number;
  text?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  opacity?: number;
  locked?: boolean;
  font?: string;
  size?: number;
  color?: string;
}

export async function iworkShapes(opts: ShapesOptions): Promise<Result> {
  const picked = pickApp(opts.app, opts.path);
  if (isErr(picked)) return picked;
  const app = picked;
  const missing = requireApp(app);
  if (missing) return missing;

  const target = opts.path ? resolveTarget(opts.path) : null;
  if (target && failed(target)) return target;
  const doc = target as string | null;

  const container = containerExpr(app, opts.slide, opts.sheet);
  const where = containerLabel(app, opts.slide, opts.sheet);

  // ---- list ---------------------------------------------------------------
  if (opts.action === "list") {
    const body = [
      `  set out to ""`,
      `  set i to 0`,
      `  repeat with s in shapes of ${container}`,
      `    set i to i + 1`,
      `    set px to 0`,
      `    set py to 0`,
      `    set ww to 0`,
      `    set hh to 0`,
      `    set rot to 0`,
      `    set opa to 100`,
      `    set txt to ""`,
      `    set lk to false`,
      `    try`,
      `      set pos to position of s`,
      `      set px to item 1 of pos`,
      `      set py to item 2 of pos`,
      `      set ww to width of s`,
      `      set hh to height of s`,
      `      set rot to rotation of s`,
      `      set opa to opacity of s`,
      `      set lk to locked of s`,
      `    end try`,
      `    try`,
      `      set txt to (object text of s) as text`,
      `    end try`,
      `    set out to out & (i as text) & (ASCII character 30) & (px as text) & (ASCII character 30) & (py as text) & (ASCII character 30) & (ww as text) & (ASCII character 30) & (hh as text) & (ASCII character 30) & (rot as text) & (ASCII character 30) & (opa as text) & (ASCII character 30) & (lk as text) & (ASCII character 30) & txt & (ASCII character 31)`,
      `  end repeat`,
      `  return out`,
    ];

    const res = await runAppleScript(appScript(app, doc, body), 130_000);
    if (!res.ok) return bad(explainFailure(res, app.label));

    const rows = parseRecords(res.out);
    if (!rows.length) return ok(`${app.label} ${where} has no shapes.`);

    const lines = rows.map((r) => {
      const label = (r[8] ?? "").replace(/\s+/g, " ").slice(0, 40);
      const flags = [r[7] === "true" ? "locked" : "", r[6] && r[6] !== "100" ? `${r[6]}%` : ""].filter(Boolean);
      return (
        `  #${String(r[0]).padStart(2)}  ${String(r[3]).padStart(4)}x${String(r[4]).padStart(4)}  ` +
        `at (${r[1]}, ${r[2]})` +
        (r[5] && r[5] !== "0" ? `  ${r[5]}°` : "") +
        (flags.length ? `  [${flags.join(", ")}]` : "") +
        (label ? `  "${label}"` : "")
      );
    });
    return ok(`Shapes in ${app.label} ${where}:\n${lines.join("\n")}`);
  }

  // ---- add ----------------------------------------------------------------
  if (opts.action === "add") {
    const props = [
      opts.x !== undefined && opts.y !== undefined ? `position:{${Math.round(opts.x)}, ${Math.round(opts.y)}}` : "",
      opts.width ? `width:${Math.round(opts.width)}` : "",
      opts.height ? `height:${Math.round(opts.height)}` : "",
      opts.rotation !== undefined ? `rotation:${Math.round(opts.rotation)}` : "",
      opts.opacity !== undefined ? `opacity:${Math.round(opts.opacity)}` : "",
    ].filter(Boolean);
    const propList = props.length ? ` with properties {${props.join(", ")}}` : "";

    let colorRgb: [number, number, number] | null = null;
    try {
      if (opts.color) colorRgb = hexToApple(opts.color);
    } catch (err) {
      return bad(`ERROR: ${(err as Error).message}`);
    }

    const body = [
      `  set s to make new shape at end of ${container}${propList}`,
      opts.text !== undefined ? `  set object text of s to ${asLit(opts.text)}` : "",
      opts.text && opts.font ? `  set font of object text of s to ${asLit(opts.font)}` : "",
      opts.text && opts.size ? `  set size of object text of s to ${opts.size}` : "",
      opts.text && colorRgb ? `  set color of object text of s to {${colorRgb.join(", ")}}` : "",
      opts.locked ? `  set locked of s to true` : "",
      `  save doc`,
      `  return "ok"`,
    ];

    const res = await runAppleScript(appScript(app, doc, body), 130_000);
    if (!res.ok) return bad(explainFailure(res, app.label));
    return ok(
      `Added a shape to ${app.label} ${where}` +
        (opts.text ? ` containing ${JSON.stringify(opts.text.slice(0, 40))}` : "") +
        ".",
    );
  }

  // ---- format / delete ----------------------------------------------------
  if (!opts.index) return bad(`ERROR: action=${opts.action} needs a 1-based \`index\` from the listing.`);

  if (opts.action === "delete") {
    const body = [
      `  set theItems to shapes of ${container}`,
      `  if (count of theItems) < ${opts.index} then error "no shape at index ${opts.index}"`,
      `  delete item ${opts.index} of theItems`,
      `  save doc`,
      `  return "ok"`,
    ];
    const res = await runAppleScript(appScript(app, doc, body), 130_000);
    if (!res.ok) return bad(explainFailure(res, app.label));
    return ok(`Deleted shape ${opts.index} from ${app.label} ${where}.`);
  }

  // format
  let colorRgb: [number, number, number] | null = null;
  try {
    if (opts.color) colorRgb = hexToApple(opts.color);
  } catch (err) {
    return bad(`ERROR: ${(err as Error).message}`);
  }

  const lines = [
    `  set theItems to shapes of ${container}`,
    `  if (count of theItems) < ${opts.index} then error "no shape at index ${opts.index}"`,
    `  set s to item ${opts.index} of theItems`,
  ];
  if (opts.x !== undefined && opts.y !== undefined) {
    lines.push(`  set position of s to {${Math.round(opts.x)}, ${Math.round(opts.y)}}`);
  }
  if (opts.width) lines.push(`  set width of s to ${Math.round(opts.width)}`);
  if (opts.height) lines.push(`  set height of s to ${Math.round(opts.height)}`);
  if (opts.rotation !== undefined) lines.push(`  set rotation of s to ${Math.round(opts.rotation)}`);
  if (opts.opacity !== undefined) lines.push(`  set opacity of s to ${Math.round(opts.opacity)}`);
  if (opts.locked !== undefined) lines.push(`  set locked of s to ${opts.locked}`);
  if (opts.text !== undefined) lines.push(`  set object text of s to ${asLit(opts.text)}`);
  if (opts.font) lines.push(`  try`, `    set font of object text of s to ${asLit(opts.font)}`, `  end try`);
  if (opts.size) lines.push(`  try`, `    set size of object text of s to ${opts.size}`, `  end try`);
  if (colorRgb) lines.push(`  try`, `    set color of object text of s to {${colorRgb.join(", ")}}`, `  end try`);

  if (lines.length === 3) {
    return bad("ERROR: action=format needs at least one of text, x/y, width, height, rotation, opacity, locked, font, size, color.");
  }

  lines.push(`  save doc`, `  return "ok"`);

  const res = await runAppleScript(appScript(app, doc, lines), 130_000);
  if (!res.ok) return bad(explainFailure(res, app.label));
  return ok(`Updated shape ${opts.index} in ${app.label} ${where}.`);
}

// --- iwork_export ----------------------------------------------------------

/** Every export format any of the three apps supports. */
export const ALL_EXPORT_FORMATS = ["pdf", "txt", "rtf", "epub", "docx", "xlsx", "csv", "pptx", "html", "movie", "images"] as const;

export interface IWorkExportOptions {
  app?: string;
  path: string;
  format: string;
  destPath?: string;
  overwrite?: boolean;
}

export async function iworkExport(opts: IWorkExportOptions): Promise<Result> {
  const picked = pickApp(opts.app, opts.path);
  if (isErr(picked)) return picked;
  const app = picked;
  const missing = requireApp(app);
  if (missing) return missing;

  const target = resolveTarget(opts.path);
  if (failed(target)) return target;

  const spec = app.exportFormats[opts.format.toLowerCase()];
  if (!spec) {
    return bad(
      `ERROR: ${app.label} cannot export ${opts.format}. Supported: ${Object.keys(app.exportFormats).join(", ")}.`,
    );
  }

  const dest = opts.destPath
    ? resolveUserPath(opts.destPath)
    : path.join(path.dirname(target), `${path.basename(target, path.extname(target))}.${spec.ext}`);

  if (fs.existsSync(dest) && !opts.overwrite) {
    return bad(`ERROR: ${dest} already exists. Pass overwrite=true to replace it.`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const body = [
    `  export doc to POSIX file ${asLit(dest)} as ${spec.as}`,
    `  return "ok"`,
  ];

  const res = await runAppleScript(appScript(app, target, body), 300_000);
  if (!res.ok) return bad(explainFailure(res, app.label));
  if (!fs.existsSync(dest)) return bad(`ERROR: ${app.label} reported success but ${dest} was not written.`);

  const size = fs.statSync(dest).size;
  return ok(`Exported ${path.basename(target)} to ${dest} (${app.label} ${spec.as}, ${Math.round(size / 1024)} KB).`);
}

// --- iwork_script ----------------------------------------------------------

export interface ScriptOptions {
  app: string;
  path?: string;
  script: string;
  timeoutSeconds?: number;
}

/**
 * Scripts that would close a document or quit an app are refused. This is the
 * one invariant the whole iWork layer is built on: documents stay open exactly
 * as the user left them, and nothing here ever shuts an app down.
 */
function violatesNoCloseRule(source: string): string | null {
  const stripped = source
    .replace(/"[^"]*"/g, '""') // ignore string literals
    .replace(/--[^\n]*/g, ""); // ignore comments
  if (/\b(close|quit)\b/i.test(stripped)) {
    return (
      "ERROR: scripts passed to iwork_script may not contain `close` or `quit`. " +
      "This server never closes documents and never quits an app - that is deliberate. " +
      "Edit the document instead, or use run_command if you really need to shut something down."
    );
  }
  return null;
}

export async function iworkScript(opts: ScriptOptions): Promise<Result> {
  const picked = pickApp(opts.app, opts.path);
  if (isErr(picked)) return picked;
  const app = picked;
  const missing = requireApp(app);
  if (missing) return missing;

  if (!opts.script?.trim()) return bad("ERROR: script is required.");

  const violation = violatesNoCloseRule(opts.script);
  if (violation) return bad(violation);

  const target = opts.path ? resolveTarget(opts.path) : null;
  if (target && failed(target)) return target;

  const timeout = Math.min(Math.max(opts.timeoutSeconds ?? 120, 5), 600);
  const script = appScript(app, target as string | null, [opts.script], { timeout: timeout + 20 });

  const res = await runAppleScript(script, timeout * 1000);
  if (!res.ok) return bad(explainFailure(res, app.label));

  const out = res.out.trim();
  return ok(out ? `${app.label} returned:\n${out}` : `Ran the script against ${app.label}. No output.`);
}
