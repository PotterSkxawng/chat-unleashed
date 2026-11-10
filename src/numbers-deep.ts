// Durable Numbers workflows: create, inspect, verify, find and stats.
// All operations use Numbers' native scripting dictionary; no UI coordinates.
import fs from "node:fs";
import path from "node:path";
import {
  IWORK_APPS,
  RS,
  US,
  appScript,
  asLit,
  bad,
  explainFailure,
  failed,
  ok,
  parseRecords,
  requireApp,
  resolveTarget,
  resolveUserPath,
  runAppleScript,
  type Result,
} from "./applescript.js";
import { colLetter } from "./numbers.js";

const NUMBERS = IWORK_APPS.numbers;

function valueLiteral(v: string): string {
  const t = v.trim();
  if (t.startsWith("=")) return asLit(t);
  if (/^-?\\d+(\\.\\d+)?$/.test(t)) return t;
  if (t === "true" || t === "false") return t;
  return asLit(v);
}

export interface NumbersCreateTable {
  name?: string;
  values: string[][];
  headerRows?: number;
  headerCols?: number;
  footerRows?: number;
  freezeHeaderRows?: boolean;
  freezeHeaderCols?: boolean;
  columnWidths?: number[];
  rowHeights?: number[];
}

export interface NumbersCreateSheet {
  name?: string;
  tables: NumbersCreateTable[];
}

export interface NumbersCreateOptions {
  path: string;
  template?: string;
  sheets: NumbersCreateSheet[];
  overwrite?: boolean;
}

export async function numbersCreate(opts: NumbersCreateOptions): Promise<Result> {
  const missing = requireApp(NUMBERS);
  if (missing) return missing;
  const dest = resolveUserPath(opts.path);
  if (!dest.toLowerCase().endsWith(".numbers")) return bad("ERROR: destination must end in .numbers: " + dest);
  if (fs.existsSync(dest) && !opts.overwrite) return bad("ERROR: destination exists; pass overwrite=true: " + dest);
  if (!opts.sheets || opts.sheets.length === 0) return bad("ERROR: at least one sheet is required.");
  for (let si = 0; si < opts.sheets.length; si++) {
    if (!opts.sheets[si].tables || opts.sheets[si].tables.length === 0) {
      return bad("ERROR: sheet " + (si + 1) + " needs at least one table.");
    }
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const lines: string[] = [
    "with timeout of 240 seconds",
    '  tell application id "' + NUMBERS.bundleId + '"',
    opts.template
      ? "  set doc to make new document with properties {document template:template " + asLit(opts.template) + "}"
      : "  set doc to make new document",
  ];

  for (let si = 0; si < opts.sheets.length; si++) {
    const sheet = opts.sheets[si];
    if (si === 0) {
      lines.push("  if (count of sheets of doc) is 0 then make new sheet at end of sheets of doc");
      lines.push("  set sh to sheet 1 of doc");
      if (sheet.name) lines.push("  set name of sh to " + asLit(sheet.name));
    } else {
      lines.push(
        "  set sh to make new sheet at end of sheets of doc" +
          (sheet.name ? " with properties {name:" + asLit(sheet.name) + "}" : ""),
      );
    }
    lines.push("  repeat while (count of tables of sh) > 0", "    delete table 1 of sh", "  end repeat");

    for (const table of sheet.tables) {
      const rows = Math.max(1, table.values.length);
      const cols = Math.max(1, ...table.values.map((row) => row.length));
      const props = ["row count:" + rows, "column count:" + cols];
      if (table.name) props.push("name:" + asLit(table.name));
      lines.push("  set tbl to make new table at end of sh with properties {" + props.join(", ") + "}");
      if (table.headerRows !== undefined) lines.push("  set header row count of tbl to " + table.headerRows);
      if (table.headerCols !== undefined) lines.push("  set header column count of tbl to " + table.headerCols);
      if (table.footerRows !== undefined) lines.push("  set footer row count of tbl to " + table.footerRows);
      if (table.freezeHeaderRows !== undefined) lines.push("  set header rows frozen of tbl to " + table.freezeHeaderRows);
      if (table.freezeHeaderCols !== undefined) lines.push("  set header columns frozen of tbl to " + table.freezeHeaderCols);
      (table.columnWidths || []).forEach((width, i) => {
        if (width > 0 && i < cols) lines.push("  set width of column " + (i + 1) + " of tbl to " + Math.round(width));
      });
      (table.rowHeights || []).forEach((height, i) => {
        if (height > 0 && i < rows) lines.push("  set height of row " + (i + 1) + " of tbl to " + Math.round(height));
      });
      table.values.forEach((row, ri) => {
        row.forEach((value, ci) => {
          lines.push(
            "  set value of cell " + asLit(colLetter(ci + 1) + (ri + 1)) + " of tbl to " + valueLiteral(value),
          );
        });
      });
    }
  }

  lines.push(
    "  save doc in POSIX file " + asLit(dest),
    "  return (count of sheets of doc) as text",
    "  end tell",
    "end timeout",
  );
  const res = await runAppleScript(lines.join("\\n"), 260_000);
  if (!res.ok) return bad(explainFailure(res, NUMBERS.label));
  const tables = opts.sheets.reduce((n, s) => n + s.tables.length, 0);
  const populated = opts.sheets.reduce(
    (n, s) => n + s.tables.reduce((m, t) => m + t.values.reduce((q, row) => q + row.length, 0), 0),
    0,
  );
  return ok(
    "Created " + dest + "\\nsheets: " + res.out.trim() + "   tables: " + tables + "   populated cells: " + populated +
      (opts.template ? "   template: " + opts.template : "") +
      "\\nsaved; left open in Numbers",
  );
}

export interface NumbersInspectOptions {
  path: string;
  maxCells?: number;
}

export async function numbersInspect(opts: NumbersInspectOptions): Promise<Result> {
  const missing = requireApp(NUMBERS);
  if (missing) return missing;
  const doc = resolveTarget(opts.path, ".numbers document");
  if (failed(doc)) return doc;
  const maxCells = Math.min(Math.max(opts.maxCells || 400, 1), 5000);
  const body = [
    '  set out to ""',
    "  set seen to 0",
    "  set si to 0",
    "  repeat with sh in sheets of doc",
    "    set si to si + 1",
    "    set ti to 0",
    "    repeat with tbl in tables of sh",
    "      set ti to ti + 1",
    '      set nm to ""',
    "      try",
    "        set nm to name of tbl",
    "      end try",
    "      set frzR to false",
    "      set frzC to false",
    "      set filt to false",
    "      try",
    "        set frzR to header rows frozen of tbl",
    "        set frzC to header columns frozen of tbl",
    "        set filt to filtered of tbl",
    "      end try",
    "      set pos to position of tbl",
    '      set out to out & "T" & (ASCII character 30) & (si as text) & (ASCII character 30) & (name of sh) & (ASCII character 30) & (ti as text) & (ASCII character 30) & nm & (ASCII character 30) & (row count of tbl as text) & (ASCII character 30) & (column count of tbl as text) & (ASCII character 30) & (header row count of tbl as text) & (ASCII character 30) & (header column count of tbl as text) & (ASCII character 30) & (footer row count of tbl as text) & (ASCII character 30) & (frzR as text) & (ASCII character 30) & (frzC as text) & (ASCII character 30) & (filt as text) & (ASCII character 30) & (item 1 of pos as text) & (ASCII character 30) & (item 2 of pos as text) & (ASCII character 30) & (width of tbl as text) & (ASCII character 30) & (height of tbl as text) & (ASCII character 30) & (rotation of tbl as text) & (ASCII character 30) & (opacity of tbl as text) & (ASCII character 30) & (locked of tbl as text) & (ASCII character 31)',
    "      repeat with c in cells of tbl",
    "        if seen is greater than or equal to " + maxCells + " then exit repeat",
    "        set seen to seen + 1",
    '        set rawv to ""',
    '        set fmtv to ""',
    '        set frm to ""',
    '        set cfmt to ""',
    '        set fn to ""',
    '        set fs to ""',
    '        set hal to ""',
    '        set val to ""',
    "        set wr to false",
    "        try",
    "          set vv to value of c",
    "          if vv is not missing value then set rawv to vv as text",
    "        end try",
    "        try",
    "          set vv to formatted value of c",
    "          if vv is not missing value then set fmtv to vv as text",
    "        end try",
    "        try",
    "          set vv to formula of c",
    "          if vv is not missing value then set frm to vv as text",
    "        end try",
    "        try",
    "          set cfmt to format of c as text",
    "          set fn to font name of c as text",
    "          set fs to font size of c as text",
    "          set hal to alignment of c as text",
    "          set val to vertical alignment of c as text",
    "          set wr to text wrap of c",
    "        end try",
    '        set out to out & "C" & (ASCII character 30) & (si as text) & (ASCII character 30) & (ti as text) & (ASCII character 30) & (name of c) & (ASCII character 30) & rawv & (ASCII character 30) & fmtv & (ASCII character 30) & frm & (ASCII character 30) & cfmt & (ASCII character 30) & fn & (ASCII character 30) & fs & (ASCII character 30) & hal & (ASCII character 30) & val & (ASCII character 30) & (wr as text) & (ASCII character 31)',
    "      end repeat",
    "    end repeat",
    "  end repeat",
    "  return out",
  ];
  const res = await runAppleScript(appScript(NUMBERS, doc, body), 220_000);
  if (!res.ok) return bad(explainFailure(res, NUMBERS.label));

  const lines: string[] = ["Numbers inspection: " + path.basename(doc)];
  let tableCount = 0;
  let cellCount = 0;
  for (const r of parseRecords(res.out)) {
    if (r[0] === "T") {
      tableCount++;
      lines.push(
        "",
        "sheet " + r[1] + " " + JSON.stringify(r[2]) + ", table " + r[3] + " " + JSON.stringify(r[4]) + ": " + r[5] + "x" + r[6],
        "  headers " + r[7] + "r/" + r[8] + "c, footers " + r[9] + "r, frozen " + r[10] + "/" + r[11] + ", filtered " + r[12],
        "  geometry " + r[15] + "x" + r[16] + " at (" + r[13] + ", " + r[14] + "), rotation " + r[17] + " deg, opacity " + r[18] + "%, locked " + r[19],
      );
    } else if (r[0] === "C") {
      cellCount++;
      if (!(r[4] || r[6])) continue;
      lines.push(
        "    " + r[3] + " raw=" + JSON.stringify(r[4] || "") + " display=" + JSON.stringify(r[5] || "") +
          (r[6] ? " formula=" + JSON.stringify(r[6]) : "") +
          " format=" + (r[7] || "?") + " " + (r[8] || "?") + "@" + (r[9] || "?") +
          " align=" + (r[10] || "?") + "/" + (r[11] || "?") + " wrap=" + (r[12] || "?"),
      );
    }
  }
  lines.push("", "tables: " + tableCount + "   cells scanned: " + cellCount + (cellCount >= maxCells ? " (cap reached)" : ""));
  return ok(lines.join("\\n"));
}

export interface NumbersVerifyOptions {
  path: string;
  expectSheets?: number;
  expectTables?: number;
  maxCells?: number;
  maxIssues?: number;
}

export async function numbersVerify(opts: NumbersVerifyOptions): Promise<Result> {
  const missing = requireApp(NUMBERS);
  if (missing) return missing;
  const doc = resolveTarget(opts.path, ".numbers document");
  if (failed(doc)) return doc;
  const maxCells = Math.min(Math.max(opts.maxCells || 5000, 1), 20000);
  const maxIssues = Math.min(Math.max(opts.maxIssues || 40, 1), 200);
  const body = [
    '  set issues to ""',
    "  set sheetCount to count of sheets of doc",
    "  set tableCount to 0",
    "  set scanned to 0",
    "  repeat with sh in sheets of doc",
    "    repeat with tbl in tables of sh",
    "      set tableCount to tableCount + 1",
    "      set rr to row count of tbl",
    "      set cc to column count of tbl",
    "      set hr to header row count of tbl",
    "      set hc to header column count of tbl",
    "      set fr to footer row count of tbl",
    '      if rr < 1 or cc < 1 or hr > rr or fr > rr or hc > cc then set issues to issues & "STRUCT" & (ASCII character 30) & (name of sh) & (ASCII character 30) & (name of tbl) & (ASCII character 30) & (rr as text) & "x" & (cc as text) & (ASCII character 31)',
    "      repeat with c in cells of tbl",
    "        if scanned is greater than or equal to " + maxCells + " then exit repeat",
    "        set scanned to scanned + 1",
    '        set fv to ""',
    "        try",
    "          set vv to formatted value of c",
    "          if vv is not missing value then set fv to vv as text",
    "        end try",
    '        if fv starts with "#" then set issues to issues & "ERR" & (ASCII character 30) & (name of sh) & (ASCII character 30) & (name of tbl) & (ASCII character 30) & (name of c) & (ASCII character 30) & fv & (ASCII character 31)',
    "      end repeat",
    "    end repeat",
    "  end repeat",
    '  return (sheetCount as text) & (ASCII character 29) & (tableCount as text) & (ASCII character 29) & (scanned as text) & (ASCII character 29) & issues',
  ];
  const res = await runAppleScript(appScript(NUMBERS, doc, body), 240_000);
  if (!res.ok) return bad(explainFailure(res, NUMBERS.label));
  const parts = res.out.split(String.fromCharCode(29));
  const sheets = Number(parts[0] || 0);
  const tables = Number(parts[1] || 0);
  const scanned = Number(parts[2] || 0);
  const issues: string[] = [];
  if (opts.expectSheets !== undefined && sheets !== opts.expectSheets) issues.push("expected " + opts.expectSheets + " sheets, found " + sheets);
  if (opts.expectTables !== undefined && tables !== opts.expectTables) issues.push("expected " + opts.expectTables + " tables, found " + tables);
  if (sheets < 1) issues.push("document has no sheets");
  if (tables < 1) issues.push("document has no tables");
  for (const r of parseRecords(parts[3] || "")) {
    if (r[0] === "STRUCT") issues.push("invalid table structure: " + r[1] + " / " + r[2] + " / " + r[3]);
    if (r[0] === "ERR") issues.push("cell error " + r[4] + " at " + r[1] + " / " + r[2] + " / " + r[3]);
    if (issues.length >= maxIssues) break;
  }
  const lines = [
    (issues.length ? "FAIL: " : "PASS: ") + path.basename(doc),
    "sheets: " + sheets + "   tables: " + tables + "   cells scanned: " + scanned + (scanned >= maxCells ? " (cap reached)" : ""),
  ];
  if (issues.length) lines.push("issues:", ...issues.map((x) => "  - " + x));
  else lines.push("No structural or spreadsheet-error values found in the scanned cells.");
  return issues.length ? bad(lines.join("\\n")) : ok(lines.join("\\n"));
}

export interface NumbersFindOptions {
  path: string;
  text: string;
  formulas?: boolean;
  maxResults?: number;
}

export async function numbersFind(opts: NumbersFindOptions): Promise<Result> {
  const missing = requireApp(NUMBERS);
  if (missing) return missing;
  const doc = resolveTarget(opts.path, ".numbers document");
  if (failed(doc)) return doc;
  if (!opts.text) return bad("ERROR: text is required.");
  const limit = Math.min(Math.max(opts.maxResults || 50, 1), 500);
  const needle = asLit(opts.text.toLowerCase());
  const source = opts.formulas ? "formula of c" : "formatted value of c";
  const body = [
    '  set out to ""',
    "  set hits to 0",
    "  repeat with sh in sheets of doc",
    "    repeat with tbl in tables of sh",
    "      repeat with c in cells of tbl",
    '        set hay to ""',
    "        try",
    "          set vv to " + source,
    "          if vv is not missing value then set hay to vv as text",
    "        end try",
    '        ignoring case',
    "          if hay contains " + needle + " then",
    '            set out to out & (name of sh) & (ASCII character 30) & (name of tbl) & (ASCII character 30) & (name of c) & (ASCII character 30) & hay & (ASCII character 31)',
    "            set hits to hits + 1",
    "            if hits is greater than or equal to " + limit + " then return out",
    "          end if",
    "        end ignoring",
    "      end repeat",
    "    end repeat",
    "  end repeat",
    "  return out",
  ];
  const res = await runAppleScript(appScript(NUMBERS, doc, body), 220_000);
  if (!res.ok) return bad(explainFailure(res, NUMBERS.label));
  const hits = parseRecords(res.out);
  if (!hits.length) return ok("No matches for " + JSON.stringify(opts.text) + ".");
  return ok(
    "Matches for " + JSON.stringify(opts.text) + (opts.formulas ? " in formulas" : "") + ":\\n" +
      hits.map((r) => "  " + r[0] + " / " + r[1] + " / " + r[2] + ": " + (r[3] || "").slice(0, 180)).join("\\n"),
  );
}

export async function numbersStats(opts: { path: string }): Promise<Result> {
  const missing = requireApp(NUMBERS);
  if (missing) return missing;
  const doc = resolveTarget(opts.path, ".numbers document");
  if (failed(doc)) return doc;
  const body = [
    "  set ns to count of sheets of doc",
    "  set nt to 0",
    "  set nc to 0",
    "  set nf to 0",
    "  set nonempty to 0",
    "  repeat with sh in sheets of doc",
    "    repeat with tbl in tables of sh",
    "      set nt to nt + 1",
    "      repeat with c in cells of tbl",
    "        set nc to nc + 1",
    "        try",
    "          if value of c is not missing value then set nonempty to nonempty + 1",
    "        end try",
    "        try",
    "          if formula of c is not missing value then set nf to nf + 1",
    "        end try",
    "      end repeat",
    "    end repeat",
    "  end repeat",
    '  return (ns as text) & (ASCII character 30) & (nt as text) & (ASCII character 30) & (nc as text) & (ASCII character 30) & (nonempty as text) & (ASCII character 30) & (nf as text)',
  ];
  const res = await runAppleScript(appScript(NUMBERS, doc, body), 220_000);
  if (!res.ok) return bad(explainFailure(res, NUMBERS.label));
  const f = res.out.split(US);
  return ok(
    path.basename(doc) + "\\n  sheets      " + f[0] + "\\n  tables      " + f[1] + "\\n  cells       " + f[2] +
      "\\n  non-empty   " + f[3] + "\\n  formulas    " + f[4],
  );
}
