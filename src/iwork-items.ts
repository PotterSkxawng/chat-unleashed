// Shared native iWork item operations beyond shapes.
// Covers Pages document items, Numbers sheet items and Keynote slide items.
import fs from "node:fs";
import path from "node:path";
import {
  appForName,
  appForPath,
  appScript,
  asLit,
  bad,
  explainFailure,
  failed,
  hexToApple,
  ok,
  parseRecords,
  requireApp,
  resolveTarget,
  resolveUserPath,
  runAppleScript,
  type AppDef,
  type Result,
} from "./applescript.js";

export type IWorkItemKind = "shape" | "text" | "image" | "table" | "chart" | "movie" | "line" | "group";
export type IWorkItemAction = "list" | "format" | "delete" | "addText" | "addImage";

export interface IWorkItemsOptions {
  app?: string;
  path: string;
  action: IWorkItemAction;
  kind?: IWorkItemKind;
  slide?: number;
  sheet?: number;
  index?: number;
  text?: string;
  imagePath?: string;
  description?: string;
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

function pickApp(appName: string | undefined, docPath: string): AppDef | Result {
  if (appName) {
    const app = appForName(appName);
    if (!app) return bad("ERROR: unknown app " + JSON.stringify(appName) + "; use pages, numbers or keynote.");
    return app;
  }
  const app = appForPath(docPath);
  return app || bad("ERROR: cannot infer iWork app from " + docPath + ".");
}

function isResult(value: AppDef | Result): value is Result {
  return (value as Result).ok !== undefined;
}

function container(app: AppDef, slide?: number, sheet?: number): string {
  if (app.key === "keynote") return "slide " + (slide || 1) + " of doc";
  if (app.key === "numbers") return "sheet " + (sheet || 1) + " of doc";
  return "doc";
}

function plural(kind: IWorkItemKind): string {
  return {
    shape: "shapes",
    text: "text items",
    image: "images",
    table: "tables",
    chart: "charts",
    movie: "movies",
    line: "lines",
    group: "groups",
  }[kind];
}

export async function iworkItems(opts: IWorkItemsOptions): Promise<Result> {
  const picked = pickApp(opts.app, opts.path);
  if (isResult(picked)) return picked;
  const app = picked;
  const missing = requireApp(app);
  if (missing) return missing;
  const target = resolveTarget(opts.path);
  if (failed(target)) return target;
  const where = container(app, opts.slide, opts.sheet);

  if (opts.action === "list") {
    const kinds: IWorkItemKind[] = opts.kind
      ? [opts.kind]
      : ["shape", "text", "image", "table", "chart", "movie", "line", "group"];
    const body: string[] = ['  set out to ""'];
    for (const kind of kinds) {
      const items = plural(kind);
      body.push(
        "  set i to 0",
        "  repeat with obj in " + items + " of " + where,
        "    set i to i + 1",
        "    set px to 0",
        "    set py to 0",
        "    set ww to 0",
        "    set hh to 0",
        "    set rot to 0",
        "    set opa to 100",
        "    set lk to false",
        '    set txt to ""',
        '    set extra to ""',
        "    try",
        "      set pos to position of obj",
        "      set px to item 1 of pos",
        "      set py to item 2 of pos",
        "      set ww to width of obj",
        "      set hh to height of obj",
        "      set rot to rotation of obj",
        "      set opa to opacity of obj",
        "      set lk to locked of obj",
        "    end try",
        "    try",
        "      set txt to object text of obj as text",
        "    end try",
        "    try",
        "      set extra to description of obj as text",
        "    end try",
        '    set out to out & ' + asLit(kind) + ' & (ASCII character 30) & (i as text) & (ASCII character 30) & (px as text) & (ASCII character 30) & (py as text) & (ASCII character 30) & (ww as text) & (ASCII character 30) & (hh as text) & (ASCII character 30) & (rot as text) & (ASCII character 30) & (opa as text) & (ASCII character 30) & (lk as text) & (ASCII character 30) & txt & (ASCII character 30) & extra & (ASCII character 31)',
        "  end repeat",
      );
    }
    body.push("  return out");
    const res = await runAppleScript(appScript(app, target, body), 180_000);
    if (!res.ok) return bad(explainFailure(res, app.label));
    const rows = parseRecords(res.out);
    if (!rows.length) return ok(app.label + " container has no matching items.");
    return ok(
      "Items in " + app.label + " " + (app.key === "keynote" ? "slide " + (opts.slide || 1) : app.key === "numbers" ? "sheet " + (opts.sheet || 1) : "document") + ":\n" +
        rows.map((r) =>
          "  " + r[0] + " #" + r[1] + "  " + r[4] + "x" + r[5] + " at (" + r[2] + ", " + r[3] + ")" +
          (r[6] && r[6] !== "0" ? " rot=" + r[6] : "") +
          (r[7] && r[7] !== "100" ? " opacity=" + r[7] : "") +
          (r[8] === "true" ? " locked" : "") +
          (r[9] ? " " + JSON.stringify(r[9].replace(/\s+/g, " ").slice(0, 90)) : "") +
          (r[10] ? " desc=" + JSON.stringify(r[10].slice(0, 70)) : "")
        ).join("\n"),
    );
  }

  if (opts.action === "addText") {
    if (opts.text === undefined) return bad("ERROR: addText needs text.");
    let rgb: [number, number, number] | null = null;
    try {
      if (opts.color) rgb = hexToApple(opts.color);
    } catch (err) {
      return bad("ERROR: " + (err as Error).message);
    }
    const props: string[] = [];
    if (opts.x !== undefined && opts.y !== undefined) props.push("position:{" + Math.round(opts.x) + ", " + Math.round(opts.y) + "}");
    if (opts.width !== undefined) props.push("width:" + Math.round(opts.width));
    if (opts.height !== undefined) props.push("height:" + Math.round(opts.height));
    if (opts.rotation !== undefined) props.push("rotation:" + Math.round(opts.rotation));
    if (opts.opacity !== undefined) props.push("opacity:" + Math.round(opts.opacity));
    const body = [
      "  set obj to make new text item at end of " + where + (props.length ? " with properties {" + props.join(", ") + "}" : ""),
      "  set object text of obj to " + asLit(opts.text),
      opts.font ? "  set font of object text of obj to " + asLit(opts.font) : "",
      opts.size !== undefined ? "  set size of object text of obj to " + opts.size : "",
      rgb ? "  set color of object text of obj to {" + rgb.join(", ") + "}" : "",
      opts.locked !== undefined ? "  set locked of obj to " + opts.locked : "",
      "  save doc",
      '  return "ok"',
    ];
    const res = await runAppleScript(appScript(app, target, body), 180_000);
    if (!res.ok) return bad(explainFailure(res, app.label));
    return ok("Added a text item to " + app.label + ".");
  }

  if (opts.action === "addImage") {
    if (!opts.imagePath) return bad("ERROR: addImage needs imagePath.");
    const image = resolveUserPath(opts.imagePath);
    if (!fs.existsSync(image)) return bad("ERROR: image does not exist: " + image);
    const body = [
      "  set obj to make new image at end of " + where + " with properties {file:(POSIX file " + asLit(image) + ")}",
      opts.x !== undefined && opts.y !== undefined ? "  set position of obj to {" + Math.round(opts.x) + ", " + Math.round(opts.y) + "}" : "",
      opts.width !== undefined ? "  set width of obj to " + Math.round(opts.width) : "",
      opts.height !== undefined ? "  set height of obj to " + Math.round(opts.height) : "",
      opts.rotation !== undefined ? "  set rotation of obj to " + Math.round(opts.rotation) : "",
      opts.opacity !== undefined ? "  set opacity of obj to " + Math.round(opts.opacity) : "",
      opts.locked !== undefined ? "  set locked of obj to " + opts.locked : "",
      opts.description !== undefined ? "  set description of obj to " + asLit(opts.description) : "",
      "  save doc",
      '  return "ok"',
    ];
    const res = await runAppleScript(appScript(app, target, body), 180_000);
    if (!res.ok) return bad(explainFailure(res, app.label));
    return ok("Added " + path.basename(image) + " to " + app.label + ".");
  }

  if (!opts.kind) return bad("ERROR: format/delete needs kind.");
  if (!opts.index) return bad("ERROR: format/delete needs a 1-based index.");
  const items = plural(opts.kind);
  const pre = [
    "  if (count of " + items + " of " + where + ") < " + opts.index + " then error \"no " + opts.kind + " " + opts.index + "\"",
    "  set obj to item " + opts.index + " of " + items + " of " + where,
  ];

  if (opts.action === "delete") {
    const body = [...pre, "  delete obj", "  save doc", '  return "ok"'];
    const res = await runAppleScript(appScript(app, target, body), 160_000);
    if (!res.ok) return bad(explainFailure(res, app.label));
    return ok("Deleted " + opts.kind + " #" + opts.index + " from " + app.label + ".");
  }

  let rgb: [number, number, number] | null = null;
  try {
    if (opts.color) rgb = hexToApple(opts.color);
  } catch (err) {
    return bad("ERROR: " + (err as Error).message);
  }
  const body = [...pre];
  if (opts.x !== undefined && opts.y !== undefined) body.push("  set position of obj to {" + Math.round(opts.x) + ", " + Math.round(opts.y) + "}");
  if (opts.width !== undefined) body.push("  set width of obj to " + Math.round(opts.width));
  if (opts.height !== undefined) body.push("  set height of obj to " + Math.round(opts.height));
  if (opts.rotation !== undefined) body.push("  set rotation of obj to " + Math.round(opts.rotation));
  if (opts.opacity !== undefined) body.push("  set opacity of obj to " + Math.round(opts.opacity));
  if (opts.locked !== undefined) body.push("  set locked of obj to " + opts.locked);
  if (opts.text !== undefined) body.push("  try", "    set object text of obj to " + asLit(opts.text), "  end try");
  if (opts.font) body.push("  try", "    set font of object text of obj to " + asLit(opts.font), "  end try");
  if (opts.size !== undefined) body.push("  try", "    set size of object text of obj to " + opts.size, "  end try");
  if (rgb) body.push("  try", "    set color of object text of obj to {" + rgb.join(", ") + "}", "  end try");
  if (opts.description !== undefined) body.push("  try", "    set description of obj to " + asLit(opts.description), "  end try");
  if (body.length === pre.length) return bad("ERROR: format needs at least one property to change.");
  body.push("  save doc", '  return "ok"');
  const res = await runAppleScript(appScript(app, target, body), 180_000);
  if (!res.ok) return bad(explainFailure(res, app.label));
  return ok("Formatted " + opts.kind + " #" + opts.index + " in " + app.label + ".");
}
