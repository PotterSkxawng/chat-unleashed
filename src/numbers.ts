// Numbers automation.
//
// Numbers differs from Pages in three useful ways, and this module leans on all
// of them:
//   - content lives on *sheets*, each holding tables
//   - cells are addressed by A1 name ("B4"), not by index
//   - there are real structural commands: add row above/below, add column
//     before/after, transpose, sort, merge - so no value-shifting workarounds
//     are needed the way they were for Pages tables.
import fs from "node:fs";
import path from "node:path";
import {
  IWORK_APPS,
  US,
  appScript,
  asLit,
  bad,
  colorList,
  explainFailure,
  failed,
  hexToApple,
  ok,
  parseRecords,
  requireApp,
  resolveTarget,
  resolveUserPath,
  runAppleScript,
  type Result,
} from "./applescript.js";

const NUMBERS = IWORK_APPS.numbers;

/** Spreadsheet column letter for a 1-based index (1 -> A, 27 -> AA). */
export function colLetter(index: number): string {
  let n = index;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** "B4" -> { row: 4, col: 2 }. Throws on malformed input. */
export function parseA1(ref: string): { row: number; col: number } {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref.trim());
  if (!m) throw new Error(`invalid cell reference ${ref} - expected something like B4`);
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]), col };
}

/** "A1:C10" -> bounds, or a single-cell box for "B4". */
export function parseA1Range(ref: string): { row: number; col: number; rows: number; cols: number } {
  const parts = ref.split(":");
  if (parts.length === 1) return { ...parseA1(parts[0]), rows: 1, cols: 1 };
  if (parts.length !== 2) throw new Error(`invalid range ${ref} - expected A1:C10`);
  const a = parseA1(parts[0]);
  const b = parseA1(parts[1]);
  return {
    row: Math.min(a.row, b.row),
    col: Math.min(a.col, b.col),
    rows: Math.abs(b.row - a.row) + 1,
    cols: Math.abs(b.col - a.col) + 1,
  };
}

/** Numbers accepts numbers, booleans and formulas unquoted; everything else is text. */
function valueLiteral(v: string): string {
  const t = v.trim();
  if (t.startsWith("=")) return asLit(t);
  if (/^-?\d+(\.\d+)?$/.test(t)) return t;
  if (t === "true" || t === "false") return t;
  return asLit(v);
}

function target(pathArg?: string): string | Result {
  const resolved = resolveTarget(pathArg, ".numbers document");
  return resolved;
}

// --- numbers_sheets --------------------------------------------------------

export type SheetAction = "list" | "add" | "delete" | "rename" | "activate";

export interface SheetsOptions {
  path?: string;
  action: SheetAction;
  sheet?: number;
  name?: string;
}

export async function numbersSheets(opts: SheetsOptions): Promise<Result> {
  const missing = requireApp(NUMBERS);
  if (missing) return missing;
  const doc = target(opts.path);
  if (failed(doc)) return doc;

  if (opts.action === "list") {
    const body = [
      `  set out to ""`,
      `  set i to 0`,
      `  repeat with s in sheets of doc`,
      `    set i to i + 1`,
      `    set nm to ""`,
      `    set nt to 0`,
      `    set rr to 0`,
      `    set cc to 0`,
      `    try`,
      `      set nm to name of s`,
      `      set nt to count of tables of s`,
      `    end try`,
      `    try`,
      `      set t to table 1 of s`,
      `      set rr to row count of t`,
      `      set cc to column count of t`,
      `    end try`,
      `    set out to out & (i as text) & (ASCII character 30) & nm & (ASCII character 30) & (nt as text) & (ASCII character 30) & (rr as text) & (ASCII character 30) & (cc as text) & (ASCII character 31)`,
      `  end repeat`,
      `  return out`,
    ];
    const res = await runAppleScript(appScript(NUMBERS, doc, body), 130_000);
    if (!res.ok) return bad(explainFailure(res, NUMBERS.label));

    const rows = parseRecords(res.out);
    if (!rows.length) return ok(`${path.basename(doc)} has no sheets.`);
    const lines = rows.map(
      (r) => `  ${String(r[0]).padStart(2)}  ${(r[1] || "(unnamed)").padEnd(24)} ${r[2]} table(s)  ${r[3]}x${r[4]}`,
    );
    return ok(`Sheets in ${path.basename(doc)}:\n${lines.join("\n")}`);
  }

  if (opts.action === "add") {
    const nameProp = opts.name ? ` with properties {name:${asLit(opts.name)}}` : "";
    const body = [
      `  make new sheet at end of sheets of doc${nameProp}`,
      `  save doc`,
      `  return (count of sheets of doc) as text`,
    ];
    const res = await runAppleScript(appScript(NUMBERS, doc, body), 130_000);
    if (!res.ok) return bad(explainFailure(res, NUMBERS.label));
    return ok(`Added a sheet to ${path.basename(doc)}. Document now has ${res.out.trim()} sheet(s).`);
  }

  if (!opts.sheet) return bad(`ERROR: action=${opts.action} needs a 1-based \`sheet\`.`);

  if (opts.action === "delete") {
    const body = [
      `  set theSheets to sheets of doc`,
      `  if (count of theSheets) < ${opts.sheet} then error "no sheet ${opts.sheet}"`,
      `  if (count of theSheets) is 1 then error "cannot delete the only sheet"`,
      `  delete item ${opts.sheet} of theSheets`,
      `  save doc`,
      `  return (count of sheets of doc) as text`,
    ];
    const res = await runAppleScript(appScript(NUMBERS, doc, body), 130_000);
    if (!res.ok) return bad(explainFailure(res, NUMBERS.label));
    return ok(`Deleted sheet ${opts.sheet} from ${path.basename(doc)}. ${res.out.trim()} sheet(s) remain.`);
  }

  if (opts.action === "rename") {
    if (!opts.name) return bad("ERROR: action=rename needs `name`.");
    const body = [
      `  set theSheets to sheets of doc`,
      `  if (count of theSheets) < ${opts.sheet} then error "no sheet ${opts.sheet}"`,
      `  set name of item ${opts.sheet} of theSheets to ${asLit(opts.name)}`,
      `  save doc`,
      `  return "ok"`,
    ];
    const res = await runAppleScript(appScript(NUMBERS, doc, body), 130_000);
    if (!res.ok) return bad(explainFailure(res, NUMBERS.label));
    return ok(`Renamed sheet ${opts.sheet} to ${JSON.stringify(opts.name)}.`);
  }

  // activate
  const body = [
    `  set theSheets to sheets of doc`,
    `  if (count of theSheets) < ${opts.sheet} then error "no sheet ${opts.sheet}"`,
    `  set active sheet of doc to item ${opts.sheet} of theSheets`,
    `  return "ok"`,
  ];
  const res = await runAppleScript(appScript(NUMBERS, doc, body), 130_000);
  if (!res.ok) return bad(explainFailure(res, NUMBERS.label));
  return ok(`Activated sheet ${opts.sheet}.`);
}

// --- numbers_tables --------------------------------------------------------

export type NumTableAction =
  | "list"
  | "add"
  | "delete"
  | "resize"
  | "addRow"
  | "addColumn"
  | "deleteRow"
  | "deleteColumn"
  | "transpose"
  | "sort"
  | "merge"
  | "unmerge"
  | "format";

export interface NumTableOptions {
  path?: string;
  action: NumTableAction;
  sheet?: number;
  table?: number;
  row?: number;
  col?: number;
  count?: number;
  rows?: number;
  cols?: number;
  position?: "above" | "below" | "before" | "after";
  by?: number;
  direction?: "ascending" | "descending";
  range?: string;
  name?: string;
  headerRows?: number;
  headerCols?: number;
  font?: string;
  size?: number;
  color?: string;
  fill?: string;
  align?: "left" | "center" | "right";
  columnWidths?: number[];
  rowHeights?: number[];
  footerRows?: number;
  freezeHeaderRows?: boolean;
  freezeHeaderCols?: boolean;
  filtered?: boolean;
  textWrap?: boolean;
  verticalAlign?: "top" | "center" | "bottom";
  cellFormat?: "automatic" | "checkbox" | "currency" | "date and time" | "fraction" | "number" | "percent" | "pop up menu" | "scientific" | "slider" | "stepper" | "text" | "duration" | "rating" | "numeral system";
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  opacity?: number;
  locked?: boolean;
}

export async function numbersTables(opts: NumTableOptions): Promise<Result> {
  const missing = requireApp(NUMBERS);
  if (missing) return missing;
  const doc = target(opts.path);
  if (failed(doc)) return doc;

  const sheet = opts.sheet ?? 1;
  const table = opts.table ?? 1;
  const tbl = `table ${table} of sheet ${sheet} of doc`;
  const preamble = [
    `  set theSheets to sheets of doc`,
    `  if (count of theSheets) < ${sheet} then error "no sheet ${sheet}"`,
    `  set sh to item ${sheet} of theSheets`,
    `  if (count of tables of sh) < ${table} then error "no table ${table} on sheet ${sheet}"`,
    `  set tbl to table ${table} of sh`,
  ];

  if (opts.action === "list") {
    const body = [
      `  set out to ""`,
      `  set i to 0`,
      `  repeat with t in tables of sheet ${sheet} of doc`,
      `    set i to i + 1`,
      `    set nm to ""`,
      `    try`,
      `      set nm to name of t`,
      `    end try`,
      `    set fr to footer row count of t`,
      `    set fhr to false`,
      `    set fhc to false`,
      `    try`,
      `      set fhr to header rows frozen of t`,
      `      set fhc to header columns frozen of t`,
      `    end try`,
      `    set px to 0`,
      `    set py to 0`,
      `    set ww to 0`,
      `    set hh to 0`,
      `    set rot to 0`,
      `    set opa to 100`,
      `    set lk to false`,
      `    try`,
      `      set pos to position of t`,
      `      set px to item 1 of pos`,
      `      set py to item 2 of pos`,
      `      set ww to width of t`,
      `      set hh to height of t`,
      `      set rot to rotation of t`,
      `      set opa to opacity of t`,
      `      set lk to locked of t`,
      `    end try`,
      `    set out to out & (i as text) & (ASCII character 30) & nm & (ASCII character 30) & (row count of t as text) & (ASCII character 30) & (column count of t as text) & (ASCII character 30) & (header row count of t as text) & (ASCII character 30) & (header column count of t as text) & (ASCII character 30) & (fr as text) & (ASCII character 30) & (fhr as text) & (ASCII character 30) & (fhc as text) & (ASCII character 30) & (px as text) & (ASCII character 30) & (py as text) & (ASCII character 30) & (ww as text) & (ASCII character 30) & (hh as text) & (ASCII character 30) & (rot as text) & (ASCII character 30) & (opa as text) & (ASCII character 30) & (lk as text) & (ASCII character 31)`,
      `  end repeat`,
      `  return out`,
    ];
    const res = await runAppleScript(appScript(NUMBERS, doc, body), 130_000);
    if (!res.ok) return bad(explainFailure(res, NUMBERS.label));
    const rows = parseRecords(res.out);
    if (!rows.length) return ok(`Sheet ${sheet} of ${path.basename(doc)} has no tables.`);
    const lines = rows.map(
      (r) =>
        `  ${String(r[0]).padStart(2)}  ${(r[1] || "(unnamed)").padEnd(22)} ` +
        `${r[2]} rows x ${r[3]} cols  (${r[4]} header row(s), ${r[5]} header col(s), ${r[6]} footer row(s))` +
        `  frozen rows:${r[7]} cols:${r[8]}  ${r[11]}x${r[12]} at (${r[9]}, ${r[10]})` +
        `${r[13] && r[13] !== "0" ? ` rot=${r[13]}°` : ""}${r[14] && r[14] !== "100" ? ` opacity=${r[14]}%` : ""}${r[15] === "true" ? " locked" : ""}`,
    );
    return ok(`Tables on sheet ${sheet} of ${path.basename(doc)}:\n${lines.join("\n")}`);
  }

  if (opts.action === "add") {
    const rows = opts.rows ?? 10;
    const cols = opts.cols ?? 4;
    const nameProp = opts.name ? `, name:${asLit(opts.name)}` : "";
    const body = [
      `  set t to make new table at end of sheet ${sheet} of doc with properties {row count:${rows}, column count:${cols}${nameProp}}`,
      `  save doc`,
      `  return "ok"`,
    ];
    const res = await runAppleScript(appScript(NUMBERS, doc, body), 130_000);
    if (!res.ok) return bad(explainFailure(res, NUMBERS.label));
    return ok(`Added a ${rows}x${cols} table to sheet ${sheet}.`);
  }

  if (opts.action === "delete") {
    const body = [...preamble, `  delete tbl`, `  save doc`, `  return "ok"`];
    const res = await runAppleScript(appScript(NUMBERS, doc, body), 130_000);
    if (!res.ok) return bad(explainFailure(res, NUMBERS.label));
    return ok(`Deleted table ${table} from sheet ${sheet}.`);
  }

  if (opts.action === "resize") {
    if (!opts.rows && !opts.cols) return bad("ERROR: action=resize needs `rows` and/or `cols`.");
    const body = [
      ...preamble,
      opts.rows ? `  set row count of tbl to ${opts.rows}` : "",
      opts.cols ? `  set column count of tbl to ${opts.cols}` : "",
      `  save doc`,
      `  return ((row count of tbl) as text) & "x" & ((column count of tbl) as text)`,
    ];
    const res = await runAppleScript(appScript(NUMBERS, doc, body), 130_000);
    if (!res.ok) return bad(explainFailure(res, NUMBERS.label));
    return ok(`Resized table ${table} to ${res.out.trim()}.`);
  }

  // Numbers has native structural commands - no value shifting needed.
  if (opts.action === "addRow" || opts.action === "addColumn") {
    const isRow = opts.action === "addRow";
    if (!opts.row && !opts.col) {
      return bad(`ERROR: action=${opts.action} needs a 1-based \`${isRow ? "row" : "col"}\` anchor.`);
    }
    const anchor = isRow
      ? `row ${opts.row} of tbl`
      : `column ${opts.col} of tbl`;
    const position = opts.position ?? (isRow ? "below" : "after");
    const valid = isRow ? ["above", "below"] : ["before", "after"];
    if (!valid.includes(position)) {
      return bad(`ERROR: action=${opts.action} position must be one of ${valid.join(", ")}.`);
    }
    const verb = isRow
      ? position === "above" ? "add row above" : "add row below"
      : position === "before" ? "add column before" : "add column after";

    const body = [...preamble, `  ${verb} ${anchor}`, `  save doc`, `  return "ok"`];
    const res = await runAppleScript(appScript(NUMBERS, doc, body), 130_000);
    if (!res.ok) return bad(explainFailure(res, NUMBERS.label));
    return ok(`Inserted a ${isRow ? "row" : "column"} ${position} ${isRow ? `row ${opts.row}` : `column ${opts.col}`}.`);
  }

  if (opts.action === "deleteRow" || opts.action === "deleteColumn") {
    const isRow = opts.action === "deleteRow";
    if (!opts.row && !opts.col) {
      return bad(`ERROR: action=${opts.action} needs a 1-based \`${isRow ? "row" : "col"}\`.`);
    }
    const body = [
      ...preamble,
      `  delete ${isRow ? `row ${opts.row}` : `column ${opts.col}`} of tbl`,
      `  save doc`,
      `  return "ok"`,
    ];
    const res = await runAppleScript(appScript(NUMBERS, doc, body), 130_000);
    if (!res.ok) return bad(explainFailure(res, NUMBERS.label));
    return ok(`Deleted ${isRow ? "row" : "column"} ${isRow ? opts.row : opts.col} from table ${table}.`);
  }

  if (opts.action === "transpose") {
    const body = [...preamble, `  transpose tbl`, `  save doc`, `  return "ok"`];
    const res = await runAppleScript(appScript(NUMBERS, doc, body), 130_000);
    if (!res.ok) return bad(explainFailure(res, NUMBERS.label));
    return ok(`Transposed table ${table} (rows and columns swapped).`);
  }

  if (opts.action === "sort") {
    if (!opts.by) return bad("ERROR: action=sort needs a 1-based `by` column.");
    const direction = opts.direction ?? "ascending";
    const body = [
      ...preamble,
      `  sort tbl by (column ${opts.by} of tbl) direction ${direction}`,
      `  save doc`,
      `  return "ok"`,
    ];
    const res = await runAppleScript(appScript(NUMBERS, doc, body), 130_000);
    if (!res.ok) return bad(explainFailure(res, NUMBERS.label));
    return ok(`Sorted table ${table} by column ${opts.by}, ${direction}.`);
  }

  if (opts.action === "merge" || opts.action === "unmerge") {
    if (!opts.range) return bad(`ERROR: action=${opts.action} needs a \`range\` like "A1:B2".`);
    let ref: string;
    try {
      const r = parseA1Range(opts.range);
      ref = `${colLetter(r.col)}${r.row}:${colLetter(r.col + r.cols - 1)}${r.row + r.rows - 1}`;
    } catch (err) {
      return bad(`ERROR: ${(err as Error).message}`);
    }
    const body = [
      ...preamble,
      `  ${opts.action === "merge" ? "merge" : "unmerge"} (range ${asLit(ref)} of tbl)`,
      `  save doc`,
      `  return "ok"`,
    ];
    const res = await runAppleScript(appScript(NUMBERS, doc, body), 130_000);
    if (!res.ok) return bad(explainFailure(res, NUMBERS.label));
    return ok(`${opts.action === "merge" ? "Merged" : "Unmerged"} ${ref} in table ${table}.`);
  }

  // format
  let fillRgb: [number, number, number] | null = null;
  let textRgb: [number, number, number] | null = null;
  try {
    if (opts.fill) fillRgb = hexToApple(opts.fill);
    if (opts.color) textRgb = hexToApple(opts.color);
  } catch (err) {
    return bad(`ERROR: ${(err as Error).message}`);
  }

  const bounds = (() => {
    if (!opts.range) return null;
    try {
      return parseA1Range(opts.range);
    } catch {
      return null;
    }
  })();

  const body: string[] = [...preamble];
  if (opts.headerRows !== undefined) body.push(`  set header row count of tbl to ${opts.headerRows}`);
  if (opts.headerCols !== undefined) body.push(`  set header column count of tbl to ${opts.headerCols}`);
  if (opts.footerRows !== undefined) body.push(`  set footer row count of tbl to ${opts.footerRows}`);
  if (opts.freezeHeaderRows !== undefined) body.push(`  set header rows frozen of tbl to ${opts.freezeHeaderRows}`);
  if (opts.freezeHeaderCols !== undefined) body.push(`  set header columns frozen of tbl to ${opts.freezeHeaderCols}`);
  if (opts.filtered !== undefined) body.push(`  set filtered of tbl to ${opts.filtered}`);
  if (opts.name !== undefined) body.push(`  set name of tbl to ${asLit(opts.name)}`);
  if (opts.x !== undefined && opts.y !== undefined) body.push(`  set position of tbl to {${Math.round(opts.x)}, ${Math.round(opts.y)}}`);
  if (opts.width !== undefined) body.push(`  set width of tbl to ${Math.round(opts.width)}`);
  if (opts.height !== undefined) body.push(`  set height of tbl to ${Math.round(opts.height)}`);
  if (opts.rotation !== undefined) body.push(`  set rotation of tbl to ${Math.round(opts.rotation)}`);
  if (opts.opacity !== undefined) body.push(`  set opacity of tbl to ${Math.round(opts.opacity)}`);
  if (opts.locked !== undefined) body.push(`  set locked of tbl to ${opts.locked}`);

  const propLines = [
    opts.font ? `set font name of r to ${asLit(opts.font)}` : "",
    opts.size ? `set font size of r to ${opts.size}` : "",
    textRgb ? `set text color of r to {${textRgb.join(", ")}}` : "",
    fillRgb ? `set background color of r to {${fillRgb.join(", ")}}` : "",
    opts.align ? `set alignment of r to ${opts.align}` : "",
    opts.verticalAlign ? `set vertical alignment of r to ${opts.verticalAlign}` : "",
    opts.textWrap !== undefined ? `set text wrap of r to ${opts.textWrap}` : "",
    opts.cellFormat ? `set format of r to ${opts.cellFormat}` : "",
  ].filter(Boolean);

  if (propLines.length) {
    const rangeExpr = bounds
      ? `range ${asLit(`${colLetter(bounds.col)}${bounds.row}:${colLetter(bounds.col + bounds.cols - 1)}${bounds.row + bounds.rows - 1}`)} of tbl`
      : `cell range of tbl`;
    body.push(`  set r to ${rangeExpr}`, ...propLines.map((l) => `  ${l}`));
  }

  (opts.columnWidths ?? []).forEach((w, i) => {
    if (!w) return;
    body.push(`  if (column count of tbl) \u2265 ${i + 1} then set width of column ${i + 1} of tbl to ${Math.round(w)}`);
  });
  (opts.rowHeights ?? []).forEach((h, i) => {
    if (!h) return;
    body.push(`  if (row count of tbl) \u2265 ${i + 1} then set height of row ${i + 1} of tbl to ${Math.round(h)}`);
  });

  if (body.length === preamble.length) {
    return bad("ERROR: action=format needs formatting, header/footer/freeze, geometry, name, or row/column sizing options.");
  }

  body.push(`  save doc`, `  return "ok"`);
  const res = await runAppleScript(appScript(NUMBERS, doc, body), 180_000);
  if (!res.ok) return bad(explainFailure(res, NUMBERS.label));
  return ok(`Reformatted ${bounds ? `range ${opts.range} of ` : ""}table ${table} on sheet ${sheet}.`);
}

// --- numbers_cells ---------------------------------------------------------

export type CellAction = "get" | "inspect" | "formula" | "set" | "setRange" | "clear";

export interface CellOptions {
  path?: string;
  action: CellAction;
  sheet?: number;
  table?: number;
  cell?: string;
  range?: string;
  value?: string;
  values?: string[][];
  formatted?: boolean;
}

export async function numbersCells(opts: CellOptions): Promise<Result> {
  const missing = requireApp(NUMBERS);
  if (missing) return missing;
  const doc = target(opts.path);
  if (failed(doc)) return doc;

  const sheet = opts.sheet ?? 1;
  const table = opts.table ?? 1;
  const preamble = [
    `  set theSheets to sheets of doc`,
    `  if (count of theSheets) < ${sheet} then error "no sheet ${sheet}"`,
    `  set sh to item ${sheet} of theSheets`,
    `  if (count of tables of sh) < ${table} then error "no table ${table} on sheet ${sheet}"`,
    `  set tbl to table ${table} of sh`,
  ];

  // ---- get ----------------------------------------------------------------
  if (opts.action === "get") {
    const ref = opts.range ?? opts.cell;
    if (!ref) return bad("ERROR: action=get needs `cell` (e.g. B4) or `range` (e.g. A1:C10).");
    let b: { row: number; col: number; rows: number; cols: number };
    try {
      b = parseA1Range(ref);
    } catch (err) {
      return bad(`ERROR: ${(err as Error).message}`);
    }

    const body = [
      ...preamble,
      `  set out to ""`,
      `  set r0 to ${b.row}`,
      `  set c0 to ${b.col}`,
      `  set r1 to ${b.row + b.rows - 1}`,
      `  set c1 to ${b.col + b.cols - 1}`,
      `  repeat with c in cells of tbl`,
      `    try`,
      `      set rr to address of row of c`,
      `      set cc to address of column of c`,
      `      if rr \u2265 r0 and rr \u2264 r1 and cc \u2265 c0 and cc \u2264 c1 then`,
      `        set v to ""`,
      `        try`,
      opts.formatted
        ? `          set v to formatted value of c`
        : `          set vv to value of c`,
      opts.formatted ? "" : `          if vv is not missing value then set v to (vv as text)`,
      `        end try`,
      `        set out to out & (rr as text) & (ASCII character 30) & (cc as text) & (ASCII character 30) & v & (ASCII character 31)`,
      `      end if`,
      `    end try`,
      `  end repeat`,
      `  return out`,
    ];

    const res = await runAppleScript(appScript(NUMBERS, doc, body), 180_000);
    if (!res.ok) return bad(explainFailure(res, NUMBERS.label));

    const grid: string[][] = Array.from({ length: b.rows }, () => Array(b.cols).fill(""));
    for (const r of parseRecords(res.out)) {
      const row = Number(r[0]) - b.row;
      const col = Number(r[1]) - b.col;
      if (row >= 0 && row < b.rows && col >= 0 && col < b.cols) grid[row][col] = r[2] ?? "";
    }

    if (b.rows === 1 && b.cols === 1) return ok(`${ref.toUpperCase()} = ${JSON.stringify(grid[0][0])}`);
    const header = `     ${Array.from({ length: b.cols }, (_, i) => colLetter(b.col + i).padStart(10)).join("")}`;
    const lines = grid.map(
      (row, i) => `${String(b.row + i).padStart(3)}  ${row.map((v) => v.slice(0, 9).padStart(10)).join("")}`,
    );
    return ok(`${opts.range ?? ref} on table ${table}, sheet ${sheet}:\n${header}\n${lines.join("\n")}`);
  }

  // ---- inspect / formula ---------------------------------------------------
  if (opts.action === "inspect" || opts.action === "formula") {
    const ref = opts.range ?? opts.cell;
    if (!ref) return bad(`ERROR: action=${opts.action} needs cell or range.`);
    let b: { row: number; col: number; rows: number; cols: number };
    try {
      b = parseA1Range(ref);
    } catch (err) {
      return bad(`ERROR: ${(err as Error).message}`);
    }
    const ref2 = `${colLetter(b.col)}${b.row}:${colLetter(b.col + b.cols - 1)}${b.row + b.rows - 1}`;
    const body = [
      ...preamble,
      `  set rr to range ${asLit(ref2)} of tbl`,
      `  set out to ""`,
      `  repeat with c in cells of rr`,
      `    set nm to name of c`,
      `    set rawv to ""`,
      `    set fmtv to ""`,
      `    set frm to ""`,
      `    set cfmt to ""`,
      `    set hAlign to ""`,
      `    set vAlign to ""`,
      `    set wr to false`,
      `    try`,
      `      set vv to value of c`,
      `      if vv is not missing value then set rawv to vv as text`,
      `    end try`,
      `    try`,
      `      set vv to formatted value of c`,
      `      if vv is not missing value then set fmtv to vv as text`,
      `    end try`,
      `    try`,
      `      set vv to formula of c`,
      `      if vv is not missing value then set frm to vv as text`,
      `    end try`,
      `    try`,
      `      set cfmt to format of c as text`,
      `      set hAlign to alignment of c as text`,
      `      set vAlign to vertical alignment of c as text`,
      `      set wr to text wrap of c`,
      `    end try`,
      `    set out to out & nm & (ASCII character 30) & rawv & (ASCII character 30) & fmtv & (ASCII character 30) & frm & (ASCII character 30) & cfmt & (ASCII character 30) & hAlign & (ASCII character 30) & vAlign & (ASCII character 30) & (wr as text) & (ASCII character 31)`,
      `  end repeat`,
      `  return out`,
    ];
    const res = await runAppleScript(appScript(NUMBERS, doc, body), 180_000);
    if (!res.ok) return bad(explainFailure(res, NUMBERS.label));
    const rows = parseRecords(res.out);
    if (opts.action === "formula") {
      const lines = rows.map((r) => `${r[0]} = ${r[3] ? r[3] : "(no formula)"}`);
      return ok(`Formulas in ${ref2}:\n${lines.join("\n")}`);
    }
    const lines = rows.map(
      (r) =>
        `${r[0]} raw=${JSON.stringify(r[1] ?? "")} display=${JSON.stringify(r[2] ?? "")} formula=${JSON.stringify(r[3] ?? "")}` +
        ` format=${r[4] || "?"} align=${r[5] || "?"}/${r[6] || "?"} wrap=${r[7] || "?"}`,
    );
    return ok(`Cell inspection for ${ref2}:\n${lines.join("\n")}`);
  }

  // ---- set ----------------------------------------------------------------
  if (opts.action === "set") {
    if (!opts.cell) return bad("ERROR: action=set needs `cell` like B4.");
    if (opts.value === undefined) return bad("ERROR: action=set needs `value`.");
    try {
      parseA1(opts.cell);
    } catch (err) {
      return bad(`ERROR: ${(err as Error).message}`);
    }
    const body = [
      ...preamble,
      `  set value of cell ${asLit(opts.cell.toUpperCase())} of tbl to ${valueLiteral(opts.value)}`,
      `  save doc`,
      `  return "ok"`,
    ];
    const res = await runAppleScript(appScript(NUMBERS, doc, body), 130_000);
    if (!res.ok) return bad(explainFailure(res, NUMBERS.label));
    return ok(`Set ${opts.cell.toUpperCase()} to ${JSON.stringify(opts.value)} on table ${table}, sheet ${sheet}.`);
  }

  // ---- setRange -----------------------------------------------------------
  if (opts.action === "setRange") {
    if (!opts.values?.length) return bad("ERROR: action=setRange needs a `values` grid.");
    if (!opts.cell && !opts.range) return bad("ERROR: action=setRange needs a starting `cell` or a `range`.");
    let b: { row: number; col: number; rows: number; cols: number };
    try {
      b = parseA1Range(opts.range ?? opts.cell!);
    } catch (err) {
      return bad(`ERROR: ${(err as Error).message}`);
    }

    const literal = `{${opts.values
      .map((row) => `{${row.map((v) => valueLiteral(v)).join(", ")}}`)
      .join(", ")}}`;

    const body = [
      ...preamble,
      `  set theGrid to ${literal}`,
      `  set r0 to ${b.row}`,
      `  set c0 to ${b.col}`,
      `  repeat with ri from 1 to (count of theGrid)`,
      `    set rowVals to item ri of theGrid`,
      `    repeat with ci from 1 to (count of rowVals)`,
      `      set tr to r0 + ri - 1`,
      `      set tc to c0 + ci - 1`,
      `      if tr \u2264 (row count of tbl) and tc \u2264 (column count of tbl) then`,
      `        try`,
      `          set value of cell (tc) of row (tr) of tbl to (item ci of rowVals)`,
      `        end try`,
      `      end if`,
      `    end repeat`,
      `  end repeat`,
      `  save doc`,
      `  return "ok"`,
    ];
    const res = await runAppleScript(appScript(NUMBERS, doc, body), 180_000);
    if (!res.ok) return bad(explainFailure(res, NUMBERS.label));
    return ok(
      `Wrote ${opts.values.reduce((n, r) => n + r.length, 0)} value(s) into table ${table} from ` +
        `${colLetter(b.col)}${b.row}.`,
    );
  }

  // clear
  const ref = opts.range ?? opts.cell;
  if (!ref) return bad("ERROR: action=clear needs `cell` or `range`.");
  let bounds: { row: number; col: number; rows: number; cols: number };
  try {
    bounds = parseA1Range(ref);
  } catch (err) {
    return bad(`ERROR: ${(err as Error).message}`);
  }
  const ref2 = `${colLetter(bounds.col)}${bounds.row}:${colLetter(bounds.col + bounds.cols - 1)}${bounds.row + bounds.rows - 1}`;
  const body = [
    ...preamble,
    `  clear (range ${asLit(ref2)} of tbl)`,
    `  save doc`,
    `  return "ok"`,
  ];
  const res = await runAppleScript(appScript(NUMBERS, doc, body), 130_000);
  if (!res.ok) return bad(explainFailure(res, NUMBERS.label));
  return ok(`Cleared ${ref2} in table ${table} (values and formatting).`);
}
