// Durable Keynote workflows: create, inspect, verify, find and stats.
// Uses Keynote's real document/slide object model, with no screen-coordinate automation.
import fs from "node:fs";
import path from "node:path";
import {
  IWORK_APPS,
  US,
  appScript,
  asLit,
  bad,
  explainFailure,
  failed,
  ok,
  parseRecords,
  requireApp,
  strList,
  resolveTarget,
  resolveUserPath,
  runAppleScript,
  type Result,
} from "./applescript.js";

const KEYNOTE = IWORK_APPS.keynote;

const TRANSITIONS = new Set([
  "no transition effect", "magic move", "shimmer", "sparkle", "swing", "object cube", "object flip",
  "object pop", "object push", "object revolve", "object zoom", "perspective", "clothesline", "confetti",
  "dissolve", "drop", "droplet", "fade through color", "grid", "iris", "move in", "push", "reveal", "switch",
  "wipe", "blinds", "color planes", "cube", "doorway", "fall", "flip", "flop", "mosaic", "page flip", "pivot",
  "reflection", "revolving door", "scale", "swap", "swoosh", "twirl", "twist", "fade and move", "radial wipe",
]);

function colorLiteral(hex?: string): string | null {
  if (!hex) return null;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) throw new Error("invalid colour " + hex + "; expected #RRGGBB");
  const n = parseInt(m[1], 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round((v / 255) * 65535));
  return "{" + c.join(", ") + "}";
}

export interface KeynoteCreateTransition {
  effect?: string;
  duration?: number;
  delay?: number;
  automatic?: boolean;
}

export interface KeynoteCreateTextBox {
  text: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  font?: string;
  size?: number;
  color?: string;
}

export interface KeynoteCreateImage {
  path: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  description?: string;
}

export interface KeynoteCreateTable {
  values: string[][];
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  headerRows?: number;
  headerCols?: number;
}

export interface KeynoteCreateSlide {
  layout?: string;
  title?: string;
  body?: string;
  notes?: string;
  skipped?: boolean;
  transition?: KeynoteCreateTransition;
  textBoxes?: KeynoteCreateTextBox[];
  images?: KeynoteCreateImage[];
  tables?: KeynoteCreateTable[];
}

export interface KeynoteCreateOptions {
  path: string;
  theme?: string;
  width?: number;
  height?: number;
  slides: KeynoteCreateSlide[];
  overwrite?: boolean;
}

function transitionRecord(t?: KeynoteCreateTransition): string | null {
  if (!t) return null;
  const effect = (t.effect || "no transition effect").trim().toLowerCase();
  if (!TRANSITIONS.has(effect)) throw new Error("unknown Keynote transition effect: " + effect);
  if (t.duration !== undefined && t.duration < 0) throw new Error("transition duration must be >= 0");
  if (t.delay !== undefined && t.delay < 0) throw new Error("transition delay must be >= 0");
  return "{transition effect:" + effect +
    ", transition duration:" + (t.duration === undefined ? 1 : t.duration) +
    ", transition delay:" + (t.delay === undefined ? 0 : t.delay) +
    ", automatic transition:" + (t.automatic === undefined ? false : t.automatic) + "}";
}

export async function keynoteCreate(opts: KeynoteCreateOptions): Promise<Result> {
  const missing = requireApp(KEYNOTE);
  if (missing) return missing;
  const dest = resolveUserPath(opts.path);
  if (!dest.toLowerCase().endsWith(".key")) return bad("ERROR: destination must end in .key: " + dest);
  if (fs.existsSync(dest) && !opts.overwrite) return bad("ERROR: destination exists; pass overwrite=true: " + dest);
  if (!opts.slides || opts.slides.length === 0) return bad("ERROR: at least one slide is required.");
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  for (const slide of opts.slides) {
    for (const image of slide.images || []) {
      const p = resolveUserPath(image.path);
      if (!fs.existsSync(p)) return bad("ERROR: image does not exist: " + p);
    }
    try {
      transitionRecord(slide.transition);
      for (const box of slide.textBoxes || []) colorLiteral(box.color);
    } catch (err) {
      return bad("ERROR: " + (err as Error).message);
    }
  }

  const props: string[] = [];
  if (opts.theme) props.push("document theme:theme " + asLit(opts.theme));
  if (opts.width) props.push("width:" + Math.round(opts.width));
  if (opts.height) props.push("height:" + Math.round(opts.height));

  const lines: string[] = [
    "with timeout of 300 seconds",
    '  tell application id "' + KEYNOTE.bundleId + '"',
    "  set doc to make new document" + (props.length ? " with properties {" + props.join(", ") + "}" : ""),
    "  repeat while (count of slides of doc) > 1",
    "    delete last slide of doc",
    "  end repeat",
    "  if (count of slides of doc) is 0 then make new slide at end of slides of doc",
  ];

  for (let i = 0; i < opts.slides.length; i++) {
    const slide = opts.slides[i];
    if (i === 0) lines.push("  set s to slide 1 of doc");
    else lines.push("  set s to make new slide at end of slides of doc");
    if (slide.layout) lines.push("  set base layout of s to slide layout " + asLit(slide.layout) + " of doc");
    if (slide.skipped !== undefined) lines.push("  set skipped of s to " + slide.skipped);
    if (slide.title !== undefined) {
      lines.push("  try", "    set title showing of s to true", "    set object text of default title item of s to " + asLit(slide.title), "  end try");
    }
    if (slide.body !== undefined) {
      lines.push("  try", "    set body showing of s to true", "    set object text of default body item of s to " + asLit(slide.body), "  end try");
    }
    if (slide.notes !== undefined) lines.push("  set presenter notes of s to " + asLit(slide.notes));
    const tr = transitionRecord(slide.transition);
    if (tr) lines.push("  set transition properties of s to " + tr);

    for (const box of slide.textBoxes || []) {
      const boxProps: string[] = [];
      if (box.x !== undefined && box.y !== undefined) boxProps.push("position:{" + Math.round(box.x) + ", " + Math.round(box.y) + "}");
      if (box.width) boxProps.push("width:" + Math.round(box.width));
      if (box.height) boxProps.push("height:" + Math.round(box.height));
      lines.push("  set tb to make new text item at end of s" + (boxProps.length ? " with properties {" + boxProps.join(", ") + "}" : ""));
      lines.push("  set object text of tb to " + asLit(box.text));
      if (box.font) lines.push("  set font of object text of tb to " + asLit(box.font));
      if (box.size) lines.push("  set size of object text of tb to " + box.size);
      const col = colorLiteral(box.color);
      if (col) lines.push("  set color of object text of tb to " + col);
    }

    for (const image of slide.images || []) {
      const ip = resolveUserPath(image.path);
      lines.push("  set img to make new image at end of s with properties {file:(POSIX file " + asLit(ip) + ")}");
      if (image.x !== undefined && image.y !== undefined) lines.push("  set position of img to {" + Math.round(image.x) + ", " + Math.round(image.y) + "}");
      if (image.width) lines.push("  set width of img to " + Math.round(image.width));
      if (image.height) lines.push("  set height of img to " + Math.round(image.height));
      if (image.description !== undefined) lines.push("  set description of img to " + asLit(image.description));
    }

    for (const table of slide.tables || []) {
      const rows = Math.max(1, table.values.length);
      const cols = Math.max(1, ...table.values.map((row) => row.length));
      const tableProps = ["row count:" + rows, "column count:" + cols];
      if (table.x !== undefined && table.y !== undefined) tableProps.push("position:{" + Math.round(table.x) + ", " + Math.round(table.y) + "}");
      if (table.width) tableProps.push("width:" + Math.round(table.width));
      if (table.height) tableProps.push("height:" + Math.round(table.height));
      lines.push("  set tbl to make new table at end of s with properties {" + tableProps.join(", ") + "}");
      if (table.headerRows !== undefined) lines.push("  set header row count of tbl to " + table.headerRows);
      if (table.headerCols !== undefined) lines.push("  set header column count of tbl to " + table.headerCols);
      table.values.forEach((row, ri) => {
        row.forEach((value, ci) => {
          lines.push("  set value of cell " + (ci + 1) + " of row " + (ri + 1) + " of tbl to " + asLit(value));
        });
      });
    }
  }

  lines.push(
    "  save doc in POSIX file " + asLit(dest),
    "  return (count of slides of doc) as text",
    "  end tell",
    "end timeout",
  );
  const res = await runAppleScript(lines.join("\\n"), 320_000);
  if (!res.ok) return bad(explainFailure(res, KEYNOTE.label));
  const objects = opts.slides.reduce(
    (n, s) => n + (s.textBoxes || []).length + (s.images || []).length + (s.tables || []).length,
    0,
  );
  return ok(
    "Created " + dest + "\\nslides: " + res.out.trim() + "   added objects: " + objects +
      (opts.theme ? "   theme: " + opts.theme : "") +
      "\\nsaved; left open in Keynote",
  );
}

export interface KeynoteInspectOptions {
  path: string;
  maxObjects?: number;
}

export async function keynoteInspect(opts: KeynoteInspectOptions): Promise<Result> {
  const missing = requireApp(KEYNOTE);
  if (missing) return missing;
  const doc = resolveTarget(opts.path, ".key document");
  if (failed(doc)) return doc;
  const maxObjects = Math.min(Math.max(opts.maxObjects || 400, 1), 5000);
  const body = [
    '  set out to ""',
    '  set th to ""',
    "  try",
    "    set th to name of document theme of doc",
    "  end try",
    '  set out to out & "D" & (ASCII character 30) & (width of doc as text) & (ASCII character 30) & (height of doc as text) & (ASCII character 30) & th & (ASCII character 30) & (auto loop of doc as text) & (ASCII character 30) & (auto play of doc as text) & (ASCII character 30) & (auto restart of doc as text) & (ASCII character 30) & (maximum idle duration of doc as text) & (ASCII character 30) & (slide numbers showing of doc as text) & (ASCII character 31)',
    "  set seen to 0",
    "  set si to 0",
    "  repeat with s in slides of doc",
    "    set si to si + 1",
    '    set lay to ""',
    '    set ttl to ""',
    '    set bdy to ""',
    '    set nts to ""',
    '    set eff to ""',
    '    set dur to ""',
    '    set dly to ""',
    '    set aut to ""',
    "    try",
    "      set lay to name of base layout of s",
    "    end try",
    "    try",
    "      set ttl to object text of default title item of s as text",
    "    end try",
    "    try",
    "      set bdy to object text of default body item of s as text",
    "    end try",
    "    try",
    "      set nts to presenter notes of s as text",
    "    end try",
    "    try",
    "      set tr to transition properties of s",
    "      set eff to transition effect of tr as text",
    "      set dur to transition duration of tr as text",
    "      set dly to transition delay of tr as text",
    "      set aut to automatic transition of tr as text",
    "    end try",
    '    set out to out & "S" & (ASCII character 30) & (si as text) & (ASCII character 30) & lay & (ASCII character 30) & (skipped of s as text) & (ASCII character 30) & ttl & (ASCII character 30) & bdy & (ASCII character 30) & nts & (ASCII character 30) & eff & (ASCII character 30) & dur & (ASCII character 30) & dly & (ASCII character 30) & aut & (ASCII character 30) & (count of text items of s as text) & (ASCII character 30) & (count of shapes of s as text) & (ASCII character 30) & (count of images of s as text) & (ASCII character 30) & (count of tables of s as text) & (ASCII character 30) & (count of charts of s as text) & (ASCII character 30) & (count of movies of s as text) & (ASCII character 30) & (count of lines of s as text) & (ASCII character 31)',
    "    repeat with kindName in {\"text item\", \"shape\", \"image\", \"table\", \"chart\", \"movie\"}",
    "      if seen is greater than or equal to " + maxObjects + " then exit repeat",
    "      set objs to {}",
    "      if kindName is \"text item\" then set objs to text items of s",
    "      if kindName is \"shape\" then set objs to shapes of s",
    "      if kindName is \"image\" then set objs to images of s",
    "      if kindName is \"table\" then set objs to tables of s",
    "      if kindName is \"chart\" then set objs to charts of s",
    "      if kindName is \"movie\" then set objs to movies of s",
    "      set oi to 0",
    "      repeat with obj in objs",
    "        if seen is greater than or equal to " + maxObjects + " then exit repeat",
    "        set seen to seen + 1",
    "        set oi to oi + 1",
    "        set pos to position of obj",
    '        set txt to ""',
    "        try",
    "          set txt to object text of obj as text",
    "        end try",
    '        set out to out & "O" & (ASCII character 30) & (si as text) & (ASCII character 30) & kindName & (ASCII character 30) & (oi as text) & (ASCII character 30) & (item 1 of pos as text) & (ASCII character 30) & (item 2 of pos as text) & (ASCII character 30) & (width of obj as text) & (ASCII character 30) & (height of obj as text) & (ASCII character 30) & (rotation of obj as text) & (ASCII character 30) & (opacity of obj as text) & (ASCII character 30) & (locked of obj as text) & (ASCII character 30) & txt & (ASCII character 31)',
    "      end repeat",
    "    end repeat",
    "  end repeat",
    "  return out",
  ];
  const res = await runAppleScript(appScript(KEYNOTE, doc, body), 240_000);
  if (!res.ok) return bad(explainFailure(res, KEYNOTE.label));

  const lines: string[] = ["Keynote inspection: " + path.basename(doc)];
  let objectCount = 0;
  for (const r of parseRecords(res.out)) {
    if (r[0] === "D") {
      lines.push(
        "document: " + r[1] + "x" + r[2] + " pt, theme " + JSON.stringify(r[3] || "") +
          ", loop=" + r[4] + ", autoplay=" + r[5] + ", restart=" + r[6] + "/" + r[7] + "s, slideNumbers=" + r[8],
      );
    } else if (r[0] === "S") {
      lines.push(
        "",
        "slide " + r[1] + ": layout=" + JSON.stringify(r[2] || "") + ", skipped=" + r[3] +
          ", title=" + JSON.stringify((r[4] || "").slice(0, 100)) +
          ", body=" + JSON.stringify((r[5] || "").slice(0, 100)),
        "  notes: " + (r[6] || "").length + " chars; transition " + (r[7] || "none") + " / " + (r[8] || "?") + "s / delay " + (r[9] || "?") + " / auto " + (r[10] || "?"),
        "  objects: text=" + r[11] + " shapes=" + r[12] + " images=" + r[13] + " tables=" + r[14] + " charts=" + r[15] + " movies=" + r[16] + " lines=" + r[17],
      );
    } else if (r[0] === "O") {
      objectCount++;
      lines.push(
        "    " + r[2] + " #" + r[3] + " " + r[6] + "x" + r[7] + " at (" + r[4] + ", " + r[5] + ")" +
          (r[8] && r[8] !== "0" ? " rot=" + r[8] : "") +
          (r[9] && r[9] !== "100" ? " opacity=" + r[9] : "") +
          (r[10] === "true" ? " locked" : "") +
          (r[11] ? " " + JSON.stringify(r[11].replace(/\\s+/g, " ").slice(0, 80)) : ""),
      );
    }
  }
  lines.push("", "objects inspected: " + objectCount + (objectCount >= maxObjects ? " (cap reached)" : ""));
  return ok(lines.join("\\n"));
}

export interface KeynoteVerifyOptions {
  path: string;
  expectSlides?: number;
  strictBounds?: boolean;
  maxObjects?: number;
  maxIssues?: number;
}

export async function keynoteVerify(opts: KeynoteVerifyOptions): Promise<Result> {
  const missing = requireApp(KEYNOTE);
  if (missing) return missing;
  const doc = resolveTarget(opts.path, ".key document");
  if (failed(doc)) return doc;
  const maxObjects = Math.min(Math.max(opts.maxObjects || 5000, 1), 20000);
  const maxIssues = Math.min(Math.max(opts.maxIssues || 40, 1), 200);
  const strict = opts.strictBounds === true;
  const body = [
    "  set dw to width of doc",
    "  set dh to height of doc",
    "  set ns to count of slides of doc",
    "  set scanned to 0",
    '  set issues to ""',
    "  set si to 0",
    "  repeat with s in slides of doc",
    "    set si to si + 1",
    "    repeat with kindName in {\"text item\", \"shape\", \"image\", \"table\", \"chart\", \"movie\"}",
    "      set objs to {}",
    "      if kindName is \"text item\" then set objs to text items of s",
    "      if kindName is \"shape\" then set objs to shapes of s",
    "      if kindName is \"image\" then set objs to images of s",
    "      if kindName is \"table\" then set objs to tables of s",
    "      if kindName is \"chart\" then set objs to charts of s",
    "      if kindName is \"movie\" then set objs to movies of s",
    "      set oi to 0",
    "      repeat with obj in objs",
    "        if scanned is greater than or equal to " + maxObjects + " then exit repeat",
    "        set scanned to scanned + 1",
    "        set oi to oi + 1",
    "        set pos to position of obj",
    "        set xx to item 1 of pos",
    "        set yy to item 2 of pos",
    "        set ww to width of obj",
    "        set hh to height of obj",
    '        if ww <= 0 or hh <= 0 then set issues to issues & "SIZE" & (ASCII character 30) & (si as text) & (ASCII character 30) & kindName & (ASCII character 30) & (oi as text) & (ASCII character 30) & (ww as text) & "x" & (hh as text) & (ASCII character 31)',
    strict
      ? '        if xx < 0 or yy < 0 or (xx + ww) > dw or (yy + hh) > dh then set issues to issues & "BOUNDS" & (ASCII character 30) & (si as text) & (ASCII character 30) & kindName & (ASCII character 30) & (oi as text) & (ASCII character 30) & (xx as text) & "," & (yy as text) & " " & (ww as text) & "x" & (hh as text) & (ASCII character 31)'
      : "        -- bounds check disabled",
    "      end repeat",
    "    end repeat",
    "  end repeat",
    '  return (dw as text) & (ASCII character 29) & (dh as text) & (ASCII character 29) & (ns as text) & (ASCII character 29) & (scanned as text) & (ASCII character 29) & issues',
  ];
  const res = await runAppleScript(appScript(KEYNOTE, doc, body), 240_000);
  if (!res.ok) return bad(explainFailure(res, KEYNOTE.label));
  const parts = res.out.split(String.fromCharCode(29));
  const width = Number(parts[0] || 0);
  const height = Number(parts[1] || 0);
  const slides = Number(parts[2] || 0);
  const scanned = Number(parts[3] || 0);
  const issues: string[] = [];
  if (width <= 0 || height <= 0) issues.push("invalid slide dimensions " + width + "x" + height);
  if (slides < 1) issues.push("presentation has no slides");
  if (opts.expectSlides !== undefined && slides !== opts.expectSlides) issues.push("expected " + opts.expectSlides + " slides, found " + slides);
  for (const r of parseRecords(parts[4] || "")) {
    if (r[0] === "SIZE") issues.push("non-positive object size on slide " + r[1] + ": " + r[2] + " #" + r[3] + " " + r[4]);
    if (r[0] === "BOUNDS") issues.push("object outside slide bounds on slide " + r[1] + ": " + r[2] + " #" + r[3] + " " + r[4]);
    if (issues.length >= maxIssues) break;
  }
  const lines = [
    (issues.length ? "FAIL: " : "PASS: ") + path.basename(doc),
    "slide size: " + width + "x" + height + " pt   slides: " + slides + "   objects scanned: " + scanned + (scanned >= maxObjects ? " (cap reached)" : ""),
    "strict bounds: " + strict,
  ];
  if (issues.length) lines.push("issues:", ...issues.map((x) => "  - " + x));
  else lines.push("No structural object-size" + (strict ? " or bounds" : "") + " problems found.");
  return issues.length ? bad(lines.join("\\n")) : ok(lines.join("\\n"));
}

export interface KeynoteFindOptions {
  path: string;
  text: string;
  maxResults?: number;
}

export async function keynoteFind(opts: KeynoteFindOptions): Promise<Result> {
  const missing = requireApp(KEYNOTE);
  if (missing) return missing;
  const doc = resolveTarget(opts.path, ".key document");
  if (failed(doc)) return doc;
  if (!opts.text) return bad("ERROR: text is required.");
  const limit = Math.min(Math.max(opts.maxResults || 50, 1), 500);
  const needle = asLit(opts.text.toLowerCase());
  const body = [
    '  set out to ""',
    "  set hits to 0",
    "  set si to 0",
    "  repeat with s in slides of doc",
    "    set si to si + 1",
    "    repeat with pair in {{\"title\", default title item of s}, {\"body\", default body item of s}}",
    '      set hay to ""',
    "      try",
    "        set hay to object text of item 2 of pair as text",
    "      end try",
    "      ignoring case",
    "        if hay contains " + needle + " then",
    '          set out to out & (si as text) & (ASCII character 30) & (item 1 of pair) & (ASCII character 30) & hay & (ASCII character 31)',
    "          set hits to hits + 1",
    "          if hits is greater than or equal to " + limit + " then return out",
    "        end if",
    "      end ignoring",
    "    end repeat",
    '    set hay to ""',
    "    try",
    "      set hay to presenter notes of s as text",
    "    end try",
    "    ignoring case",
    "      if hay contains " + needle + " then",
    '        set out to out & (si as text) & (ASCII character 30) & "notes" & (ASCII character 30) & hay & (ASCII character 31)',
    "        set hits to hits + 1",
    "        if hits is greater than or equal to " + limit + " then return out",
    "      end if",
    "    end ignoring",
    "    repeat with tb in text items of s",
    '      set hay to ""',
    "      try",
    "        set hay to object text of tb as text",
    "      end try",
    "      ignoring case",
    "        if hay contains " + needle + " then",
    '          set out to out & (si as text) & (ASCII character 30) & "text box" & (ASCII character 30) & hay & (ASCII character 31)',
    "          set hits to hits + 1",
    "          if hits is greater than or equal to " + limit + " then return out",
    "        end if",
    "      end ignoring",
    "    end repeat",
    "  end repeat",
    "  return out",
  ];
  const res = await runAppleScript(appScript(KEYNOTE, doc, body), 220_000);
  if (!res.ok) return bad(explainFailure(res, KEYNOTE.label));
  const hits = parseRecords(res.out);
  if (!hits.length) return ok("No matches for " + JSON.stringify(opts.text) + ".");
  return ok(
    "Matches for " + JSON.stringify(opts.text) + ":\\n" +
      hits.map((r) => "  slide " + r[0] + " / " + r[1] + ": " + (r[2] || "").replace(/\\s+/g, " ").slice(0, 180)).join("\\n"),
  );
}

export async function keynoteStats(opts: { path: string }): Promise<Result> {
  const missing = requireApp(KEYNOTE);
  if (missing) return missing;
  const doc = resolveTarget(opts.path, ".key document");
  if (failed(doc)) return doc;
  const body = [
    "  set ns to count of slides of doc",
    "  set skippedCount to 0",
    "  set notesChars to 0",
    "  set ntext to 0",
    "  set nshapes to 0",
    "  set nimages to 0",
    "  set ntables to 0",
    "  set ncharts to 0",
    "  set nmovies to 0",
    "  repeat with s in slides of doc",
    "    if skipped of s then set skippedCount to skippedCount + 1",
    "    try",
    "      set notesChars to notesChars + (count of characters of (presenter notes of s as text))",
    "    end try",
    "    set ntext to ntext + (count of text items of s)",
    "    set nshapes to nshapes + (count of shapes of s)",
    "    set nimages to nimages + (count of images of s)",
    "    set ntables to ntables + (count of tables of s)",
    "    set ncharts to ncharts + (count of charts of s)",
    "    set nmovies to nmovies + (count of movies of s)",
    "  end repeat",
    '  return (ns as text) & (ASCII character 30) & (skippedCount as text) & (ASCII character 30) & (notesChars as text) & (ASCII character 30) & (ntext as text) & (ASCII character 30) & (nshapes as text) & (ASCII character 30) & (nimages as text) & (ASCII character 30) & (ntables as text) & (ASCII character 30) & (ncharts as text) & (ASCII character 30) & (nmovies as text)',
  ];
  const res = await runAppleScript(appScript(KEYNOTE, doc, body), 220_000);
  if (!res.ok) return bad(explainFailure(res, KEYNOTE.label));
  const f = res.out.split(US);
  return ok(
    path.basename(doc) + "\\n  slides       " + f[0] + "\\n  skipped      " + f[1] + "\\n  notes chars  " + f[2] +
      "\\n  text items   " + f[3] + "\\n  shapes       " + f[4] + "\\n  images       " + f[5] +
      "\\n  tables       " + f[6] + "\\n  charts       " + f[7] + "\\n  movies       " + f[8],
  );
}

export type KeynoteChartType =
  | "pie_2d"
  | "vertical_bar_2d"
  | "stacked_vertical_bar_2d"
  | "horizontal_bar_2d"
  | "stacked_horizontal_bar_2d"
  | "pie_3d"
  | "vertical_bar_3d"
  | "stacked_vertical_bar_3d"
  | "horizontal_bar_3d"
  | "stacked_horizontal_bar_3d"
  | "area_2d"
  | "stacked_area_2d"
  | "line_2d"
  | "line_3d"
  | "area_3d"
  | "stacked_area_3d"
  | "scatterplot_2d";

export interface KeynoteChartOptions {
  path: string;
  action: "list" | "add" | "format" | "delete";
  slide: number;
  chart?: number;
  type?: KeynoteChartType;
  groupBy?: "row" | "column";
  rowNames?: string[];
  columnNames?: string[];
  data?: number[][];
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  opacity?: number;
  locked?: boolean;
}

export async function keynoteCharts(opts: KeynoteChartOptions): Promise<Result> {
  const missing = requireApp(KEYNOTE);
  if (missing) return missing;
  const doc = resolveTarget(opts.path, ".key document");
  if (failed(doc)) return doc;
  if (!opts.slide) return bad("ERROR: slide is required.");

  const pre = [
    "  if (count of slides of doc) < " + opts.slide + " then error \"no slide " + opts.slide + "\"",
    "  set s to slide " + opts.slide + " of doc",
  ];

  if (opts.action === "list") {
    const body = [
      ...pre,
      '  set out to ""',
      "  set i to 0",
      "  repeat with ch in charts of s",
      "    set i to i + 1",
      "    set pos to position of ch",
      '    set out to out & (i as text) & (ASCII character 30) & (item 1 of pos as text) & (ASCII character 30) & (item 2 of pos as text) & (ASCII character 30) & (width of ch as text) & (ASCII character 30) & (height of ch as text) & (ASCII character 30) & (rotation of ch as text) & (ASCII character 30) & (opacity of ch as text) & (ASCII character 30) & (locked of ch as text) & (ASCII character 31)',
      "  end repeat",
      "  return out",
    ];
    const res = await runAppleScript(appScript(KEYNOTE, doc, body), 160_000);
    if (!res.ok) return bad(explainFailure(res, KEYNOTE.label));
    const rows = parseRecords(res.out);
    if (!rows.length) return ok("Slide " + opts.slide + " has no charts.");
    return ok(
      "Charts on slide " + opts.slide + ":\n" +
        rows.map((r) => "  #" + r[0] + " " + r[3] + "x" + r[4] + " at (" + r[1] + ", " + r[2] + ")" +
          (r[5] !== "0" ? " rot=" + r[5] : "") + (r[6] !== "100" ? " opacity=" + r[6] : "") +
          (r[7] === "true" ? " locked" : "")).join("\n"),
    );
  }

  if (opts.action === "add") {
    if (!opts.data || opts.data.length === 0) return bad("ERROR: action=add needs data.");
    const data = "{" + opts.data.map((row) => "{" + row.join(", ") + "}").join(", ") + "}";
    const args = [
      opts.rowNames && opts.rowNames.length ? " row names " + strList(opts.rowNames) : "",
      opts.columnNames && opts.columnNames.length ? " column names " + strList(opts.columnNames) : "",
      " data " + data,
      opts.type ? " type " + opts.type : "",
      opts.groupBy ? " group by chart " + opts.groupBy : "",
    ].join("");
    const body = [
      ...pre,
      "  set ch to add chart s" + args,
      opts.x !== undefined && opts.y !== undefined ? "  set position of ch to {" + Math.round(opts.x) + ", " + Math.round(opts.y) + "}" : "",
      opts.width !== undefined ? "  set width of ch to " + Math.round(opts.width) : "",
      opts.height !== undefined ? "  set height of ch to " + Math.round(opts.height) : "",
      opts.rotation !== undefined ? "  set rotation of ch to " + Math.round(opts.rotation) : "",
      opts.opacity !== undefined ? "  set opacity of ch to " + Math.round(opts.opacity) : "",
      opts.locked !== undefined ? "  set locked of ch to " + opts.locked : "",
      "  save doc",
      "  return (count of charts of s) as text",
    ];
    const res = await runAppleScript(appScript(KEYNOTE, doc, body), 180_000);
    if (!res.ok) return bad(explainFailure(res, KEYNOTE.label));
    return ok("Added chart #" + res.out.trim() + " to slide " + opts.slide + ".");
  }

  if (!opts.chart) return bad("ERROR: action=" + opts.action + " needs a 1-based chart index.");
  if (opts.action === "delete") {
    const body = [
      ...pre,
      "  if (count of charts of s) < " + opts.chart + " then error \"no chart " + opts.chart + "\"",
      "  delete chart " + opts.chart + " of s",
      "  save doc",
      '  return "ok"',
    ];
    const res = await runAppleScript(appScript(KEYNOTE, doc, body), 160_000);
    if (!res.ok) return bad(explainFailure(res, KEYNOTE.label));
    return ok("Deleted chart " + opts.chart + " from slide " + opts.slide + ".");
  }

  const body = [
    ...pre,
    "  if (count of charts of s) < " + opts.chart + " then error \"no chart " + opts.chart + "\"",
    "  set ch to chart " + opts.chart + " of s",
  ];
  if (opts.x !== undefined && opts.y !== undefined) body.push("  set position of ch to {" + Math.round(opts.x) + ", " + Math.round(opts.y) + "}");
  if (opts.width !== undefined) body.push("  set width of ch to " + Math.round(opts.width));
  if (opts.height !== undefined) body.push("  set height of ch to " + Math.round(opts.height));
  if (opts.rotation !== undefined) body.push("  set rotation of ch to " + Math.round(opts.rotation));
  if (opts.opacity !== undefined) body.push("  set opacity of ch to " + Math.round(opts.opacity));
  if (opts.locked !== undefined) body.push("  set locked of ch to " + opts.locked);
  if (body.length === pre.length + 2) return bad("ERROR: action=format needs geometry, rotation, opacity or locked.");
  body.push("  save doc", '  return "ok"');
  const res = await runAppleScript(appScript(KEYNOTE, doc, body), 160_000);
  if (!res.ok) return bad(explainFailure(res, KEYNOTE.label));
  return ok("Formatted chart " + opts.chart + " on slide " + opts.slide + ".");
}

export interface KeynoteImageSlidesOptions {
  path: string;
  files: string[];
  setTitles?: boolean;
  layout?: string;
}

export async function keynoteImageSlides(opts: KeynoteImageSlidesOptions): Promise<Result> {
  const missing = requireApp(KEYNOTE);
  if (missing) return missing;
  const doc = resolveTarget(opts.path, ".key document");
  if (failed(doc)) return doc;
  if (!opts.files || opts.files.length === 0) return bad("ERROR: files must contain at least one image.");
  const paths = opts.files.map(resolveUserPath);
  const absent = paths.find((p) => !fs.existsSync(p));
  if (absent) return bad("ERROR: image does not exist: " + absent);
  const fileList = "{" + paths.map((p) => "POSIX file " + asLit(p)).join(", ") + "}";
  const body = [
    "  set beforeCount to count of slides of doc",
    "  make image slides doc files " + fileList +
      (opts.setTitles !== undefined ? " set titles " + opts.setTitles : "") +
      (opts.layout ? " slide layout (slide layout " + asLit(opts.layout) + " of doc)" : ""),
    "  save doc",
    "  return ((count of slides of doc) - beforeCount) as text",
  ];
  const res = await runAppleScript(appScript(KEYNOTE, doc, body), 220_000);
  if (!res.ok) return bad(explainFailure(res, KEYNOTE.label));
  return ok("Added " + res.out.trim() + " image slide(s) to " + path.basename(doc) + ".");
}

