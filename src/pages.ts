// Native Pages automation.
//
// Drives the real Pages app over Apple Events (osascript). No Word, no docx, no
// converters: every call edits actual text inside an actual .pages document, so
// the result stays a normal Pages file that the user can open and keep editing.
//
// HARD RULE: this module never closes a document and never quits Pages. There is
// no `close` and no `quit` anywhere below - documents stay exactly as the user
// left them, and anything created here is left open for them to look at.
//
// Pages' scripting dictionary is deliberately small. It exposes rich text
// (font/size/color), paragraphs, sections, pages, text items, tables and export,
// but *not* paragraph styles. So the style layer below resolves a named preset
// (or explicit overrides) into a concrete type scale and applies font + size +
// colour per paragraph. Tables get the real thing: header rows/columns, cell
// values, fills, alignment and column widths.
//
// macOS gates Apple Events behind TCC (Privacy & Security -> Automation). The
// first call from the host app raises a one-time prompt; if it was denied every
// call fails with -1743 / -10004 and pages_status() explains the fix.
import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appHome } from "./config.js";
import { applicationCandidates, findApplicationByBundleId } from "./mac-paths.js";

export const PAGES_BUNDLE_ID = "com.apple.Pages";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_PARAGRAPH_STYLE = 2000; // bulk reads made large documents practical

/** Field/record separators so one AppleScript run can return structured rows. */
const US = String.fromCharCode(30);
const RS = String.fromCharCode(31);

const APP_CANDIDATES = applicationCandidates("Pages Creator Studio.app", "Pages.app");

export type Result = { ok: boolean; message: string };
const ok = (message: string): Result => ({ ok: true, message });
const bad = (message: string): Result => ({ ok: false, message });

// --- app discovery ---------------------------------------------------------

let cachedApp: string | null | undefined;

export function findPagesApp(): string | null {
  if (cachedApp !== undefined) return cachedApp;
  cachedApp = findApplicationByBundleId(PAGES_BUNDLE_ID, APP_CANDIDATES);
  return cachedApp;
}

function appVersion(appPath: string): string {
  // Info.plist ships as a binary plist, so read it through plutil rather than regex.
  try {
    const out = execFileSync("/usr/bin/plutil", [
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      "-o",
      "-",
      path.join(appPath, "Contents", "Info.plist"),
    ]);
    const version = out.toString("utf8").trim();
    return version || "unknown";
  } catch {
    return "unknown";
  }
}

function isPagesRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("/usr/bin/pgrep", ["-x", "Pages"], (err, stdout) => {
      resolve(!err && stdout.trim().length > 0);
    });
  });
}

// --- AppleScript plumbing --------------------------------------------------

export interface AsResult {
  ok: boolean;
  out: string;
  error?: string;
  code?: number;
}

function runAppleScript(source: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<AsResult> {
  // Offline validation hooks (no Apple Events, no Pages interaction):
  //   PAGES_DUMP_DIR=/tmp/x  -> write every generated script to disk
  //   PAGES_DRY_RUN=1        -> also skip execution entirely
  const dumpDir = process.env.APPLESCRIPT_DUMP_DIR ?? process.env.PAGES_DUMP_DIR;
  if (dumpDir) {
    try {
      fs.mkdirSync(dumpDir, { recursive: true });
      const name = `script-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.applescript`;
      fs.writeFileSync(path.join(dumpDir, name), source, "utf8");
    } catch {
      /* diagnostics only */
    }
  }
  if (process.env.APPLESCRIPT_DRY_RUN === "1" || process.env.PAGES_DRY_RUN === "1") {
    return Promise.resolve({ ok: true, out: "" });
  }

  // osascript -e is bounded by the kernel's argument size. A document with a
  // few hundred paragraphs generates a script past that limit, so spill to a
  // temp file once the source gets big. This is what makes large edits reliable
  // instead of failing with "argument list too long".
  let args = ["-e", source];
  let tempScript: string | null = null;
  if (source.length > 60_000) {
    try {
      tempScript = path.join(os.tmpdir(), `pages-${process.pid}-${Date.now()}.applescript`);
      fs.writeFileSync(tempScript, source, "utf8");
      args = [tempScript];
    } catch {
      tempScript = null;
      args = ["-e", source];
    }
  }

  return new Promise((resolve) => {
    const child = spawn("/usr/bin/osascript", args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;

    const finish = (result: AsResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (tempScript) {
        try {
          fs.unlinkSync(tempScript);
        } catch {
          /* best effort */
        }
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish({ ok: false, out: "", error: `AppleScript timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);

    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => finish({ ok: false, out: "", error: e.message }));
    child.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8").replace(/\n$/, "");
      const stderr = Buffer.concat(err).toString("utf8").trim();
      if (code === 0) {
        finish({ ok: true, out: stdout });
        return;
      }
      const match = /\((-?\d{3,5})\)\s*$/.exec(stderr);
      finish({
        ok: false,
        out: stdout,
        error: stderr || `osascript exited with ${code}`,
        code: match ? Number(match[1]) : undefined,
      });
    });
  });
}

/** Parent chain, so the permission message can name the app macOS will ask about. */
function processAncestry(): string[] {
  const names: string[] = [];
  let pid = process.pid;
  for (let i = 0; i < 6 && pid > 1; i++) {
    try {
      const out = execFileSync("/bin/ps", ["-o", "ppid=,comm=", "-p", String(pid)]).toString().trim();
      const match = /^(\d+)\s+(.*)$/.exec(out);
      if (!match) break;
      names.push(path.basename(match[2]));
      pid = Number(match[1]);
    } catch {
      break;
    }
  }
  return names;
}

/** Turn an AppleScript failure into something the calling model can act on. */
function explainFailure(res: AsResult): string {
  const code = res.code;
  const detail = res.error ?? "unknown error";
  if (code === -1743 || code === -10004) {
    const chain = processAncestry();
    const chainNote = chain.length ? ` (process chain: ${chain.join(" <- ")})` : "";
    return (
      `ERROR: macOS blocked automation of Pages (${code}).\n` +
      `The app that hosts this MCP server needs a one-time Automation grant:\n` +
      `  1. System Settings -> Privacy & Security -> Automation\n` +
      `  2. Find the host app in the list${chainNote} and switch "Pages Creator Studio" on.\n` +
      `     If it is not listed, click "+" and add the host app; mac_permissions action=status prints its path.\n` +
      `  3. Retry the call - no restart needed.\n` +
      `Open the pane: open "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"\n` +
      `raw: ${detail}`
    );
  }
  if (code === -1728) return `ERROR: Pages could not find that object - is the document still open? (${detail})`;
  if (code === -1708) return `ERROR: Pages does not support that command in its current state. (${detail})`;
  if (code === -609) return `ERROR: lost the connection to Pages - it probably quit or crashed. (${detail})`;
  if (code === -128) return `ERROR: cancelled (a Pages dialog may be waiting for input). (${detail})`;
  return `ERROR: ${detail}`;
}

function requireApp(): Result | null {
  if (!findPagesApp()) {
    return bad(
      "ERROR: Pages is not installed or is not registered with macOS Launch Services. Install Pages, launch it once, then retry.",
    );
  }
  return null;
}

function asLit(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** AppleScript number list, keeping one decimal so half-point sizes survive. */
function numList(values: number[]): string {
  return `{${values.map((v) => String(Math.round(v * 10) / 10)).join(", ")}}`;
}

function strList(values: string[]): string {
  return `{${values.map(asLit).join(", ")}}`;
}

function colorList(values: Array<[number, number, number]>): string {
  return `{${values.map(([r, g, b]) => `{${r}, ${g}, ${b}}`).join(", ")}}`;
}

// --- style system ----------------------------------------------------------

export interface FontFamily {
  regular: string;
  bold: string;
  italic: string;
  boldItalic: string;
  mono: string;
}

/** PostScript names: Pages accepts these directly in `font`. */
export const FONT_FAMILIES: Record<string, FontFamily> = {
  "helvetica-neue": {
    regular: "HelveticaNeue",
    bold: "HelveticaNeue-Bold",
    italic: "HelveticaNeue-Italic",
    boldItalic: "HelveticaNeue-BoldItalic",
    mono: "Menlo-Regular",
  },
  georgia: {
    regular: "Georgia",
    bold: "Georgia-Bold",
    italic: "Georgia-Italic",
    boldItalic: "Georgia-BoldItalic",
    mono: "Menlo-Regular",
  },
  "avenir-next": {
    regular: "AvenirNext-Regular",
    bold: "AvenirNext-Bold",
    italic: "AvenirNext-Italic",
    boldItalic: "AvenirNext-BoldItalic",
    mono: "Menlo-Regular",
  },
  palatino: {
    regular: "Palatino-Roman",
    bold: "Palatino-Bold",
    italic: "Palatino-Italic",
    boldItalic: "Palatino-BoldItalic",
    mono: "Menlo-Regular",
  },
  times: {
    regular: "TimesNewRomanPSMT",
    bold: "TimesNewRomanPS-BoldMT",
    italic: "TimesNewRomanPS-ItalicMT",
    boldItalic: "TimesNewRomanPS-BoldItalicMT",
    mono: "Menlo-Regular",
  },
};

export interface StyleSpec {
  preset?: string;
  family?: string;
  baseSize?: number;
  accent?: string;
  muted?: string;
  headerFill?: string;
  headerText?: string;
  zebra?: string;
}

export interface ResolvedStyle {
  preset: string;
  family: string;
  fonts: FontFamily;
  baseSize: number;
  colors: {
    text: [number, number, number];
    muted: [number, number, number];
    accent: [number, number, number];
    headerFill: [number, number, number];
    headerText: [number, number, number];
    zebra: [number, number, number];
  };
}

type Preset = Required<Pick<StyleSpec, "family" | "baseSize" | "accent" | "muted" | "headerFill" | "headerText" | "zebra">>;

const PRESETS: Record<string, Preset> = {
  classic: {
    family: "helvetica-neue",
    baseSize: 12,
    accent: "#1F3864",
    muted: "#6B6B6B",
    headerFill: "#E8EDF4",
    headerText: "#1F3864",
    zebra: "#F6F8FA",
  },
  serif: {
    family: "georgia",
    baseSize: 12.5,
    accent: "#3A2E2A",
    muted: "#6E6660",
    headerFill: "#F0EBE6",
    headerText: "#3A2E2A",
    zebra: "#FAF7F4",
  },
  modern: {
    family: "avenir-next",
    baseSize: 11.5,
    accent: "#0E7490",
    muted: "#64748B",
    headerFill: "#E6F4F7",
    headerText: "#0E7490",
    zebra: "#F5FAFB",
  },
  compact: {
    family: "helvetica-neue",
    baseSize: 10.5,
    accent: "#111827",
    muted: "#6B7280",
    headerFill: "#EDEFF2",
    headerText: "#111827",
    zebra: "#F7F8FA",
  },
};

/** "#1F3864" -> AppleScript's 0..65535 RGB triple. */
function hexToApple(hex: string): [number, number, number] {
  const cleaned = hex.replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    throw new Error(`invalid colour ${JSON.stringify(hex)} - expected #RRGGBB`);
  }
  const r = parseInt(cleaned.slice(0, 2), 16);
  const g = parseInt(cleaned.slice(2, 4), 16);
  const b = parseInt(cleaned.slice(4, 6), 16);
  // 0..255 -> 0..65535 (x257) keeps the ratio exact.
  return [r * 257, g * 257, b * 257];
}

export function resolveStyle(spec?: string | StyleSpec): ResolvedStyle {
  const input: StyleSpec = typeof spec === "string" ? { preset: spec } : spec ?? {};
  const presetName = input.preset ?? "classic";
  const preset = PRESETS[presetName];
  if (!preset) {
    throw new Error(
      `unknown style preset ${JSON.stringify(presetName)}. Use one of: ${Object.keys(PRESETS).join(", ")}.`,
    );
  }

  const familyKey = input.family ?? preset.family;
  const fonts = FONT_FAMILIES[familyKey];
  if (!fonts) {
    throw new Error(
      `unknown font family ${JSON.stringify(familyKey)}. Use one of: ${Object.keys(FONT_FAMILIES).join(", ")}.`,
    );
  }

  const baseSize = input.baseSize ?? preset.baseSize;
  if (!Number.isFinite(baseSize) || baseSize < 6 || baseSize > 48) {
    throw new Error(`baseSize must be between 6 and 48 (got ${baseSize}).`);
  }

  return {
    preset: presetName,
    family: familyKey,
    fonts,
    baseSize,
    colors: {
      text: hexToApple("#1A1A1A"),
      muted: hexToApple(input.muted ?? preset.muted),
      accent: hexToApple(input.accent ?? preset.accent),
      headerFill: hexToApple(input.headerFill ?? preset.headerFill),
      headerText: hexToApple(input.headerText ?? preset.headerText),
      zebra: hexToApple(input.zebra ?? preset.zebra),
    },
  };
}

/** Reverse lookup: PostScript name -> family + weight/slant. */
export function describeFont(fontName: string): { family: string; bold: boolean; italic: boolean } | null {
  const needle = fontName.toLowerCase();
  for (const [key, fam] of Object.entries(FONT_FAMILIES)) {
    if (fam.regular.toLowerCase() === needle) return { family: key, bold: false, italic: false };
    if (fam.bold.toLowerCase() === needle) return { family: key, bold: true, italic: false };
    if (fam.italic.toLowerCase() === needle) return { family: key, bold: false, italic: true };
    if (fam.boldItalic.toLowerCase() === needle) return { family: key, bold: true, italic: true };
  }
  // Unknown face: fall back to name heuristics so bold/italic still round-trip.
  return {
    family: "",
    bold: /bold|black|heavy|semibold/i.test(fontName),
    italic: /italic|oblique/i.test(fontName),
  };
}

/** Pick the face matching the requested weight/slant, staying in the same family. */
export function variantOf(currentFont: string, bold: boolean, italic: boolean, fallback: FontFamily): string {
  const current = describeFont(currentFont);
  const family = current?.family ? FONT_FAMILIES[current.family] ?? fallback : fallback;
  if (bold && italic) return family.boldItalic;
  if (bold) return family.bold;
  if (italic) return family.italic;
  return family.regular;
}

// --- default style (persisted) ---------------------------------------------

/**
 * The connector's own default style, used by pages_create when no `style` is
 * given and by pages_styles get/set. Kept on disk so "the default look" is a
 * property of this machine, not of each call.
 */
const STYLE_CONFIG_PATH = path.join(appHome(), "pages-style.json");
const LEGACY_STYLE_CONFIG_PATH = path.join(os.homedir(), ".config", "local-agent-mcp", "pages-style.json");

export function loadDefaultStyle(): StyleSpec | undefined {
  for (const file of [STYLE_CONFIG_PATH, LEGACY_STYLE_CONFIG_PATH]) {
    try {
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw) as StyleSpec;
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Try the next location. The legacy path is read-only migration support.
    }
  }
  return undefined;
}

export function saveDefaultStyle(spec: StyleSpec): void {
  fs.mkdirSync(path.dirname(STYLE_CONFIG_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(STYLE_CONFIG_PATH, `${JSON.stringify(spec, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

/** Human-readable type scale for a resolved style. */
function styleTable(style: ResolvedStyle): string {
  const roles: Array<Exclude<PageBlockType, "table" | "spacer">> = [
    "title",
    "subtitle",
    "h1",
    "h2",
    "h3",
    "body",
    "bullet",
    "numbered",
    "quote",
    "caption",
    "code",
  ];
  return roles
    .map((role) => {
      const spec = blockStyle(role, style);
      return `  ${role.padEnd(9)} ${String(spec.size).padStart(5)}pt  ${spec.font}  ${appleToHex(spec.color)}`;
    })
    .join("\n");
}

// --- block model -----------------------------------------------------------

export type PageBlockType =
  | "title"
  | "subtitle"
  | "h1"
  | "h2"
  | "h3"
  | "body"
  | "bullet"
  | "numbered"
  | "quote"
  | "caption"
  | "code"
  | "spacer"
  | "table";

export type Align = "left" | "center" | "right";

export interface TableSpec {
  header?: string[];
  rows: string[][];
  headerColumn?: boolean;
  align?: Align[];
  columnWidths?: number[];
  zebra?: boolean;
}

export interface PageBlock {
  type: PageBlockType;
  text?: string;
  table?: TableSpec;
}

/** Multiplier against the style's base size. */
const TYPE_RATIO: Record<Exclude<PageBlockType, "table">, number> = {
  title: 2.5,
  subtitle: 1.25,
  h1: 1.83,
  h2: 1.42,
  h3: 1.17,
  body: 1,
  bullet: 1,
  numbered: 1,
  quote: 1,
  caption: 0.83,
  code: 0.92,
  spacer: 1,
};

interface BlockStyle {
  font: string;
  size: number;
  color: [number, number, number];
  prefix?: string;
}

function blockStyle(type: Exclude<PageBlockType, "table">, style: ResolvedStyle): BlockStyle {
  const size = Math.round(style.baseSize * TYPE_RATIO[type] * 2) / 2;
  const { fonts, colors } = style;
  switch (type) {
    case "title":
      return { font: fonts.bold, size, color: colors.accent };
    case "subtitle":
      return { font: fonts.regular, size, color: colors.muted };
    case "h1":
    case "h2":
    case "h3":
      return { font: fonts.bold, size, color: colors.text };
    case "quote":
      return { font: fonts.italic, size, color: colors.muted };
    case "caption":
      return { font: fonts.regular, size, color: colors.muted };
    case "code":
      return { font: fonts.mono, size, color: colors.text };
    case "bullet":
      return { font: fonts.regular, size, color: colors.text, prefix: "\u2022\u00A0" };
    default:
      return { font: fonts.regular, size, color: colors.text };
  }
}

export interface RenderedBlocks {
  texts: string[];
  sizes: number[];
  fonts: string[];
  colors: Array<[number, number, number]>;
  tables: TableSpec[];
}

/** Flatten blocks to one paragraph per block, plus any trailing tables. */
export function renderBlocks(blocks: PageBlock[], style: ResolvedStyle): RenderedBlocks {
  const texts: string[] = [];
  const sizes: number[] = [];
  const fonts: string[] = [];
  const colors: Array<[number, number, number]> = [];
  const tables: TableSpec[] = [];
  let numbered = 0;

  for (const block of blocks) {
    if (block.type === "table") {
      if (block.table) tables.push(block.table);
      continue;
    }
    const spec = blockStyle(block.type, style);
    let body = (block.text ?? "").replace(/\r\n/g, "\n").replace(/\s+$/, "");

    if (block.type === "numbered") {
      numbered += 1;
      body = `${numbered}. ${body}`;
    } else {
      numbered = 0;
    }
    if (spec.prefix) body = `${spec.prefix}${body}`;

    // A block may contain hard line breaks; each becomes its own paragraph so the
    // paragraph count stays aligned with the style arrays.
    for (const line of body.split("\n")) {
      texts.push(line);
      sizes.push(spec.size);
      fonts.push(spec.font);
      colors.push(spec.color);
    }
  }
  return { texts, sizes, fonts, colors, tables };
}

/**
 * Pages exposes no way to move an inline object, so a table can only be created
 * at the end of the text flow. Reject interleaved tables rather than silently
 * reordering the user's content.
 */
export function validateBlocks(blocks: PageBlock[]): string | null {
  let sawTable = false;
  for (const block of blocks) {
    if (block.type === "table") {
      sawTable = true;
      continue;
    }
    if (sawTable) {
      return (
        "ERROR: a table block must come last. Pages cannot insert an inline table mid-flow, " +
        "so text after a table would be reordered. Put every table at the end of `blocks` " +
        "(or use pages_edit with op=append to add one)."
      );
    }
  }
  for (const block of blocks) {
    if (block.type !== "table") continue;
    if (!block.table) return "ERROR: a table block needs a `table` object with rows.";
    const t = block.table;
    const widths = [t.header?.length ?? 0, ...t.rows.map((r) => r.length)].filter((n) => n > 0);
    if (!widths.length) return "ERROR: table needs a header or at least one row.";
    const cols = widths[0];
    if (widths.some((w) => w !== cols)) {
      return `ERROR: every table row must have the same number of cells (found ${widths.join(", ")}).`;
    }
    if (t.align && t.align.length > cols) {
      return `ERROR: table has ${cols} columns but ${t.align.length} alignment entries.`;
    }
    if (t.columnWidths && t.columnWidths.length > cols) {
      return `ERROR: table has ${cols} columns but ${t.columnWidths.length} column widths.`;
    }
  }
  return null;
}

// --- table script generation ----------------------------------------------

/** AppleScript list-of-lists literal for the cell grid, row-major. */
function gridLiteral(grid: string[][]): string {
  return `{${grid.map((row) => `{${row.map((cell) => asLit(cell ?? "")).join(", ")}}`).join(", ")}}`;
}

function buildTable(spec: TableSpec, index: number, style: ResolvedStyle, docVar = "doc"): string {
  const header = spec.header ?? [];
  const rows = spec.rows;
  const cols = Math.max(header.length, ...rows.map((r) => r.length));
  const headerRows = header.length ? 1 : 0;
  const headerCols = spec.headerColumn ? 1 : 0;
  const totalRows = headerRows + rows.length;

  // Pad short rows so the grid is rectangular.
  const grid: string[][] = [];
  if (headerRows) grid.push([...header, ...Array(cols - header.length).fill("")]);
  for (const row of rows) grid.push([...row, ...Array(cols - row.length).fill("")]);

  const tableVar = `tbl${index}`;
  const props =
    `{row count:${totalRows}, column count:${cols}, header row count:${headerRows}, header column count:${headerCols}}`;

  const lines: string[] = [];
  lines.push(`  -- table ${index}: ${totalRows}x${cols}`);
  // Pages accepts a table either at the end of the text flow or on the section;
  // try the inline form first and fall back rather than failing the whole call.
  lines.push(`  try`);
  lines.push(`    set ${tableVar} to make new table at end of body text of ${docVar} with properties ${props}`);
  lines.push(`  on error`);
  lines.push(`    set ${tableVar} to make new table at end of section 1 of ${docVar} with properties ${props}`);
  lines.push(`  end try`);

  // Fill by walking the cells and reading their own row/column addresses, which
  // avoids relying on coordinate-name syntax that Pages does not document.
  lines.push(`  set theGrid to ${gridLiteral(grid)}`);
  lines.push(`  repeat with c in cells of ${tableVar}`);
  lines.push(`    try`);
  lines.push(`      set rA to (address of row of c)`);
  lines.push(`      set cA to (address of column of c)`);
  lines.push(`      set value of c to (item cA of item rA of theGrid)`);
  lines.push(`    end try`);
  lines.push(`  end repeat`);

  // Base cell typography.
  lines.push(`  set font name of cell range of ${tableVar} to ${asLit(style.fonts.regular)}`);
  lines.push(`  set font size of cell range of ${tableVar} to ${Math.round(style.baseSize * 0.92 * 2) / 2}`);
  lines.push(`  set text color of cell range of ${tableVar} to {${style.colors.text.join(", ")}}`);

  if (headerRows) {
    lines.push(`  set hr to row 1 of ${tableVar}`);
    lines.push(`  set background color of hr to {${style.colors.headerFill.join(", ")}}`);
    lines.push(`  set font name of hr to ${asLit(style.fonts.bold)}`);
    lines.push(`  set text color of hr to {${style.colors.headerText.join(", ")}}`);
  }
  if (headerCols) {
    lines.push(`  set hc to column 1 of ${tableVar}`);
    lines.push(`  set font name of hc to ${asLit(style.fonts.bold)}`);
    lines.push(`  set background color of hc to {${style.colors.headerFill.join(", ")}}`);
  }

  if (spec.zebra) {
    lines.push(`  repeat with r from ${headerRows + 1} to (row count of ${tableVar})`);
    lines.push(
      `    if (r mod 2) is 0 then set background color of (row r of ${tableVar}) to {${style.colors.zebra.join(", ")}}`,
    );
    lines.push(`  end repeat`);
  }

  (spec.align ?? []).forEach((align, i) => {
    if (!align) return;
    lines.push(`  set alignment of column ${i + 1} of ${tableVar} to ${align}`);
  });
  (spec.columnWidths ?? []).forEach((width, i) => {
    if (!width) return;
    lines.push(`  set width of column ${i + 1} of ${tableVar} to ${Math.round(width)}`);
  });

  return lines.join("\n");
}

// --- document model --------------------------------------------------------

interface DocParagraph {
  text: string;
  size: number;
  font: string;
  color: [number, number, number];
}

interface TableModel {
  index: number;
  rows: number;
  cols: number;
  headerRows: number;
  grid: string[][];
}

interface DocModel {
  name: string;
  filePath: string;
  total: number;
  paragraphs: DocParagraph[];
  tables: TableModel[];
}

/**
 * AppleScript that binds `doc` to the document at `targetPath`, reusing an
 * already-open window when possible so we do not spawn duplicates.
 */
function bindDocument(targetPath: string | null, varName = "doc"): string {
  if (!targetPath) return `set ${varName} to document 1`;
  const lit = asLit(targetPath);
  return [
    `set targetPath to ${lit}`,
    `set ${varName} to missing value`,
    `repeat with d in documents`,
    `  try`,
    `    if (POSIX path of (file of d)) is targetPath then`,
    `      set ${varName} to contents of d`,
    `      exit repeat`,
    `    end if`,
    `  end try`,
    `end repeat`,
    `if ${varName} is missing value then`,
    // Opening a closed document is the only thing that raises Pages. Remember
    // who had focus and hand it straight back, so a background edit never
    // steals the window the user is working in.
    `  set prevApp to ""`,
    `  try`,
    `    tell application "System Events" to set prevApp to name of first application process whose frontmost is true`,
    `  end try`,
    `  set ${varName} to open POSIX file targetPath`,
    `  if prevApp is not "" then`,
    `    try`,
    `      tell application "System Events" to set frontmost of (first application process whose name is prevApp) to true`,
    `    end try`,
    `  end if`,
    `end if`,
  ].join("\n  ");
}

const READ_BODY = `
  set docName to name of doc
  set docPath to ""
  try
    set docPath to POSIX path of (file of doc)
  end try
  set allParas to paragraphs of body text of doc
  set totalParas to count of allParas
  set scanCount to totalParas
  if scanCount > MAXP then set scanCount to MAXP

  set outList to {}
  set end of outList to "H" & (ASCII character 30) & docName & (ASCII character 30) & docPath & (ASCII character 30) & (totalParas as text)

  -- Bulk read: four Apple Events for the whole document instead of four per
  -- paragraph. Each property is read in its own try, because Pages refuses
  -- property access on blank spacer paragraphs (font of "" raises -1728) and
  -- one bad property must not discard the other three.
  set theTexts to missing value
  set theFonts to missing value
  set theSizes to missing value
  set theColors to missing value
  try
    set theTexts to contents of every paragraph of body text of doc
    if (count of theTexts) < scanCount then set theTexts to missing value
  end try
  try
    set theFonts to font of every paragraph of body text of doc
    if (count of theFonts) < scanCount then set theFonts to missing value
  end try
  try
    set theSizes to size of every paragraph of body text of doc
    if (count of theSizes) < scanCount then set theSizes to missing value
  end try
  try
    set theColors to color of every paragraph of body text of doc
    if (count of theColors) < scanCount then set theColors to missing value
  end try

  repeat with i from 1 to scanCount
    set tx to ""
    set fz to ""
    set sz to 0
    set rC to 0
    set gC to 0
    set bC to 0

    if theTexts is missing value then
      try
        set tx to (item i of allParas) as text
      end try
    else
      try
        set tx to (item i of theTexts) as text
      end try
    end if

    if theFonts is missing value then
      try
        set fz to (font of (item i of allParas)) as text
      end try
    else
      try
        set fv to item i of theFonts
        if fv is not missing value then set fz to fv as text
      end try
    end if

    if theSizes is missing value then
      try
        set sz to (size of (item i of allParas)) as number
      end try
    else
      try
        set sv to item i of theSizes
        if sv is not missing value then set sz to sv as number
      end try
    end if

    if theColors is missing value then
      try
        set cl to color of (item i of allParas)
        set rC to item 1 of cl
        set gC to item 2 of cl
        set bC to item 3 of cl
      end try
    else
      try
        set cv to item i of theColors
        if cv is not missing value then
          set rC to item 1 of cv
          set gC to item 2 of cv
          set bC to item 3 of cv
        end if
      end try
    end if

    set end of outList to "P" & (ASCII character 30) & (i as text) & (ASCII character 30) & (sz as text) & (ASCII character 30) & fz & (ASCII character 30) & (rC as text) & (ASCII character 30) & (gC as text) & (ASCII character 30) & (bC as text) & (ASCII character 30) & tx
  end repeat

  try
    set tIdx to 0
    repeat with t in tables of doc
      set tIdx to tIdx + 1
      set end of outList to "T" & (ASCII character 30) & (tIdx as text) & (ASCII character 30) & (row count of t as text) & (ASCII character 30) & (column count of t as text) & (ASCII character 30) & (header row count of t as text)
      repeat with c in cells of t
        set rA to 0
        set cA to 0
        try
          set rA to (address of row of c)
          set cA to (address of column of c)
        end try
        set v to ""
        try
          set vv to value of c
          if vv is not missing value then set v to (vv as text)
        end try
        set end of outList to "C" & (ASCII character 30) & (tIdx as text) & (ASCII character 30) & (rA as text) & (ASCII character 30) & (cA as text) & (ASCII character 30) & v
      end repeat
    end repeat
  end try

  -- Join once at the end. Concatenating inside the loops is quadratic and was
  -- the real cost on long documents.
  set oldDelims to AppleScript's text item delimiters
  set AppleScript's text item delimiters to (ASCII character 31)
  set out to outList as text
  set AppleScript's text item delimiters to oldDelims
  return out`;

function parseDocModel(raw: string): DocModel {
  const records = raw.split(RS);
  const model: DocModel = { name: "", filePath: "", total: 0, paragraphs: [], tables: [] };
  const tablesByIndex = new Map<number, TableModel>();

  for (const record of records) {
    if (!record) continue;
    const fields = record.split(US);
    const kind = fields[0];
    if (kind === "H") {
      model.name = fields[1] ?? "";
      model.filePath = fields[2] ?? "";
      model.total = Number(fields[3] ?? "0") || 0;
    } else if (kind === "P") {
      // A blank spacer paragraph reports no font and no size. Keep the hole
      // rather than inventing 12pt/HelveticaNeue - callers must not write an
      // unknown style back onto the document.
      model.paragraphs.push({
        text: fields.slice(7).join(US),
        size: Number(fields[2]) || 0,
        font: fields[3] ?? "",
        color: [Number(fields[4]) || 0, Number(fields[5]) || 0, Number(fields[6]) || 0],
      });
    } else if (kind === "T") {
      const index = Number(fields[1]) || 0;
      const table: TableModel = {
        index,
        rows: Number(fields[2]) || 0,
        cols: Number(fields[3]) || 0,
        headerRows: Number(fields[4]) || 0,
        grid: [],
      };
      tablesByIndex.set(index, table);
      model.tables.push(table);
    } else if (kind === "C") {
      const table = tablesByIndex.get(Number(fields[1]));
      if (!table) continue;
      const r = Number(fields[2]) - 1;
      const c = Number(fields[3]) - 1;
      if (r < 0 || c < 0) continue;
      while (table.grid.length <= r) table.grid.push([]);
      const row = table.grid[r];
      while (row.length <= c) row.push("");
      row[c] = fields.slice(4).join(US);
    }
  }
  return model;
}

async function readDocument(targetPath: string | null, maxParagraphs: number): Promise<DocModel | Result> {
  // Dry-run stand-in so edit scripts can be generated (and syntax-checked) with
  // no Apple Events at all.
  if (process.env.APPLESCRIPT_DRY_RUN === "1" || process.env.PAGES_DRY_RUN === "1") {
    return {
      name: "dry-run",
      filePath: targetPath ?? "",
      total: 3,
      paragraphs: [
        { text: "First paragraph", size: 12, font: "HelveticaNeue", color: [0, 0, 0] },
        { text: "Second paragraph with needle", size: 12, font: "HelveticaNeue-Bold", color: [0, 0, 0] },
        { text: "Third paragraph", size: 11, font: "Georgia-Italic", color: [2570, 2570, 2570] },
      ],
      tables: [
        {
          index: 1,
          rows: 2,
          cols: 2,
          headerRows: 1,
          grid: [
            ["Header A", "Header B"],
            ["needle here", "42"],
          ],
        },
      ],
    };
  }

  // Scale the ceiling with the document: a 20-page read is a single bulk
  // round trip now, but give it headroom rather than cutting it off.
  const timeoutSec = Math.min(600, 120 + Math.ceil(Math.max(1, maxParagraphs) / 50) * 5);

  const script = [
    `with timeout of ${timeoutSec} seconds`,
    `  tell application id "${PAGES_BUNDLE_ID}"`,
    `  ${bindDocument(targetPath)}`,
    `  set MAXP to ${Math.max(1, maxParagraphs)}`,
    READ_BODY,
    `  end tell`,
    `end timeout`,
  ].join("\n");

  const res = await runAppleScript(script, (timeoutSec + 10) * 1000);
  if (!res.ok) return bad(explainFailure(res));
  return parseDocModel(res.out);
}

function isResult(value: DocModel | Result): value is Result {
  return (value as Result).ok !== undefined && typeof (value as Result).message === "string";
}

/** Scripts are generated but never executed, so nothing can be asserted about the result. */
function isDryRun(): boolean {
  return process.env.APPLESCRIPT_DRY_RUN === "1" || process.env.PAGES_DRY_RUN === "1";
}

// --- pages_status ----------------------------------------------------------

export interface StatusOptions {
  includeTemplates?: boolean;
}

export async function pagesStatus(opts: StatusOptions = {}): Promise<Result> {
  const missing = requireApp();
  if (missing) return missing;
  const appPath = findPagesApp()!;
  const running = await isPagesRunning();

  const ancestry = processAncestry();
  const lines = [
    `Pages: ${appPath}`,
    `version: ${appVersion(appPath)}`,
    `bundle id: ${PAGES_BUNDLE_ID}`,
    `running: ${running ? "yes" : "no"}`,
    ...(ancestry.length ? [`host process chain: ${ancestry.join(" <- ")}`] : []),
    `style presets: ${Object.keys(PRESETS).join(", ")}`,
    `font families: ${Object.keys(FONT_FAMILIES).join(", ")}`,
  ];

  const probe = await runAppleScript(
    [`with timeout of 20 seconds`, `  tell application id "${PAGES_BUNDLE_ID}"`, `    set n to count of documents`, `    return (n as text)`, `  end tell`, `end timeout`].join("\n"),
    30_000,
  );

  if (!probe.ok) {
    if (probe.code === -1743 || probe.code === -10004) {
      lines.push(`automation permission: NOT GRANTED`, "", explainFailure(probe));
      lines.push(
        "",
        "Pages tools cannot run until this is granted. It is a one-time, per-host-app click;",
        "nothing is installed or changed on disk by granting it.",
      );
    } else {
      // A Pages-originated scripting error proves the Apple Event crossed the
      // privacy boundary. Creator Studio 15.4 can currently advertise document
      // commands in its sdef while rejecting the documents collection at runtime.
      lines.push(
        `automation permission: granted (Pages answered the Apple Event)`,
        `document scripting probe: unavailable`,
        "",
        explainFailure(probe),
        "",
        "The installed Pages build is reachable, but its document scripting API is not responding to the standard documents collection. UI-backed control remains available.",
      );
    }
    return ok(lines.join("\n"));
  }

  lines.push(`automation permission: granted`, `open documents: ${probe.out.trim()}`);

  const docs = await runAppleScript(
    [
      `with timeout of 20 seconds`,
      `  tell application id "${PAGES_BUNDLE_ID}"`,
      `    set out to ""`,
      `    repeat with d in documents`,
      `      set fp to ""`,
      `      try`,
      `        set fp to POSIX path of (file of d)`,
      `      end try`,
      `      set out to out & (name of d) & (ASCII character 30) & fp & (ASCII character 31)`,
      `    end repeat`,
      `    return out`,
      `  end tell`,
      `end timeout`,
    ].join("\n"),
    30_000,
  );

  if (docs.ok && docs.out.trim()) {
    lines.push("", "open document list:");
    for (const record of docs.out.split(RS)) {
      if (!record) continue;
      const [name, file] = record.split(US);
      lines.push(`  - ${name}${file ? `  (${file})` : "  (unsaved)"}`);
    }
  }

  if (opts.includeTemplates) {
    const tpl = await runAppleScript(
      [
        `with timeout of 30 seconds`,
        `  tell application id "${PAGES_BUNDLE_ID}"`,
        `    set names to {}`,
        `    repeat with t in templates`,
        `      set end of names to (name of t)`,
        `    end repeat`,
        `    set out to ""`,
        `    repeat with n in names`,
        `      set out to out & n & (ASCII character 31)`,
        `    end repeat`,
        `    return out`,
        `  end tell`,
        `end timeout`,
      ].join("\n"),
      45_000,
    );
    if (tpl.ok) {
      const names = tpl.out.split(RS).filter(Boolean).sort();
      lines.push("", `templates (${names.length}): ${names.join(", ")}`);
    } else {
      lines.push("", `templates: unavailable (${tpl.error})`);
    }
  }

  return ok(lines.join("\n"));
}

// --- pages_create ----------------------------------------------------------

export interface CreateOptions {
  path: string;
  blocks: PageBlock[];
  template?: string;
  format?: "styled" | "plain";
  style?: string | StyleSpec;
  overwrite?: boolean;
}

export async function pagesCreate(opts: CreateOptions): Promise<Result> {
  const missing = requireApp();
  if (missing) return missing;

  const dest = path.resolve(opts.path.replace(/^~(?=\/|$)/, os.homedir()));
  if (!dest.toLowerCase().endsWith(".pages")) {
    return bad(`ERROR: destination must end in .pages (got ${dest})`);
  }
  if (fs.existsSync(dest) && !opts.overwrite) {
    return bad(`ERROR: ${dest} already exists. Pass overwrite=true to replace it.`);
  }
  if (!opts.blocks?.length) return bad("ERROR: no blocks supplied - nothing to write.");

  const blockError = validateBlocks(opts.blocks);
  if (blockError) return bad(blockError);

  let style: ResolvedStyle;
  try {
    style = resolveStyle(opts.style ?? loadDefaultStyle());
  } catch (err) {
    return bad(`ERROR: ${(err as Error).message}`);
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const rendered = renderBlocks(opts.blocks, style);
  // A template already carries its own typography, so default to leaving it alone.
  const format = opts.format ?? (opts.template ? "plain" : "styled");
  const styled = format === "styled";

  const makeDoc = opts.template
    ? `set doc to make new document with properties {document template:template ${asLit(opts.template)}}`
    : `set doc to make new document`;

  const styleBlock = styled
    ? [
        `  set n to count of paragraphs of body text of doc`,
        `  repeat with i from 1 to (count of theSizes)`,
        `    if i \u2264 n then`,
        `      try`,
        `        set p to paragraph i of body text of doc`,
        `        set size of p to (item i of theSizes)`,
        `        set font of p to (item i of theFonts)`,
        `        set color of p to (item i of theColors)`,
        `      end try`,
        `    end if`,
        `  end repeat`,
      ].join("\n")
    : `  -- plain: leave the template's own paragraph styles in charge`;

  const tables = rendered.tables.map((t, i) => buildTable(t, i + 1, style)).join("\n");

  const script = [
    `with timeout of 180 seconds`,
    `  tell application id "${PAGES_BUNDLE_ID}"`,
    `  ${makeDoc}`,
    `  set theText to ${asLit(rendered.texts.join("\n"))}`,
    `  set theSizes to ${numList(rendered.sizes)}`,
    `  set theFonts to ${strList(rendered.fonts)}`,
    `  set theColors to ${colorList(rendered.colors)}`,
    `  tell doc`,
    `    set body text to theText`,
    `  end tell`,
    styleBlock,
    tables,
    `  save doc in POSIX file ${asLit(dest)}`,
    `  return (name of doc)`,
    `  end tell`,
    `end timeout`,
  ]
    .filter(Boolean)
    .join("\n");

  const res = await runAppleScript(script, 200_000);
  if (!res.ok) return bad(explainFailure(res));

  const words = rendered.texts.join(" ").split(/\s+/).filter(Boolean).length;
  const tableCells = rendered.tables.reduce(
    (n, t) => n + (t.header?.length ?? 0) + t.rows.reduce((m, r) => m + r.length, 0),
    0,
  );
  return ok(
    `Created ${dest}\n` +
      `paragraphs: ${rendered.texts.length}   words: ${words}   formatting: ${format}` +
      (opts.template ? `   template: ${opts.template}` : "") +
      (rendered.tables.length ? `\ntables: ${rendered.tables.length} (${tableCells} cells)` : "") +
      `\nstyle: ${style.preset} / ${style.family} @ ${style.baseSize}pt` +
      "\nsaved; left open in Pages (this connector never closes documents)",
  );
}

// --- pages_read ------------------------------------------------------------

export interface ReadOptions {
  path?: string;
  maxParagraphs?: number;
}

export async function pagesRead(opts: ReadOptions = {}): Promise<Result> {
  const missing = requireApp();
  if (missing) return missing;
  const target = opts.path ? path.resolve(opts.path.replace(/^~(?=\/|$)/, os.homedir())) : null;
  if (target && !fs.existsSync(target)) return bad(`ERROR: no such file: ${target}`);

  const model = await readDocument(target, opts.maxParagraphs ?? 400);
  if (isResult(model)) return model;

  const lines = [
    `${model.name}`,
    model.filePath ? `path: ${model.filePath}` : "path: (unsaved document)",
    `paragraphs: ${model.total}${model.paragraphs.length < model.total ? ` (showing first ${model.paragraphs.length})` : ""}` +
      (model.tables.length ? `   tables: ${model.tables.length}` : ""),
    "",
    "text:",
    model.paragraphs.map((p) => p.text).join("\n"),
    "",
    "outline (index | size | font | first 70 chars):",
  ];
  for (let i = 0; i < model.paragraphs.length; i++) {
    const p = model.paragraphs[i];
    const preview = p.text.trim().slice(0, 70);
    if (!preview) continue;
    lines.push(`  ${String(i + 1).padStart(3)} | ${(p.size ? String(p.size) : "?").padStart(2)} | ${p.font || "?"} | ${preview}`);
  }

  for (const table of model.tables) {
    lines.push("", `table ${table.index}: ${table.rows} rows x ${table.cols} cols, header rows: ${table.headerRows}`);
    const cells = table.grid.flat().map((c) => c ?? "");
    const width = Math.max(...cells.map((c) => c.length), 1);
    for (const row of table.grid) {
      lines.push(`  | ${row.map((c) => (c ?? "").padEnd(width)).join(" | ")} |`);
    }
  }

  return ok(lines.join("\n"));
}

// --- pages_inspect ---------------------------------------------------------

/** 0..65535 RGB triple back to #RRGGBB. */
function appleToHex(color: [number, number, number]): string {
  const part = (v: number) => Math.round(Math.min(65535, Math.max(0, v)) / 257).toString(16).padStart(2, "0");
  return `#${part(color[0])}${part(color[1])}${part(color[2])}`.toUpperCase();
}

interface CellFormat {
  table: number;
  row: number;
  col: number;
  font: string;
  size: number;
  fill: [number, number, number] | null;
}

const MAX_INSPECT_CELLS = 400;

async function readTableFormats(targetPath: string | null): Promise<CellFormat[]> {
  const script = [
    `with timeout of 120 seconds`,
    `  tell application id "${PAGES_BUNDLE_ID}"`,
    `  ${bindDocument(targetPath)}`,
    `  set out to ""`,
    `  set tIdx to 0`,
    `  set seen to 0`,
    `  repeat with t in tables of doc`,
    `    set tIdx to tIdx + 1`,
    `    repeat with c in cells of t`,
    `      if seen \u2265 ${MAX_INSPECT_CELLS} then exit repeat`,
    `      set rA to 0`,
    `      set cA to 0`,
    `      set fn to ""`,
    `      set fs to 0`,
    `      set fr to 0`,
    `      set fg to 0`,
    `      set fb to 0`,
    `      try`,
    `        set rA to (address of row of c)`,
    `        set cA to (address of column of c)`,
    `        set fn to (font name of c)`,
    `        set fs to (font size of c)`,
    `        set bg to (background color of c)`,
    `        set fr to (item 1 of bg)`,
    `        set fg to (item 2 of bg)`,
    `        set fb to (item 3 of bg)`,
    `      end try`,
    `      set seen to seen + 1`,
    `      set out to out & "C" & (ASCII character 30) & (tIdx as text) & (ASCII character 30) & (rA as text) & (ASCII character 30) & (cA as text) & (ASCII character 30) & fn & (ASCII character 30) & (fs as text) & (ASCII character 30) & (fr as text) & (ASCII character 30) & (fg as text) & (ASCII character 30) & (fb as text) & (ASCII character 31)`,
    `    end repeat`,
    `  end repeat`,
    `  return out`,
    `  end tell`,
    `end timeout`,
  ].join("\n");

  const res = await runAppleScript(script, 130_000);
  if (!res.ok) return [];
  const formats: CellFormat[] = [];
  for (const record of res.out.split(RS)) {
    if (!record) continue;
    const f = record.split(US);
    if (f[0] !== "C") continue;
    formats.push({
      table: Number(f[1]) || 0,
      row: Number(f[2]) || 0,
      col: Number(f[3]) || 0,
      font: f[4] || "",
      size: Number(f[5]) || 0,
      fill: [Number(f[6]) || 0, Number(f[7]) || 0, Number(f[8]) || 0],
    });
  }
  return formats;
}

export async function pagesInspect(opts: ReadOptions = {}): Promise<Result> {
  const missing = requireApp();
  if (missing) return missing;
  const target = opts.path ? path.resolve(opts.path.replace(/^~(?=\/|$)/, os.homedir())) : null;
  if (target && !fs.existsSync(target)) return bad(`ERROR: no such file: ${target}`);

  const model = await readDocument(target, opts.maxParagraphs ?? 200);
  if (isResult(model)) return model;

  const formats = model.tables.length ? await readTableFormats(target) : [];
  const fillCounts = new Map<string, number>();
  for (const f of formats) {
    if (!f.fill) continue;
    const hex = appleToHex(f.fill);
    fillCounts.set(hex, (fillCounts.get(hex) ?? 0) + 1);
  }

  const lines = [
    `format report: ${model.name}`,
    model.filePath ? `path: ${model.filePath}` : "path: (unsaved document)",
    `paragraphs: ${model.total}${model.paragraphs.length < model.total ? ` (showing ${model.paragraphs.length})` : ""}` +
      (model.tables.length ? `   tables: ${model.tables.length}` : ""),
    "",
    "paragraph formats (index | pt | face | flags | colour | text):",
  ];

  for (let i = 0; i < model.paragraphs.length; i++) {
    const p = model.paragraphs[i];
    const info = describeFont(p.font);
    const flags = [info?.bold ? "bold" : "", info?.italic ? "italic" : ""].filter(Boolean).join("+") || "-";
    const preview = p.text.trim().slice(0, 48);
    if (!preview) continue;
    lines.push(
      `  ${String(i + 1).padStart(3)} | ${(p.size ? String(p.size) : "?").padStart(4)} | ${(p.font || "?").padEnd(22)} | ${flags.padEnd(11)} | ${appleToHex(p.color)} | ${preview}`,
    );
  }

  // Style inventory: the distinct (face, size, colour) combinations actually in
  // use, so "what styles does this document have" is one line each.
  const inventory = new Map<string, number>();
  for (const p of model.paragraphs) {
    if (!p.text.trim()) continue;
    const key = `${p.font} ${p.size}pt ${appleToHex(p.color)}`;
    inventory.set(key, (inventory.get(key) ?? 0) + 1);
  }
  if (inventory.size) {
    lines.push("", "style inventory (face / size / colour -> paragraphs):");
    for (const [key, count] of [...inventory.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${key}  x${count}`);
    }
  }

  if (model.tables.length) {
    const byTable = new Map<number, CellFormat[]>();
    for (const f of formats) {
      const list = byTable.get(f.table) ?? [];
      list.push(f);
      byTable.set(f.table, list);
    }

    for (const table of model.tables) {
      const cells = byTable.get(table.index) ?? [];
      const headerFills = cells
        .filter((c) => c.row <= table.headerRows)
        .map((c) => appleToHex(c.fill ?? [0, 0, 0]));
      const dominantFill = headerFills.length
        ? headerFills.sort((a, b) => headerFills.filter((x) => x === b).length - headerFills.filter((x) => x === a).length)[0]
        : null;
      const faces = [...new Set(cells.map((c) => `${c.font} ${c.size}`))].slice(0, 4);

      lines.push(
        "",
        `table ${table.index}: ${table.rows} rows x ${table.cols} cols` +
          `, header rows: ${table.headerRows}` +
          (dominantFill ? `, header fill: ${dominantFill}` : "") +
          (faces.length ? `\n  faces: ${faces.join(" / ")}` : "") +
          (formats.length >= MAX_INSPECT_CELLS ? `\n  (cell formatting capped at ${MAX_INSPECT_CELLS} cells)` : ""),
      );
      const width = Math.max(...table.grid.flat().map((c) => (c ?? "").length), 1);
      table.grid.forEach((row, r) => {
        const cells2 = row.map((c) => (c ?? "").padEnd(width));
        const isHeader = r < table.headerRows ? "H" : " ";
        lines.push(`  ${isHeader}| ${cells2.join(" | ")} |`);
      });
    }

    if (fillCounts.size) {
      const summary = [...fillCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([hex, n]) => `${hex} x${n}`)
        .join(", ");
      lines.push("", `cell fills in use: ${summary}`);
    }
  }

  return ok(lines.join("\n"));
}

// --- pages_styles ----------------------------------------------------------

export type Role = Exclude<PageBlockType, "table" | "spacer">;

/** Guess a paragraph's role from its size relative to the document's body size. */
export function inferRole(p: DocParagraph, bodySize: number): Role {
  // size 0 means the paragraph reports no typography at all (a blank spacer).
  if (!p.size) return "body";
  const face = p.font.toLowerCase();
  const info = describeFont(p.font);
  if (face.includes("menlo") || face.includes("mono") || face.includes("courier")) return "code";
  if (info?.italic && p.size <= bodySize * 1.06) return "quote";
  if (p.size >= bodySize * 2) return "title";
  if (p.size >= bodySize * 1.6) return "h1";
  if (p.size >= bodySize * 1.28) return "h2";
  if (p.size >= bodySize * 1.1) return "h3";
  if (p.size <= bodySize * 0.9) return "caption";
  return "body";
}

function bodySizeOf(paras: DocParagraph[]): number {
  const counts = new Map<number, number>();
  for (const p of paras) {
    if (!p.text.trim() || !p.size) continue;
    counts.set(p.size, (counts.get(p.size) ?? 0) + 1);
  }
  let best = 12;
  let bestCount = 0;
  for (const [size, n] of counts) {
    if (n > bestCount) {
      best = size;
      bestCount = n;
    }
  }
  return best;
}

export interface StylesOptions {
  action: "list" | "get" | "set" | "apply";
  path?: string;
  style?: string | StyleSpec;
}

export async function pagesStyles(opts: StylesOptions): Promise<Result> {
  const missing = requireApp();
  if (missing) return missing;

  if (opts.action === "list") {
    return ok(
      `style presets: ${Object.keys(PRESETS).join(", ")}\n` +
        `font families: ${Object.keys(FONT_FAMILIES).join(", ")}\n` +
        `default: ${JSON.stringify(loadDefaultStyle() ?? { preset: "classic" })}\n` +
        `config: ${STYLE_CONFIG_PATH}`,
    );
  }

  if (opts.action === "get") {
    let resolved: ResolvedStyle;
    try {
      resolved = resolveStyle(loadDefaultStyle());
    } catch (err) {
      return bad(`ERROR: stored default style is invalid: ${(err as Error).message}`);
    }
    return ok(
      `default style: ${JSON.stringify(loadDefaultStyle() ?? { preset: "classic" })}\n` +
        `config: ${STYLE_CONFIG_PATH}\n\n` +
        `resolved type scale (${resolved.preset} / ${resolved.family} @ ${resolved.baseSize}pt):\n` +
        styleTable(resolved),
    );
  }

  if (opts.action === "set") {
    if (!opts.style) return bad("ERROR: action=set needs a style (preset name or override object).");
    let resolved: ResolvedStyle;
    try {
      resolved = resolveStyle(opts.style);
    } catch (err) {
      return bad(`ERROR: ${(err as Error).message}`);
    }
    const spec: StyleSpec = typeof opts.style === "string" ? { preset: opts.style } : opts.style;
    try {
      saveDefaultStyle(spec);
    } catch (err) {
      return bad(`ERROR: could not write ${STYLE_CONFIG_PATH}: ${(err as Error).message}`);
    }
    return ok(
      `Default style set to ${JSON.stringify(spec)}.\n` +
        `Stored at ${STYLE_CONFIG_PATH}. pages_create uses this when no style is passed.\n\n` +
        styleTable(resolved),
    );
  }

  // action === "apply": restyle an existing document in place.
  if (!opts.path) return bad("ERROR: action=apply needs path.");
  const target = path.resolve(opts.path.replace(/^~(?=\/|$)/, os.homedir()));
  if (!fs.existsSync(target)) return bad(`ERROR: no such file: ${target}`);

  let resolved: ResolvedStyle;
  try {
    resolved = resolveStyle(opts.style ?? loadDefaultStyle());
  } catch (err) {
    return bad(`ERROR: ${(err as Error).message}`);
  }

  const model = await readDocument(target, MAX_PARAGRAPH_STYLE);
  if (isResult(model)) return model;
  if (!model.paragraphs.length) return bad(`ERROR: ${target} has no paragraphs to restyle.`);

  const bodySize = bodySizeOf(model.paragraphs);
  const faces: string[] = [];
  const sizes: number[] = [];
  const colors: Array<[number, number, number]> = [];
  const tally = new Map<string, number>();

  for (const p of model.paragraphs) {
    const role = p.text.trim() ? inferRole(p, bodySize) : "body";
    const spec = blockStyle(role, resolved);
    faces.push(spec.font);
    sizes.push(spec.size);
    colors.push(spec.color);
    if (p.text.trim()) tally.set(role, (tally.get(role) ?? 0) + 1);
  }

  const script =
    [
      `with timeout of 180 seconds`,
      `  tell application id "${PAGES_BUNDLE_ID}"`,
      `  ${bindDocument(target)}`,
      `  set theFonts to ${strList(faces)}`,
      `  set theSizes to ${numList(sizes)}`,
      `  set theColors to ${colorList(colors)}`,
      `  set n to count of paragraphs of body text of doc`,
      `  set touched to 0`,
      `  repeat with i from 1 to (count of theFonts)`,
      `    if i \u2264 n then`,
      `      set r to my applyParaStyle(doc, i, item i of theSizes, item i of theFonts, item i of theColors)`,
      `      if r > 0 then set touched to touched + r`,
      `    end if`,
      `  end repeat`,
      `  save doc`,
      `  return (touched as text)`,
      `  end tell`,
      `end timeout`,
    ].join("\n") + LOCAL_HANDLERS;

  const res = await runAppleScript(script, 200_000);
  if (!res.ok) return bad(explainFailure(res));
  if (!(Number(res.out.trim()) || 0)) {
    return bad(
      `ERROR: Pages accepted none of the style writes on ${target}. The document is unchanged - ` +
        `it is probably locked, or the paragraphs live in layout objects rather than body text.`,
    );
  }

  const roles = [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([role, n]) => `${role} x${n}`)
    .join(", ");
  return ok(
    `Restyled ${model.paragraphs.length} paragraph(s) in ${target} to ${resolved.preset} / ${resolved.family} @ ${resolved.baseSize}pt.\n` +
      `roles detected (body size ${bodySize}pt): ${roles || "none"}\n` +
      `Text unchanged; this rewrites font, size and colour only.`,
  );
}

// --- pages_replace ---------------------------------------------------------

export type ReplaceScope = "document" | "paragraph" | "table" | "row" | "column" | "cell";

export interface ReplaceOptions {
  path?: string;
  find: string;
  replace?: string;
  scope?: ReplaceScope;
  paragraph?: number;
  table?: number;
  row?: number;
  col?: number;
  all?: boolean;
  keepFormat?: boolean;
  save?: boolean;
}

export async function pagesReplace(opts: ReplaceOptions): Promise<Result> {
  const missing = requireApp();
  if (missing) return missing;

  const target = opts.path ? path.resolve(opts.path.replace(/^~(?=\/|$)/, os.homedir())) : null;
  if (target && !fs.existsSync(target)) return bad(`ERROR: no such file: ${target}`);
  if (!target) return bad("ERROR: path is required - pass the .pages file to modify.");
  if (!opts.find) return bad("ERROR: find is required.");

  const scope: ReplaceScope = opts.scope ?? "document";
  const tableIndex = opts.table ?? 1;
  const needle = opts.find;
  const replacement = opts.replace ?? "";
  const replaceAll = opts.all !== false;
  const keepFormat = opts.keepFormat !== false;

  const model = await readDocument(target, MAX_PARAGRAPH_STYLE);
  if (isResult(model)) return model;

  // ---- which paragraphs are in scope -------------------------------------
  let paraIndices: number[] = [];
  if (scope === "document") {
    paraIndices = model.paragraphs.map((_, i) => i + 1);
  } else if (scope === "paragraph") {
    if (!opts.paragraph) return bad("ERROR: scope=paragraph needs a 1-based `paragraph` index.");
    if (opts.paragraph > model.paragraphs.length) {
      return bad(`ERROR: paragraph ${opts.paragraph} is past the end (${model.paragraphs.length}).`);
    }
    paraIndices = [opts.paragraph];
  }

  const paraEdits: Array<{ index: number; text: string; font: string; size: number; color: [number, number, number] }> = [];
  let paraHits = 0;
  let paraCount = 0;

  for (const idx of paraIndices) {
    const p = model.paragraphs[idx - 1];
    if (!p || !p.text.includes(needle)) continue;
    const hits = p.text.split(needle).length - 1;
    const next = replaceAll ? p.text.split(needle).join(replacement) : p.text.replace(needle, replacement);
    paraHits += replaceAll ? hits : 1;
    paraCount += 1;
    paraEdits.push({ index: idx, text: next, font: p.font, size: p.size, color: p.color });
  }

  // ---- which cells are in scope ------------------------------------------
  const cellEdits: Array<{ table: number; row: number; col: number; value: string }> = [];
  let cellHits = 0;

  const inScope = (t: number, r: number, c: number): boolean => {
    switch (scope) {
      case "document":
        return true;
      case "table":
        return t === tableIndex;
      case "row":
        return t === tableIndex && r === (opts.row ?? 0);
      case "column":
        return t === tableIndex && c === (opts.col ?? 0);
      case "cell":
        return t === tableIndex && r === (opts.row ?? 0) && c === (opts.col ?? 0);
      default:
        return false;
    }
  };

  if (scope !== "paragraph") {
    if (scope === "row" && !opts.row) return bad("ERROR: scope=row needs a 1-based `row`.");
    if (scope === "column" && !opts.col) return bad("ERROR: scope=column needs a 1-based `col`.");
    if (scope === "cell" && (!opts.row || !opts.col)) return bad("ERROR: scope=cell needs `row` and `col`.");

    for (const table of model.tables) {
      table.grid.forEach((row, r) => {
        row.forEach((value, c) => {
          const addr = { table: table.index, row: r + 1, col: c + 1 };
          if (!inScope(addr.table, addr.row, addr.col)) return;
          if (!value || !value.includes(needle)) return;
          const hits = value.split(needle).length - 1;
          const next = replaceAll ? value.split(needle).join(replacement) : value.replace(needle, replacement);
          cellHits += replaceAll ? hits : 1;
          cellEdits.push({ ...addr, value: next });
        });
      });
    }
  }

  if (!paraEdits.length && !cellEdits.length) {
    return bad(`No occurrences of ${JSON.stringify(needle)} in scope "${scope}" of ${target}.`);
  }

  // ---- one script doing both kinds of edit --------------------------------
  const lines: string[] = [
    `with timeout of 180 seconds`,
    `  tell application id "${PAGES_BUNDLE_ID}"`,
    `  ${bindDocument(target)}`,
  ];

  if (paraEdits.length) {
    lines.push(
      `  set theIdx to ${numList(paraEdits.map((e) => e.index))}`,
      `  set theTexts to ${strList(paraEdits.map((e) => e.text))}`,
      `  set theFonts to ${strList(paraEdits.map((e) => e.font))}`,
      `  set theSizes to ${numList(paraEdits.map((e) => e.size))}`,
      `  set theColors to ${colorList(paraEdits.map((e) => e.color))}`,
      `  set n to count of paragraphs of body text of doc`,
      `  repeat with k from 1 to (count of theIdx)`,
      `    set i to item k of theIdx`,
      `    if i \u2264 n then`,
      // No blanket try here: it used to swallow -10006 and report success on a
      // document where nothing had changed. writePara picks its own strategy.
      keepFormat
        ? `      my writePara(doc, i, my splitText(item k of theTexts), true, {item k of theSizes}, {item k of theFonts}, {item k of theColors})`
        : `      my writePara(doc, i, my splitText(item k of theTexts), false, {}, {}, {})`,
      `    end if`,
      `  end repeat`,
    );
  }

  if (cellEdits.length) {
    lines.push(`  set theTables to tables of doc`);
    const usedTables = [...new Set(cellEdits.map((e) => e.table))];
    for (const t of usedTables) {
      lines.push(`  set tbl${t} to item ${t} of theTables`);
    }
    for (const edit of cellEdits) {
      lines.push(
        `  repeat with c in cells of tbl${edit.table}`,
        `    try`,
        `      if (address of row of c) is ${edit.row} and (address of column of c) is ${edit.col} then`,
        `        set value of c to ${asLit(edit.value)}`,
        `        exit repeat`,
        `      end if`,
        `    end try`,
        `  end repeat`,
      );
    }
  }

  lines.push(opts.save === false ? "" : `  save doc`, `  return "ok"`, `  end tell`, `end timeout`);

  const res = await runAppleScript(lines.filter(Boolean).join("\n"), 200_000);
  if (!res.ok) return bad(explainFailure(res));

  const where: string[] = [];
  if (paraCount) where.push(`${paraCount} paragraph(s)`);
  if (cellEdits.length) where.push(`${cellEdits.length} table cell(s)`);
  return ok(
    `Replaced ${paraHits + cellHits} occurrence(s) of ${JSON.stringify(needle)} ` +
      `in ${where.join(" and ")} of ${target} (scope: ${scope}, format: ${keepFormat ? "preserved" : "not reapplied"}).`,
  );
}

// --- pages_find ------------------------------------------------------------

export interface FindOptions {
  path?: string;
  query: string;
  caseSensitive?: boolean;
  maxResults?: number;
}

export async function pagesFind(opts: FindOptions): Promise<Result> {
  const missing = requireApp();
  if (missing) return missing;
  if (!opts.query) return bad("ERROR: query is required.");

  const target = opts.path ? path.resolve(opts.path.replace(/^~(?=\/|$)/, os.homedir())) : null;
  if (target && !fs.existsSync(target)) return bad(`ERROR: no such file: ${target}`);

  const model = await readDocument(target, 2000);
  if (isResult(model)) return model;

  const limit = Math.min(opts.maxResults ?? 50, 500);
  const needle = opts.caseSensitive ? opts.query : opts.query.toLowerCase();
  const has = (text: string) => (opts.caseSensitive ? text : text.toLowerCase()).includes(needle);

  const hits: string[] = [];
  for (let i = 0; i < model.paragraphs.length; i++) {
    const text = model.paragraphs[i].text;
    if (!has(text)) continue;
    const at = opts.caseSensitive ? text.indexOf(opts.query) : text.toLowerCase().indexOf(needle);
    const from = Math.max(0, at - 30);
    const snippet = `${from > 0 ? "…" : ""}${text.slice(from, at + opts.query.length + 30)}${at + 30 < text.length ? "…" : ""}`;
    hits.push(`  paragraph ${i + 1}: "${snippet.trim()}"`);
    if (hits.length >= limit) break;
  }

  if (hits.length < limit) {
    for (const table of model.tables) {
      for (let r = 0; r < table.grid.length; r++) {
        for (let c = 0; c < table.grid[r].length; c++) {
          const value = table.grid[r][c] ?? "";
          if (!has(value)) continue;
          hits.push(`  table ${table.index} r${r + 1}c${c + 1}: "${value.slice(0, 80)}"`);
          if (hits.length >= limit) break;
        }
        if (hits.length >= limit) break;
      }
      if (hits.length >= limit) break;
    }
  }

  if (!hits.length) return ok(`No matches for ${JSON.stringify(opts.query)} in ${model.name}.`);
  return ok(
    `${hits.length}${hits.length >= limit ? "+" : ""} match(es) for ${JSON.stringify(opts.query)} in ${model.name}:\n` +
      hits.join("\n") +
      (hits.length >= limit ? `\n(stopped at ${limit} - raise maxResults to see more)` : ""),
  );
}

// --- pages_stats -----------------------------------------------------------

export async function pagesStats(opts: ReadOptions = {}): Promise<Result> {
  const missing = requireApp();
  if (missing) return missing;

  const target = opts.path ? path.resolve(opts.path.replace(/^~(?=\/|$)/, os.homedir())) : null;
  if (target && !fs.existsSync(target)) return bad(`ERROR: no such file: ${target}`);

  const model = await readDocument(target, 5000);
  if (isResult(model)) return model;

  const text = model.paragraphs.map((p) => p.text).join("\n");
  const words = text.split(/\s+/).filter(Boolean).length;
  const nonEmpty = model.paragraphs.filter((p) => p.text.trim()).length;
  const cellCount = model.tables.reduce((n, t) => n + t.grid.reduce((m, r) => m + r.length, 0), 0);

  // Object/page counts live only in the app, so ask for them in one round trip.
  const script = [
    `with timeout of 60 seconds`,
    `  tell application id "${PAGES_BUNDLE_ID}"`,
    `  ${bindDocument(target)}`,
    `  set pc to 0`,
    `  try`,
    `    set pc to count of pages of doc`,
    `  on error`,
    `    try`,
    `      set pc to count of pages of section 1 of doc`,
    `    end try`,
    `  end try`,
    `  set sc to 0`,
    `  try`,
    `    set sc to count of sections of doc`,
    `  end try`,
    `  set ic to 0`,
    `  try`,
    `    set ic to count of images of doc`,
    `  end try`,
    `  set tc to 0`,
    `  try`,
    `    set tc to count of text items of doc`,
    `  end try`,
    `  set hc to 0`,
    `  try`,
    `    set hc to count of shapes of doc`,
    `  end try`,
    `  return (pc as text) & (ASCII character 30) & (sc as text) & (ASCII character 30) & (ic as text) & (ASCII character 30) & (tc as text) & (ASCII character 30) & (hc as text)`,
    `  end tell`,
    `end timeout`,
  ].join("\n");

  const res = await runAppleScript(script, 70_000);
  const counts = res.ok ? res.out.split(US).map((n) => Number(n) || 0) : [];

  return ok(
    `${model.name}\n` +
      (model.filePath ? `path: ${model.filePath}\n` : "path: (unsaved)\n") +
      `\n` +
      `pages: ${counts[0] ?? "?"}   sections: ${counts[1] ?? "?"}\n` +
      `paragraphs: ${model.total} (${nonEmpty} non-empty)   words: ${words}   characters: ${text.length}\n` +
      `tables: ${model.tables.length} (${cellCount} cells)\n` +
      `images: ${counts[2] ?? "?"}   text boxes: ${counts[3] ?? "?"}   shapes: ${counts[4] ?? "?"}`,
  );
}

// --- pages_insert_image ----------------------------------------------------

export interface InsertImageOptions {
  path?: string;
  imagePath: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  description?: string;
  opacity?: number;
}

export async function pagesInsertImage(opts: InsertImageOptions): Promise<Result> {
  const missing = requireApp();
  if (missing) return missing;

  const target = opts.path ? path.resolve(opts.path.replace(/^~(?=\/|$)/, os.homedir())) : null;
  if (!target) return bad("ERROR: path (the .pages document) is required.");
  if (!fs.existsSync(target)) return bad(`ERROR: no such file: ${target}`);

  const image = path.resolve(opts.imagePath.replace(/^~(?=\/|$)/, os.homedir()));
  if (!fs.existsSync(image)) return bad(`ERROR: no such image: ${image}`);

  const lines = [
    `with timeout of 180 seconds`,
    `  tell application id "${PAGES_BUNDLE_ID}"`,
    `  ${bindDocument(target)}`,
    `  set img to missing value`,
    `  try`,
    `    set img to make new image at end of body text of doc with properties {file:POSIX file ${asLit(image)}}`,
    `  on error`,
    `    set img to make new image at end of section 1 of doc with properties {file:POSIX file ${asLit(image)}}`,
    `  end try`,
  ];
  if (opts.width) lines.push(`  try`, `    set width of img to ${Math.round(opts.width)}`, `  end try`);
  if (opts.height) lines.push(`  try`, `    set height of img to ${Math.round(opts.height)}`, `  end try`);
  if (opts.x !== undefined && opts.y !== undefined) {
    lines.push(`  try`, `    set position of img to {${Math.round(opts.x)}, ${Math.round(opts.y)}}`, `  end try`);
  }
  if (opts.description) {
    lines.push(`  try`, `    set description of img to ${asLit(opts.description)}`, `  end try`);
  }
  if (opts.opacity !== undefined) {
    lines.push(`  try`, `    set opacity of img to ${Math.round(opts.opacity)}`, `  end try`);
  }
  lines.push(`  save doc`, `  return "ok"`, `  end tell`, `end timeout`);

  const res = await runAppleScript(lines.join("\n"), 200_000);
  if (!res.ok) return bad(explainFailure(res));
  return ok(
    `Inserted ${path.basename(image)} into ${path.basename(target)}` +
      (opts.width || opts.height ? ` at ${opts.width ?? "auto"}x${opts.height ?? "auto"}pt` : "") +
      ".",
  );
}

// --- pages_insert_textbox --------------------------------------------------

export interface InsertTextboxOptions {
  path?: string;
  text: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  size?: number;
  font?: string;
  color?: string;
}

export async function pagesInsertTextbox(opts: InsertTextboxOptions): Promise<Result> {
  const missing = requireApp();
  if (missing) return missing;

  const target = opts.path ? path.resolve(opts.path.replace(/^~(?=\/|$)/, os.homedir())) : null;
  if (!target) return bad("ERROR: path (the .pages document) is required.");
  if (!fs.existsSync(target)) return bad(`ERROR: no such file: ${target}`);
  if (!opts.text) return bad("ERROR: text is required.");

  let colorRgb: [number, number, number] | null = null;
  try {
    if (opts.color) colorRgb = hexToApple(opts.color);
  } catch (err) {
    return bad(`ERROR: ${(err as Error).message}`);
  }

  const props = [
    opts.x !== undefined && opts.y !== undefined ? `position:{${Math.round(opts.x)}, ${Math.round(opts.y)}}` : "",
    opts.width ? `width:${Math.round(opts.width)}` : "",
    opts.height ? `height:${Math.round(opts.height)}` : "",
  ].filter(Boolean);
  const propList = props.length ? ` with properties {${props.join(", ")}}` : "";

  const lines = [
    `with timeout of 180 seconds`,
    `  tell application id "${PAGES_BUNDLE_ID}"`,
    `  ${bindDocument(target)}`,
    `  set tb to missing value`,
    `  try`,
    `    set tb to make new text item at end of body text of doc${propList}`,
    `  on error`,
    `    set tb to make new text item at end of section 1 of doc${propList}`,
    `  end try`,
    `  set object text of tb to ${asLit(opts.text)}`,
  ];
  if (opts.font) lines.push(`  try`, `    set font of object text of tb to ${asLit(opts.font)}`, `  end try`);
  if (opts.size) lines.push(`  try`, `    set size of object text of tb to ${opts.size}`, `  end try`);
  if (colorRgb) lines.push(`  try`, `    set color of object text of tb to {${colorRgb.join(", ")}}`, `  end try`);
  lines.push(`  save doc`, `  return "ok"`, `  end tell`, `end timeout`);

  const res = await runAppleScript(lines.join("\n"), 200_000);
  if (!res.ok) return bad(explainFailure(res));
  return ok(`Added a text box to ${path.basename(target)} (${opts.text.length} characters).`);
}

// --- pages_objects ---------------------------------------------------------

export type ObjectKind = "image" | "textbox" | "shape";

export interface ObjectsOptions {
  path?: string;
  action: "list" | "delete";
  kind?: ObjectKind;
  index?: number;
}

const OBJECT_ELEMENT: Record<ObjectKind, string> = {
  image: "images",
  textbox: "text items",
  shape: "shapes",
};

export async function pagesObjects(opts: ObjectsOptions): Promise<Result> {
  const missing = requireApp();
  if (missing) return missing;

  const target = opts.path ? path.resolve(opts.path.replace(/^~(?=\/|$)/, os.homedir())) : null;
  if (!target) return bad("ERROR: path (the .pages document) is required.");
  if (!fs.existsSync(target)) return bad(`ERROR: no such file: ${target}`);

  if (opts.action === "delete") {
    if (!opts.kind) return bad("ERROR: action=delete needs kind (image, textbox or shape).");
    if (!opts.index) return bad("ERROR: action=delete needs a 1-based index.");
    const element = OBJECT_ELEMENT[opts.kind];

    const script = [
      `with timeout of 120 seconds`,
      `  tell application id "${PAGES_BUNDLE_ID}"`,
      `  ${bindDocument(target)}`,
      `  set theItems to ${element} of doc`,
      `  if (count of theItems) < ${opts.index} then error "no ${opts.kind} at index ${opts.index}"`,
      `  delete item ${opts.index} of theItems`,
      `  save doc`,
      `  return "ok"`,
      `  end tell`,
      `end timeout`,
    ].join("\n");

    const res = await runAppleScript(script, 130_000);
    if (!res.ok) return bad(explainFailure(res));
    return ok(`Deleted ${opts.kind} ${opts.index} from ${path.basename(target)}.`);
  }

  // list
  const collect = (element: string, kind: ObjectKind) =>
    [
      `  set i to 0`,
      `  try`,
      `    repeat with o in ${element} of doc`,
      `      set i to i + 1`,
      `      set px to 0`,
      `      set py to 0`,
      `      set ww to 0`,
      `      set hh to 0`,
      `      set lb to ""`,
      `      try`,
      `        set pos to position of o`,
      `        set px to item 1 of pos`,
      `        set py to item 2 of pos`,
      `        set ww to width of o`,
      `        set hh to height of o`,
      `      end try`,
      `      try`,
      `        set lb to description of o`,
      `      end try`,
      `      try`,
      `        set lb to (object text of o) as text`,
      `      end try`,
      `      set out to out & ${asLit(kind)} & (ASCII character 30) & (i as text) & (ASCII character 30) & (px as text) & (ASCII character 30) & (py as text) & (ASCII character 30) & (ww as text) & (ASCII character 30) & (hh as text) & (ASCII character 30) & lb & (ASCII character 31)`,
      `    end repeat`,
      `  end try`,
    ].join("\n");

  const script = [
    `with timeout of 120 seconds`,
    `  tell application id "${PAGES_BUNDLE_ID}"`,
    `  ${bindDocument(target)}`,
    `  set out to ""`,
    collect("images", "image"),
    collect("text items", "textbox"),
    collect("shapes", "shape"),
    `  return out`,
    `  end tell`,
    `end timeout`,
  ].join("\n");

  const res = await runAppleScript(script, 130_000);
  if (!res.ok) return bad(explainFailure(res));

  const rows: string[] = [];
  for (const record of res.out.split(RS)) {
    if (!record) continue;
    const f = record.split(US);
    const label = (f[6] ?? "").replace(/\s+/g, " ").slice(0, 40);
    rows.push(
      `  ${(f[0] ?? "").padEnd(8)} ${String(f[1] ?? "").padStart(3)}  ${String(f[4] ?? "").padStart(5)}x${String(f[5] ?? "").padStart(4)}  at (${f[2] ?? "?"}, ${f[3] ?? "?"})${label ? `  "${label}"` : ""}`,
    );
  }

  if (!rows.length) return ok(`${path.basename(target)} has no floating objects.`);
  return ok(
    `floating objects in ${path.basename(target)} (kind, index, size, position):\n${rows.join("\n")}`,
  );
}

// --- pages_duplicate -------------------------------------------------------

export interface DuplicateOptions {
  path: string;
  destPath: string;
  overwrite?: boolean;
}

/** Copy the .pages package on disk - no Pages involvement at all. */
export async function pagesDuplicate(opts: DuplicateOptions): Promise<Result> {
  const src = path.resolve(opts.path.replace(/^~(?=\/|$)/, os.homedir()));
  const dest = path.resolve(opts.destPath.replace(/^~(?=\/|$)/, os.homedir()));
  if (!fs.existsSync(src)) return bad(`ERROR: no such file: ${src}`);
  if (!dest.toLowerCase().endsWith(".pages")) return bad("ERROR: destination must end in .pages.");
  if (src === dest) return bad("ERROR: source and destination are the same path.");
  if (fs.existsSync(dest) && !opts.overwrite) {
    return bad(`ERROR: ${dest} already exists. Pass overwrite=true to replace it.`);
  }
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  try {
    fs.cpSync(src, dest, { recursive: true });
  } catch (err) {
    return bad(`ERROR: copy failed: ${(err as Error).message}`);
  }
  const stat = fs.statSync(dest);
  return ok(`Copied ${src} -> ${dest}${stat.isDirectory() ? " (package)" : ""}. No Pages interaction.`);
}

// --- shared editing helpers ------------------------------------------------

/** Resolve and validate a target path, or return the error to hand back. */
function resolveTarget(p?: string): string | Result {
  if (!p) return bad("ERROR: path is required - pass the .pages file to modify.");
  const resolved = path.resolve(p.replace(/^~(?=\/|$)/, os.homedir()));
  if (!fs.existsSync(resolved)) return bad(`ERROR: no such file: ${resolved}`);
  return resolved;
}

/** Narrowing helper: true when resolveTarget() returned an error. */
function failed(value: string | Result): value is Result {
  return typeof value !== "string";
}

/**
 * Pick the PostScript face for an edit. Bold and italic are not separate
 * properties in Pages' dictionary - they are different faces of the same
 * family - so swapping the face is how you toggle them without losing the
 * typeface the paragraph already uses.
 */
function faceFor(current: string, opts: { font?: string; bold?: boolean; italic?: boolean }): string {
  if (opts.font) return opts.font;
  const info = describeFont(current);
  const bold = opts.bold ?? info?.bold ?? false;
  const italic = opts.italic ?? info?.italic ?? false;
  return variantOf(current, bold, italic, FONT_FAMILIES["helvetica-neue"]);
}

/** Local handlers, appended after the tell block (AppleScript needs them top level). */
const LOCAL_HANDLERS = [
  "",
  "on joinList(theList)",
  "  set oldDelims to AppleScript's text item delimiters",
  "  set AppleScript's text item delimiters to linefeed",
  "  set outText to theList as text",
  "  set AppleScript's text item delimiters to oldDelims",
  "  return outText",
  "end joinList",
  "",
  // Paragraph-safe split: a linefeed can never live inside one paragraph.
  "on splitText(txt)",
  `  set s to txt as text`,
  `  if s is "" then return {""}`,
  `  set oldDelims to AppleScript's text item delimiters`,
  `  set AppleScript's text item delimiters to linefeed`,
  `  set parts to every text item of s`,
  `  set AppleScript's text item delimiters to oldDelims`,
  `  return parts`,
  `end splitText`,
  "",
  "on offsetOf(haystack, needle, startAt)",
  "  set hay to haystack as text",
  "  if startAt > (count of characters of hay) then return 0",
  "  set sub to text startAt thru -1 of hay",
  "  set off to offset of needle in sub",
  "  if off is 0 then return 0",
  "  return startAt + off - 1",
  "end offsetOf",
  "",
  // --- text access -------------------------------------------------------
  // Pages hands back an empty string for a blank spacer paragraph, and every
  // property read on "" raises -1728 ("Can't get font of """). Nothing below
  // touches a paragraph property without a try around it.
  "on paraTextOf(docRef, pIdx)",
  `  tell application id "${PAGES_BUNDLE_ID}"`,
  `    set t to ""`,
  `    try`,
  `      set t to (contents of paragraph pIdx of body text of docRef) as text`,
  `    end try`,
  `    return t`,
  `  end tell`,
  `end paraTextOf`,
  "",
  "on paraStyleOf(docRef, pIdx)",
  `  tell application id "${PAGES_BUNDLE_ID}"`,
  `    set sz to 0`,
  `    set fz to ""`,
  `    set cl to missing value`,
  `    try`,
  `      set p to paragraph pIdx of body text of docRef`,
  `      try`,
  `        set sz to (size of p) as number`,
  `      end try`,
  `      try`,
  `        set fz to (font of p) as text`,
  `      end try`,
  `      try`,
  `        set cl to (color of p)`,
  `      end try`,
  `    end try`,
  `    return {sz, fz, cl}`,
  `  end tell`,
  `end paraStyleOf`,
  "",
  // 0 / "" / missing value all mean "unknown, leave it alone" rather than
  // "set it". Returns -1 when the paragraph is gone, otherwise how many
  // properties were actually written - so a refusal cannot look like success.
  "on applyParaStyle(docRef, pIdx, sz, fz, cl)",
  `  tell application id "${PAGES_BUNDLE_ID}"`,
  `    set p to missing value`,
  `    try`,
  `      set p to paragraph pIdx of body text of docRef`,
  `    end try`,
  `    if p is missing value then return -1`,
  `    set nWrote to 0`,
  `    try`,
  `      if sz > 0 then`,
  `        set size of p to sz`,
  `        set nWrote to nWrote + 1`,
  `      end if`,
  `    end try`,
  `    try`,
  `      if fz is not "" then`,
  `        set font of p to fz`,
  `        set nWrote to nWrote + 1`,
  `      end if`,
  `    end try`,
  `    try`,
  `      if cl is not missing value then`,
  `        set color of p to cl`,
  `        set nWrote to nWrote + 1`,
  `      end if`,
  `    end try`,
  `    return nWrote`,
  `  end tell`,
  `end applyParaStyle`,
  "",
  // Structural insert. Uses `make new paragraph`, never a text write, so it
  // works on documents that refuse `set contents` with -10006.
  "on insertLinesAt(docRef, pIdx, theLines, doBefore, doStyle, szList, fzList, clList)",
  `  tell application id "${PAGES_BUNDLE_ID}"`,
  `    set nNew to count of theLines`,
  `    if nNew is 0 then return 0`,
  `    set tot to count of paragraphs of body text of docRef`,
  `    if tot is 0 then`,
  `      repeat with k from 1 to nNew`,
  `        make new paragraph at end of body text of docRef with data (item k of theLines)`,
  `      end repeat`,
  `      set firstNew to 1`,
  `    else`,
  `      if doBefore then`,
  `        set anchorIdx to pIdx`,
  `      else`,
  `        set anchorIdx to pIdx + 1`,
  `      end if`,
  `      if anchorIdx > tot then`,
  `        repeat with k from 1 to nNew`,
  `          make new paragraph at end of body text of docRef with data (item k of theLines)`,
  `        end repeat`,
  `        set firstNew to tot + 1`,
  `      else`,
  `        if anchorIdx < 1 then set anchorIdx to 1`,
  `        repeat with k from nNew to 1 by -1`,
  `          make new paragraph at paragraph anchorIdx of body text of docRef with data (item k of theLines)`,
  `        end repeat`,
  `        set firstNew to anchorIdx`,
  `      end if`,
  `    end if`,
  `    if doStyle then`,
  `      set nStyles to count of szList`,
  `      if nStyles > 0 then`,
  `        repeat with k from 1 to nNew`,
  `          set sk to k`,
  `          if sk > nStyles then set sk to nStyles`,
  `          my applyParaStyle(docRef, firstNew + k - 1, item sk of szList, item sk of fzList, item sk of clList)`,
  `        end repeat`,
  `      end if`,
  `    end if`,
  `    return firstNew`,
  `  end tell`,
  `end insertLinesAt`,
  "",
  // Replace paragraph pIdx with one or more paragraphs. A multi-paragraph
  // string can never be assigned to a single paragraph, so anything longer
  // than one line goes through the structural path.
  "on writePara(docRef, pIdx, theLines, doStyle, szList, fzList, clList)",
  `  tell application id "${PAGES_BUNDLE_ID}"`,
  `    set nNew to count of theLines`,
  `    if nNew is 0 then return "empty"`,
  `    set tot to count of paragraphs of body text of docRef`,
  `    if tot is 0 then`,
  `      my insertLinesAt(docRef, 1, theLines, true, doStyle, szList, fzList, clList)`,
  `      return "structural"`,
  `    end if`,
  `    if pIdx < 1 then set pIdx to 1`,
  `    if pIdx > tot then set pIdx to tot`,
  `    if nNew is 1 then`,
  `      try`,
  `        set contents of paragraph pIdx of body text of docRef to (item 1 of theLines)`,
  `        if doStyle then my applyParaStyle(docRef, pIdx, item 1 of szList, item 1 of fzList, item 1 of clList)`,
  `        return "direct"`,
  `      end try`,
  `    end if`,
  `    my insertLinesAt(docRef, pIdx, theLines, false, doStyle, szList, fzList, clList)`,
  `    delete paragraph pIdx of body text of docRef`,
  `    return "structural"`,
  `  end tell`,
  `end writePara`,
].join("\n");

/** Split any incoming text into paragraphs - Pages cannot hold a linefeed inside one. */
function splitParagraphs(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

/** AppleScript list literal holding one string per paragraph. */
function linesLit(texts: string[]): string {
  return `{${texts.map(asLit).join(", ")}}`;
}

/**
 * The argument tuple every write call shares. `doStyle: false` means "inherit
 * the neighbour's formatting", which is what a replacement should do.
 */
function styleArgs(
  texts: string[],
  styles: Array<{ size: number; font: string; color: [number, number, number] }> | null,
): { doStyle: string; sizes: string; fonts: string; colors: string } {
  if (!styles) {
    return { doStyle: "false", sizes: "{}", fonts: "{}", colors: "{}" };
  }
  return {
    doStyle: "true",
    sizes: numList(texts.map((_, i) => styles[i]?.size ?? 0)),
    fonts: strList(texts.map((_, i) => styles[i]?.font ?? "")),
    // Pure black means "we could not read the colour" (blank paragraph), so it
    // stays untouched instead of forcing black over an inherited style.
    colors: `{${texts
      .map((_, i) => {
        const c = styles[i]?.color;
        return c && (c[0] || c[1] || c[2]) ? `{${c[0]}, ${c[1]}, ${c[2]}}` : "missing value";
      })
      .join(", ")}}`,
  };
}

/** Standard timeout + document binding wrapper. */
function pagesScript(target: string, body: string[], withHandlers = true): string {
  const script = [
    `with timeout of 220 seconds`,
    `  tell application id "${PAGES_BUNDLE_ID}"`,
    `  ${bindDocument(target)}`,
    ...body.filter((line) => line !== ""),
    `  end tell`,
    `end timeout`,
  ].join("\n");
  return withHandlers ? script + LOCAL_HANDLERS : script;
}

/** Reapply rendered typography to `count` paragraphs starting at `startExpr`. */
function styleRangeScript(startExpr: string, count: number, apply: boolean): string[] {
  if (!apply || count <= 0) return [];
  return [
    `  set total to count of paragraphs of body text of doc`,
    `  repeat with k from 1 to ${count}`,
    `    set i to ${startExpr} + k - 1`,
    `    if i \u2264 total then`,
    `      my applyParaStyle(doc, i, item k of theSizes, item k of theFonts, item k of theColors)`,
    `    end if`,
    `  end repeat`,
  ];
}

/** Splice the rendered block in next to the paragraph at `anchorExpr`. */
function spliceScript(anchorExpr: string, position: "before" | "after", count: number, styled: boolean): string[] {
  const before = position === "before";
  return [
    `  set total to count of paragraphs of body text of doc`,
    `  set idx to ${anchorExpr}`,
    `  if idx < 1 then set idx to 1`,
    `  if idx > total then set idx to total`,
    `  my insertLinesAt(doc, idx, theTexts, ${before}, ${styled}, theSizes, theFonts, theColors)`,
  ];
}

/** Common front half of the block-driven ops: resolve style + render. */
function renderForEdit(
  blocks: PageBlock[],
  styleSpec: string | StyleSpec | undefined,
  format: "styled" | "plain" | undefined,
): { rendered: ReturnType<typeof renderBlocks>; style: ResolvedStyle; styled: boolean; tables: string } | Result {
  const blockError = validateBlocks(blocks);
  if (blockError) return bad(blockError);

  let style: ResolvedStyle;
  try {
    style = resolveStyle(styleSpec);
  } catch (err) {
    return bad(`ERROR: ${(err as Error).message}`);
  }

  const rendered = renderBlocks(blocks, style);
  return {
    rendered,
    style,
    styled: (format ?? "styled") === "styled",
    tables: rendered.tables.map((t, i) => buildTable(t, i + 1, style)).join("\n"),
  };
}

// --- pages_edit: text and paragraph structure ------------------------------

export type EditOp =
  | "append"
  | "prepend"
  | "setBody"
  | "insertParagraph"
  | "replaceParagraph"
  | "insertText"
  | "deleteText"
  | "splitParagraph"
  | "mergeParagraphs"
  | "duplicateParagraph"
  | "moveParagraph"
  | "deleteParagraph";

export interface EditOptions {
  path?: string;
  op: EditOp;
  blocks?: PageBlock[];
  text?: string;
  anchor?: number;
  position?: "before" | "after";
  paragraph?: number;
  from?: number;
  to?: number;
  after?: number;
  offset?: number;
  charFrom?: number;
  charTo?: number;
  separator?: string;
  format?: "styled" | "plain";
  style?: string | StyleSpec;
  save?: boolean;
}

/**
 * Replace the whole body. The old version assigned the entire text in one go,
 * which both loses every table and is refused outright (-10006) on documents
 * that lock down text writes. This trims the body down to one paragraph and
 * then writes through the same engine every other op uses.
 */
function rewriteScript(texts: string[], styled: boolean): string {
  return [
    `  set total to count of paragraphs of body text of doc`,
    `  if total > 1 then`,
    `    repeat with i from total to 2 by -1`,
    `      delete paragraph i of body text of doc`,
    `    end repeat`,
    `  end if`,
    `  set writeMode to my writePara(doc, 1, ${linesLit(texts)}, ${styled}, theSizes, theFonts, theColors)`,
  ].join("\n");
}

export async function pagesEdit(opts: EditOptions): Promise<Result> {
  const missing = requireApp();
  if (missing) return missing;

  const target = resolveTarget(opts.path);
  if (failed(target)) return target;

  const saveLine = opts.save === false ? "" : `  save doc`;
  const op = opts.op;

  // The table and formatting ops moved to their own tools, where the parameter
  // names mean exactly one thing. Point callers at them instead of guessing.
  const legacyOp: string = op;
  if (legacyOp === "setCell" || legacyOp === "formatTable") {
    return bad(`ERROR: op=${legacyOp} moved to the pages_table tool (same parameters, clearer scope).`);
  }
  if (legacyOp === "formatParagraphs") {
    return bad("ERROR: op=formatParagraphs moved to the pages_format tool (op=paragraphs).");
  }

  // ---- block-driven ops ---------------------------------------------------
  if (op === "append" || op === "prepend" || op === "setBody") {
    if (!opts.blocks?.length) return bad(`ERROR: op=${op} needs blocks.`);
    const prep = renderForEdit(opts.blocks, opts.style, opts.format);
    if ("ok" in prep) return prep;
    const { rendered, styled, tables } = prep;

    const preamble = [
      `  set theTexts to ${strList(rendered.texts)}`,
      `  set theSizes to ${numList(rendered.sizes)}`,
      `  set theFonts to ${strList(rendered.fonts)}`,
      `  set theColors to ${colorList(rendered.colors)}`,
    ];

    if (op === "setBody") {
      const script = pagesScript(target, [
        ...preamble,
        rewriteScript(rendered.texts, styled),
        tables,
        saveLine,
        `  return (count of paragraphs of body text of doc) as text`,
      ]);
      const res = await runAppleScript(script, 220_000);
      if (!res.ok) return bad(explainFailure(res));
      return ok(
        `Replaced the body of ${target} with ${rendered.texts.length} paragraph(s)` +
          (rendered.tables.length ? ` and ${rendered.tables.length} table(s)` : "") +
          `. Document now has ${res.out.trim()} paragraphs.`,
      );
    }

    if (op === "append") {
      const script = pagesScript(target, [
        ...preamble,
        `  set baseCount to count of paragraphs of body text of doc`,
        `  my insertLinesAt(doc, baseCount, theTexts, false, ${styled}, theSizes, theFonts, theColors)`,
        tables,
        saveLine,
        `  return (count of paragraphs of body text of doc) as text`,
      ]);

      const res = await runAppleScript(script, 220_000);
      if (!res.ok) return bad(explainFailure(res));
      return ok(
        `Appended ${rendered.texts.length} paragraph(s)` +
          (rendered.tables.length ? ` and ${rendered.tables.length} table(s)` : "") +
          ` to ${target}. Document now has ${res.out.trim()} paragraphs.`,
      );
    }

    // prepend: splice in front of paragraph 1, keeping its own typography.
    const script = pagesScript(target, [
      ...preamble,
      ...spliceScript("1", "before", rendered.texts.length, styled),
      tables,
      saveLine,
      `  return (count of paragraphs of body text of doc) as text`,
    ]);
    const res = await runAppleScript(script, 220_000);
    if (!res.ok) return bad(explainFailure(res));
    return ok(
      `Prepended ${rendered.texts.length} paragraph(s) to ${target}. Document now has ${res.out.trim()} paragraphs.`,
    );
  }

  // ---- insertParagraph ----------------------------------------------------
  if (op === "insertParagraph") {
    if (!opts.blocks?.length) return bad("ERROR: op=insertParagraph needs blocks.");
    if (!opts.anchor) return bad("ERROR: op=insertParagraph needs a 1-based `anchor` paragraph index.");
    const prep = renderForEdit(opts.blocks, opts.style, opts.format);
    if ("ok" in prep) return prep;
    const { rendered, styled, tables } = prep;
    const position = opts.position ?? "after";

    const script = pagesScript(target, [
      `  set theTexts to ${strList(rendered.texts)}`,
      `  set theSizes to ${numList(rendered.sizes)}`,
      `  set theFonts to ${strList(rendered.fonts)}`,
      `  set theColors to ${colorList(rendered.colors)}`,
      ...spliceScript(String(opts.anchor), position, rendered.texts.length, styled),
      tables,
      saveLine,
      `  return "ok"`,
    ]);

    const res = await runAppleScript(script, 220_000);
    if (!res.ok) return bad(explainFailure(res));
    return ok(
      `Inserted ${rendered.texts.length} paragraph(s) ${position} paragraph ${opts.anchor} in ${target}` +
        (rendered.tables.length ? ` (plus ${rendered.tables.length} table(s))` : "") +
        ".",
    );
  }

  // ---- insertText ---------------------------------------------------------
  if (op === "insertText") {
    if (!opts.paragraph) return bad("ERROR: op=insertText needs a 1-based `paragraph` index.");
    if (opts.text === undefined) return bad("ERROR: op=insertText needs `text`.");
    const offset = opts.offset ?? 0; // 0 / omitted = append at the end

    const script = pagesScript(target, [
      `  set idx to ${opts.paragraph}`,
      `  set total to count of paragraphs of body text of doc`,
      `  if idx > total then error "paragraph " & idx & " is past the end (" & total & ")"`,
      `  set t to my paraTextOf(doc, idx)`,
      `  set newText to ${asLit(opts.text)}`,
      `  set len to count of characters of t`,
      `  set off to ${offset}`,
      `  if off < 1 then set off to (len + 1)`,
      `  if off > (len + 1) then set off to (len + 1)`,
      `  if len is 0 then`,
      `    set nt to newText`,
      `  else if off is 1 then`,
      `    set nt to newText & t`,
      `  else if off > len then`,
      `    set nt to t & newText`,
      `  else`,
      `    set nt to (text 1 thru (off - 1) of t) & newText & (text off thru -1 of t)`,
      `  end if`,
      `  set writeMode to my writePara(doc, idx, my splitText(nt), false, {}, {}, {})`,
      saveLine,
      `  return writeMode`,
    ]);

    const res = await runAppleScript(script, 220_000);
    if (!res.ok) return bad(explainFailure(res));
    return ok(`Inserted ${opts.text.length} character(s) into paragraph ${opts.paragraph} of ${target}.`);
  }

  // ---- deleteText ---------------------------------------------------------
  if (op === "deleteText") {
    if (!opts.paragraph) return bad("ERROR: op=deleteText needs a 1-based `paragraph` index.");
    const charFrom = opts.charFrom ?? 1;
    const charTo = opts.charTo ?? charFrom;
    if (charTo < charFrom) return bad("ERROR: op=deleteText needs charFrom <= charTo.");

    const script = pagesScript(target, [
      `  set idx to ${opts.paragraph}`,
      `  set total to count of paragraphs of body text of doc`,
      `  if idx > total then error "paragraph " & idx & " is past the end (" & total & ")"`,
      `  set t to my paraTextOf(doc, idx)`,
      `  set len to count of characters of t`,
      `  set cf to ${charFrom}`,
      `  set ct to ${charTo}`,
      `  if cf < 1 then set cf to 1`,
      `  if ct > len then set ct to len`,
      `  if cf > ct then error "nothing to delete: paragraph " & idx & " has " & len & " characters"`,
      `  set pre to ""`,
      `  set post to ""`,
      `  if cf > 1 then set pre to text 1 thru (cf - 1) of t`,
      `  if ct < len then set post to text (ct + 1) thru -1 of t`,
      `  set writeMode to my writePara(doc, idx, my splitText(pre & post), false, {}, {}, {})`,
      saveLine,
      `  return (len - (ct - cf + 1)) as text`,
    ]);

    const res = await runAppleScript(script, 220_000);
    if (!res.ok) return bad(explainFailure(res));
    return ok(
      `Deleted characters ${charFrom}-${charTo} of paragraph ${opts.paragraph} in ${target}. ` +
        `Paragraph now has ${res.out.trim()} characters.`,
    );
  }

  // ---- splitParagraph -----------------------------------------------------
  if (op === "splitParagraph") {
    if (!opts.paragraph) return bad("ERROR: op=splitParagraph needs a 1-based `paragraph` index.");
    const at = opts.offset ?? 0;
    if (at < 2) return bad("ERROR: op=splitParagraph needs `offset` >= 2 (the first character of the new paragraph).");

    const script = pagesScript(target, [
      `  set idx to ${opts.paragraph}`,
      `  set total to count of paragraphs of body text of doc`,
      `  if idx > total then error "paragraph " & idx & " is past the end (" & total & ")"`,
      `  set t to my paraTextOf(doc, idx)`,
      `  set len to count of characters of t`,
      `  set insertAt to ${at}`,
      `  if insertAt > len then error "offset " & insertAt & " is past the end of paragraph " & idx & " (" & len & " characters)"`,
      `  set head to text 1 thru (insertAt - 1) of t`,
      `  set tail to text insertAt thru -1 of t`,
      `  set writeMode to my writePara(doc, idx, {head, tail}, false, {}, {}, {})`,
      saveLine,
      `  return (count of paragraphs of body text of doc) as text`,
    ]);

    const res = await runAppleScript(script, 220_000);
    if (!res.ok) return bad(explainFailure(res));
    return ok(
      `Split paragraph ${opts.paragraph} at character ${at} in ${target}. ` +
        `Document now has ${res.out.trim()} paragraphs.`,
    );
  }

  // ---- mergeParagraphs ----------------------------------------------------
  if (op === "mergeParagraphs") {
    const from = opts.from;
    const to = opts.to;
    if (!from || !to) return bad("ERROR: op=mergeParagraphs needs `from` and `to` paragraph indices.");
    if (to <= from) return bad("ERROR: op=mergeParagraphs needs to > from (at least two paragraphs).");
    const separator = opts.separator ?? " ";

    const script = pagesScript(target, [
      `  set sep to ${asLit(separator)}`,
      `  set fromIdx to ${from}`,
      `  set toIdx to ${to}`,
      `  set total to count of paragraphs of body text of doc`,
      `  if toIdx > total then set toIdx to total`,
      `  if toIdx \u2264 fromIdx then error "nothing to merge"`,
      `  set acc to my paraTextOf(doc, fromIdx)`,
      `  repeat with i from (fromIdx + 1) to toIdx`,
      `    set acc to acc & sep & (my paraTextOf(doc, i))`,
      `  end repeat`,
      `  repeat with i from toIdx to (fromIdx + 1) by -1`,
      `    delete paragraph i of body text of doc`,
      `  end repeat`,
      `  set writeMode to my writePara(doc, fromIdx, my splitText(acc), false, {}, {}, {})`,
      saveLine,
      `  return (count of paragraphs of body text of doc) as text`,
    ]);

    const res = await runAppleScript(script, 220_000);
    if (!res.ok) return bad(explainFailure(res));
    return ok(
      `Merged paragraphs ${from}-${to} into one in ${target}. ` +
        `Document now has ${res.out.trim()} paragraphs.`,
    );
  }

  // ---- duplicateParagraph -------------------------------------------------
  if (op === "duplicateParagraph") {
    if (!opts.paragraph) return bad("ERROR: op=duplicateParagraph needs a 1-based `paragraph` index.");
    const position = opts.position ?? "after";

    const script = pagesScript(target, [
      `  set idx to ${opts.paragraph}`,
      `  set total to count of paragraphs of body text of doc`,
      `  if idx > total then error "paragraph " & idx & " is past the end (" & total & ")"`,
      `  set t to my paraTextOf(doc, idx)`,
      `  set sty to my paraStyleOf(doc, idx)`,
      `  my insertLinesAt(doc, idx, {t}, ${position === "before"}, true, {item 1 of sty}, {item 2 of sty}, {item 3 of sty})`,
      saveLine,
      `  return (count of paragraphs of body text of doc) as text`,
    ]);

    const res = await runAppleScript(script, 220_000);
    if (!res.ok) return bad(explainFailure(res));
    return ok(
      `Duplicated paragraph ${opts.paragraph} in ${target}. Document now has ${res.out.trim()} paragraphs.`,
    );
  }

  // ---- moveParagraph ------------------------------------------------------
  if (op === "moveParagraph") {
    const from = opts.from;
    const to = opts.to ?? from;
    if (!from) return bad("ERROR: op=moveParagraph needs `from` (and optionally `to`).");
    if (opts.after === undefined) {
      return bad("ERROR: op=moveParagraph needs `after` - the paragraph to place the block after (0 = top).");
    }

    const script = pagesScript(target, [
      `  set fromIdx to ${from}`,
      `  set toIdx to ${to}`,
      `  set afterIdx to ${opts.after}`,
      `  set total to count of paragraphs of body text of doc`,
      `  if toIdx > total then set toIdx to total`,
      `  if afterIdx \u2265 fromIdx and afterIdx \u2264 toIdx then return "unchanged"`,
      `  set k to toIdx - fromIdx + 1`,
      `  set theT to {}`,
      `  set theF to {}`,
      `  set theS to {}`,
      `  set theC to {}`,
      `  repeat with i from fromIdx to toIdx`,
      `    set end of theT to (my paraTextOf(doc, i))`,
      `    set sty to my paraStyleOf(doc, i)`,
      `    set end of theS to item 1 of sty`,
      `    set end of theF to item 2 of sty`,
      `    set end of theC to item 3 of sty`,
      `  end repeat`,
      `  repeat with i from toIdx to fromIdx by -1`,
      `    delete paragraph i of body text of doc`,
      `  end repeat`,
      // Everything after the removed block slid down by k, so the anchor moves
      // with it. An anchor below the block is unaffected.
      `  if afterIdx \u2265 toIdx then`,
      `    set anchorIdx to afterIdx - k`,
      `  else`,
      `    set anchorIdx to afterIdx`,
      `  end if`,
      `  if anchorIdx < 1 then`,
      `    my insertLinesAt(doc, 1, theT, true, true, theS, theF, theC)`,
      `  else`,
      `    my insertLinesAt(doc, anchorIdx, theT, false, true, theS, theF, theC)`,
      `  end if`,
      saveLine,
      `  return "moved"`,
    ], true);

    const res = await runAppleScript(script, 220_000);
    if (!res.ok) return bad(explainFailure(res));
    if (res.out.trim() === "unchanged") {
      return ok(`Paragraph(s) ${from}-${to} already sit after paragraph ${opts.after} in ${target}; nothing moved.`);
    }
    return ok(`Moved paragraph(s) ${from}-${to} to after paragraph ${opts.after} in ${target}.`);
  }

  // ---- deleteParagraph ----------------------------------------------------
  if (op === "deleteParagraph") {
    const from = opts.from ?? opts.paragraph ?? 1;
    const to = opts.to ?? from;
    if (from < 1 || to < from) return bad("ERROR: deleteParagraph needs 1-based from <= to.");

    // Deleting the real paragraph objects preserves every other paragraph's
    // formatting, instead of rebuilding the body from plain text.
    const script = pagesScript(target, [
      `  set total to count of paragraphs of body text of doc`,
      `  if ${from} > total then error "paragraph ${from} is past the end (" & total & ")"`,
      `  set stopAt to ${to}`,
      `  if stopAt > total then set stopAt to total`,
      `  repeat with i from stopAt to ${from} by -1`,
      `    try`,
      `      delete paragraph i of body text of doc`,
      `    end try`,
      `  end repeat`,
      saveLine,
      `  return (count of paragraphs of body text of doc) as text`,
    ]);

    const res = await runAppleScript(script, 220_000);
    if (!res.ok) return bad(explainFailure(res));
    return ok(`Deleted paragraph(s) ${from}-${to} from ${target}. ${res.out.trim()} paragraph(s) remain.`);
  }

  // ---- replaceParagraph ---------------------------------------------------
  if (op === "replaceParagraph") {
    const from = opts.from ?? opts.paragraph;
    if (!from) return bad("ERROR: op=replaceParagraph needs `from` (and optionally `to`).");
    const to = opts.to ?? from;
    if (to < from) return bad("ERROR: op=replaceParagraph needs to >= from.");

    let texts: string[];
    let styled = false;
    let sizes: number[] = [];
    let fonts: string[] = [];
    let colors: Array<[number, number, number]> = [];

    if (opts.blocks?.length) {
      const prep = renderForEdit(opts.blocks, opts.style, opts.format);
      if ("ok" in prep) return prep;
      texts = prep.rendered.texts;
      styled = prep.styled;
      sizes = prep.rendered.sizes;
      fonts = prep.rendered.fonts;
      colors = prep.rendered.colors;
    } else if (opts.text !== undefined) {
      texts = splitParagraphs(opts.text);
    } else {
      return bad("ERROR: op=replaceParagraph needs `text` or `blocks`.");
    }

    const args = styleArgs(
      texts,
      styled ? texts.map((_, i) => ({ size: sizes[i], font: fonts[i], color: colors[i] })) : null,
    );

    const body: string[] = [
      `  set theSizes to ${args.sizes}`,
      `  set theFonts to ${args.fonts}`,
      `  set theColors to ${args.colors}`,
      `  set total to count of paragraphs of body text of doc`,
      `  if ${from} > total then error "paragraph ${from} is past the end (" & total & ")"`,
      // Drop the extra paragraphs in the range first, then rewrite the first one,
      // so the range's own paragraph object (and its formatting) survives.
      `  set stopAt to ${to}`,
      `  if stopAt > total then set stopAt to total`,
      `  repeat with i from stopAt to ${from + 1} by -1`,
      `    delete paragraph i of body text of doc`,
      `  end repeat`,
      `  set writeMode to my writePara(doc, ${from}, ${linesLit(texts)}, ${args.doStyle}, theSizes, theFonts, theColors)`,
      saveLine,
      `  return writeMode`,
    ];

    const res = await runAppleScript(pagesScript(target, body), 220_000);
    if (!res.ok) return bad(explainFailure(res));
    return ok(
      `Replaced paragraph(s) ${from}-${to} in ${target} with ${texts.length} paragraph(s)` +
        (styled ? ", restyled" : ", keeping the original formatting") +
        (res.out.trim() === "structural" ? " (via paragraph insert/delete)." : "."),
    );
  }

  return bad(`ERROR: unknown op ${op}.`);
}

// --- pages_format: typography and colour -----------------------------------

export type FormatOp = "paragraphs" | "characters" | "matches";

export interface FormatOptions {
  path?: string;
  op?: FormatOp;
  from?: number;
  to?: number;
  paragraph?: number;
  charFrom?: number;
  charTo?: number;
  find?: string;
  all?: boolean;
  bold?: boolean;
  italic?: boolean;
  font?: string;
  size?: number;
  color?: string;
  save?: boolean;
}

export async function pagesFormat(opts: FormatOptions): Promise<Result> {
  const missing = requireApp();
  if (missing) return missing;

  const target = resolveTarget(opts.path);
  if (failed(target)) return target;

  const op: FormatOp = opts.op ?? "paragraphs";
  const saveLine = opts.save === false ? "" : `  save doc`;

  const model = await readDocument(target, MAX_PARAGRAPH_STYLE);
  if (isResult(model)) return model;
  const paras = model.paragraphs;

  const from = opts.from ?? opts.paragraph ?? 1;
  const to = Math.min(opts.to ?? from, paras.length);
  if (from < 1 || to < from) return bad("ERROR: needs a 1-based `from` <= `to` paragraph range.");
  if (from > paras.length) return bad(`ERROR: from=${from} is past the end (${paras.length} paragraphs).`);

  let colorRgb: [number, number, number] | null = null;
  try {
    if (opts.color) colorRgb = hexToApple(opts.color);
  } catch (err) {
    return bad(`ERROR: ${(err as Error).message}`);
  }

  const wantsFace = opts.font !== undefined || opts.bold !== undefined || opts.italic !== undefined;
  if (!wantsFace && !opts.size && !colorRgb) {
    return bad("ERROR: pass at least one of bold, italic, font, size or color.");
  }

  // Per-paragraph faces: bold/italic swap the face inside the paragraph's own
  // family, so a Georgia heading stays Georgia instead of snapping to Helvetica.
  const faces: string[] = [];
  const sizes: number[] = [];
  for (let i = from - 1; i < to; i++) {
    const p = paras[i];
    faces.push(faceFor(p.font, opts));
    sizes.push(opts.size ?? p.size);
  }

  // ---- characters: format a character range inside each paragraph ---------
  if (op === "characters") {
    const charFrom = opts.charFrom ?? 1;
    const charTo = opts.charTo;
    if (!charTo) return bad("ERROR: op=characters needs `charTo` (and optionally `charFrom`).");
    if (charTo < charFrom) return bad("ERROR: op=characters needs charFrom <= charTo.");

    const script = pagesScript(target, [
      `  set theFonts to ${strList(faces)}`,
      `  set theSizes to ${numList(sizes)}`,
      `  set total to count of paragraphs of body text of doc`,
      `  repeat with k from 1 to (count of theFonts)`,
      `    set i to ${from} + k - 1`,
      `    if i \u2264 total then`,
      `      try`,
      `        set p to paragraph i of body text of doc`,
      `        set len to count of characters of (my paraTextOf(doc, i))`,
      `        set cf to ${charFrom}`,
      `        set ct to ${charTo}`,
      `        if ct > len then set ct to len`,
      `        if cf \u2264 ct then`,
      `          set charRange to characters cf thru ct of p`,
      wantsFace ? `          set font of charRange to (item k of theFonts)` : "",
      opts.size ? `          set size of charRange to (item k of theSizes)` : "",
      colorRgb ? `          set color of charRange to {${colorRgb.join(", ")}}` : "",
      `        end if`,
      `      end try`,
      `    end if`,
      `  end repeat`,
      saveLine,
      `  return "ok"`,
    ]);

    const res = await runAppleScript(script, 220_000);
    if (!res.ok) return bad(explainFailure(res));
    return ok(
      `Formatted characters ${charFrom}-${charTo} of paragraph(s) ${from}-${to} in ${target}` +
        ` (${describeFormat(opts)}).`,
    );
  }

  // ---- matches: format every occurrence of a string -----------------------
  if (op === "matches") {
    if (!opts.find) return bad("ERROR: op=matches needs `find`.");
    const face = opts.font ?? faces[0];

    const script = pagesScript(target, [
      `  set needle to ${asLit(opts.find)}`,
      `  set needleLen to count of characters of needle`,
      `  set theFonts to ${strList(faces.map(() => face))}`,
      `  set theSizes to ${numList(sizes)}`,
      `  set total to count of paragraphs of body text of doc`,
      `  set hits to 0`,
      `  repeat with i from ${from} to ${to}`,
      `    if i \u2264 total then`,
      `      try`,
      `        set p to paragraph i of body text of doc`,
      `        set t to my paraTextOf(doc, i)`,
      `        set startAt to 1`,
      `        repeat`,
      `          set off to my offsetOf(t, needle, startAt)`,
      `          if off is 0 then exit repeat`,
      `          set charRange to characters off thru (off + needleLen - 1) of p`,
      wantsFace ? `          set font of charRange to (item i of theFonts)` : "",
      opts.size ? `          set size of charRange to (item i of theSizes)` : "",
      colorRgb ? `          set color of charRange to {${colorRgb.join(", ")}}` : "",
      `          set hits to hits + 1`,
      `          set startAt to off + needleLen`,
      `          if startAt > (count of characters of t) then exit repeat`,
      `        end repeat`,
      `      end try`,
      `    end if`,
      `  end repeat`,
      saveLine,
      `  return hits as text`,
    ], true);

    const res = await runAppleScript(script, 220_000);
    if (!res.ok) return bad(explainFailure(res));
    const hits = Number(res.out.trim()) || 0;
    if (!hits) return bad(`No occurrences of ${JSON.stringify(opts.find)} in paragraphs ${from}-${to} of ${target}.`);
    return ok(
      `Formatted ${hits} occurrence(s) of ${JSON.stringify(opts.find)} in ${target} (${describeFormat(opts)}).`,
    );
  }

  // ---- paragraphs: restyle a paragraph range, text untouched --------------
  // Counts what was actually written, so a document that refuses style writes
  // reports a failure instead of a cheerful "done" over an unchanged file.
  const script = pagesScript(target, [
    `  set theFonts to ${strList(faces.map((f) => (wantsFace ? f : "")))}`,
    `  set theSizes to ${numList(sizes)}`,
    `  set theColors to {${colorRgb ? `{${colorRgb.join(", ")}}` : "missing value"}}`,
    `  set total to count of paragraphs of body text of doc`,
    `  set touched to 0`,
    `  set gone to 0`,
    `  repeat with k from 1 to ${to - from + 1}`,
    `    set i to ${from} + k - 1`,
    `    if i \u2264 total then`,
    `      set r to my applyParaStyle(doc, i, item k of theSizes, item k of theFonts, item 1 of theColors)`,
    `      if r < 0 then`,
    `        set gone to gone + 1`,
    `      else`,
    `        set touched to touched + r`,
    `      end if`,
    `    end if`,
    `  end repeat`,
    saveLine,
    `  return (touched as text) & " " & (gone as text)`,
  ]);

  const res = await runAppleScript(script, 220_000);
  if (!res.ok) return bad(explainFailure(res));
  const [touchedRaw, goneRaw] = res.out.trim().split(/\s+/);
  const touched = Number(touchedRaw) || 0;
  if (!touched) {
    return bad(
      `ERROR: Pages refused every property write on paragraphs ${from}-${to} of ${target} ` +
        `(${goneRaw ?? 0} paragraph object(s) were unreachable). The document is unchanged.`,
    );
  }
  return ok(`Reformatted paragraphs ${from}-${to} in ${target} (${describeFormat(opts)}). Text untouched.`);
}

/** Human-readable summary of a formatting request, for the result message. */
function describeFormat(opts: FormatOptions): string {
  const parts = [
    opts.font ? `font ${opts.font}` : "",
    opts.size ? `${opts.size}pt` : "",
    opts.bold !== undefined ? (opts.bold ? "bold" : "not bold") : "",
    opts.italic !== undefined ? (opts.italic ? "italic" : "not italic") : "",
    opts.color ? `colour ${opts.color}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "no changes";
}

// --- pages_table: values, structure, formatting ----------------------------

export type TableOp =
  | "setCell"
  | "setCells"
  | "format"
  | "insertRows"
  | "deleteRows"
  | "insertColumns"
  | "deleteColumns"
  | "merge"
  | "unmerge"
  | "sort"
  | "clear"
  | "resize";

export interface TableOptions {
  path?: string;
  op: TableOp;
  table?: number;
  row?: number;
  col?: number;
  rows?: number;
  cols?: number;
  value?: string;
  values?: string[][];
  count?: number;
  at?: number;
  by?: number;
  direction?: "ascending" | "descending";
  font?: string;
  size?: number;
  color?: string;
  fill?: string;
  bold?: boolean;
  italic?: boolean;
  align?: Align;
  verticalAlign?: "top" | "center" | "bottom";
  wrap?: boolean;
  headerRows?: number;
  headerCols?: number;
  footerRows?: number;
  columnWidths?: number[];
  rowHeights?: number[];
  save?: boolean;
}

/** Spreadsheet column letter for a 1-based index (1 -> A, 27 -> AA). */
function columnLetter(index: number): string {
  let n = index;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** `B2:C3` style range reference for a rectangle. */
function rangeRef(row: number, col: number, rows: number, cols: number): string {
  const start = `${columnLetter(col)}${row}`;
  const end = `${columnLetter(col + cols - 1)}${row + rows - 1}`;
  return start === end ? start : `${start}:${end}`;
}

export async function pagesTable(opts: TableOptions): Promise<Result> {
  const missing = requireApp();
  if (missing) return missing;

  const target = resolveTarget(opts.path);
  if (failed(target)) return target;

  const tableIndex = opts.table ?? 1;
  const saveLine = opts.save === false ? "" : `  save doc`;
  const op = opts.op;

  const tablePreamble = [
    `  set theTables to tables of doc`,
    `  if (count of theTables) < ${tableIndex} then error "table ${tableIndex} not found"`,
    `  set tbl to item ${tableIndex} of theTables`,
  ];

  // ---- setCell / setCells -------------------------------------------------
  if (op === "setCell" || op === "setCells") {
    const row = opts.row ?? 1;
    const col = opts.col ?? 1;
    if (op === "setCell" && opts.value === undefined && !opts.font && !opts.size && !opts.color && !opts.fill && !opts.align) {
      return bad("ERROR: op=setCell needs at least one of value, font/size/color, bold/italic, fill or align.");
    }
    if (op === "setCells" && !opts.values?.length) return bad("ERROR: op=setCells needs a `values` grid.");

    // Bold/italic are expressed by swapping to the matching face of the cell's
    // current family, so the cell keeps its typeface.
    let face: string | null = opts.font ?? null;
    if (!face && (opts.bold !== undefined || opts.italic !== undefined)) {
      const formats = await readTableFormats(target);
      const current = formats.find((f) => f.table === tableIndex && f.row === row && f.col === col);
      const base = current?.font || FONT_FAMILIES["helvetica-neue"].regular;
      face = faceFor(base, opts);
    }

    let fillRgb: [number, number, number] | null = null;
    let textRgb: [number, number, number] | null = null;
    try {
      if (opts.fill) fillRgb = hexToApple(opts.fill);
      if (opts.color) textRgb = hexToApple(opts.color);
    } catch (err) {
      return bad(`ERROR: ${(err as Error).message}`);
    }

    // Typography is written as final values in a fixed order - face, then size,
    // then colour - because setting a face can reset the size. Fill and
    // alignment are independent of the text run, so they go last.
    const typographyLines = [
      face ? `set font name of cl to ${asLit(face)}` : `set font name of cl to oldFont`,
      `set font size of cl to ${opts.size ?? "oldSize"}`,
      textRgb ? `set text color of cl to {${textRgb.join(", ")}}` : `set text color of cl to oldColor`,
    ];
    const extraLines = [
      fillRgb ? `set background color of cl to {${fillRgb.join(", ")}}` : "",
      opts.align ? `set alignment of cl to ${opts.align}` : "",
    ].filter(Boolean);

    let body: string[];

    if (op === "setCell") {
      body = [
        ...tablePreamble,
        `  set cl to cell ${col} of row ${row} of tbl`,
        // Writing a value resets the run to the table's body style, so capture
        // the cell's own typography first and write it back afterwards.
        `  set oldFont to font name of cl`,
        `  set oldSize to font size of cl`,
        `  set oldColor to text color of cl`,
        opts.value !== undefined ? `  set value of cl to ${asLit(opts.value)}` : "",
        ...typographyLines.map((l) => `  ${l}`),
        ...extraLines.map((l) => `  ${l}`),
        saveLine,
        `  return "ok"`,
      ];
    } else {
      const grid = opts.values!;
      const literal = `{${grid
        .map((r) => `{${r.map((v) => asLit(v)).join(", ")}}`)
        .join(", ")}}`;
      body = [
        ...tablePreamble,
        `  set theGrid to ${literal}`,
        `  set r0 to ${row}`,
        `  set c0 to ${col}`,
        `  set nr to (count of theGrid)`,
        `  repeat with ri from 1 to nr`,
        `    set rowVals to item ri of theGrid`,
        `    set nc to (count of rowVals)`,
        `    repeat with ci from 1 to nc`,
        `      set tr to r0 + ri - 1`,
        `      set tc to c0 + ci - 1`,
        `      if tr \u2264 (row count of tbl) and tc \u2264 (column count of tbl) then`,
        `        try`,
        `          set cl to cell tc of row tr of tbl`,
        `          set oldFont to font name of cl`,
        `          set oldSize to font size of cl`,
        `          set oldColor to text color of cl`,
        `          set value of cl to (item ci of rowVals)`,
        `          set value of cl to (item ci of rowVals)`,
        ...typographyLines.map((l) => `          ${l}`),
        ...extraLines.map((l) => `          ${l}`),
        `        end try`,
        `      end if`,
        `    end repeat`,
        `  end repeat`,
        saveLine,
        `  return "ok"`,
      ];
    }

    const res = await runAppleScript(pagesScript(target, body), 220_000);
    if (!res.ok) return bad(explainFailure(res));

    if (op === "setCells") {
      return ok(
        `Wrote ${opts.values!.reduce((n, r) => n + r.length, 0)} cell value(s) into table ${tableIndex} ` +
          `starting at r${row}c${col} of ${target}.`,
      );
    }
    const touched = [
      opts.value !== undefined ? `value ${JSON.stringify(opts.value)}` : "",
      face ? `face ${face}` : "",
      opts.size ? `${opts.size}pt` : "",
      fillRgb ? `fill ${opts.fill}` : "",
      opts.align ? `align ${opts.align}` : "",
    ].filter(Boolean);
    return ok(`Table ${tableIndex} cell r${row}c${col}: set ${touched.join(", ")} in ${target}.`);
  }

  // ---- insertRows / insertColumns -----------------------------------------
  if (op === "insertRows" || op === "insertColumns") {
    const count = opts.count ?? 1;
    const isRow = op === "insertRows";
    const axis = isRow ? "row" : "column";
    const axisPlural = isRow ? "rows" : "columns";

    const body = [
      ...tablePreamble,
      `  set n to ${axis} count of tbl`,
      `  set k to ${count}`,
      `  set insertAt to ${opts.at ?? 0}`,
      `  if insertAt < 1 then set insertAt to (n + 1)`,
      `  if insertAt > (n + 1) then set insertAt to (n + 1)`,
      `  set ${axis} count of tbl to (n + k)`,
      `  set other to ${isRow ? "column count of tbl" : "row count of tbl"}`,
      // Shift existing values down/right from the insertion point.
      `  repeat with a from n to insertAt by -1`,
      `    repeat with b from 1 to other`,
      isRow
        ? `      set src to cell b of row a of tbl`
        : `      set src to cell a of row b of tbl`,
      `      try`,
      `        set v to value of src`,
      `        if v is not missing value then`,
      isRow
        ? `          set value of cell b of row (a + k) of tbl to v`
        : `          set value of cell (a + k) of row b of tbl to v`,
      `        end if`,
      `      end try`,
      `    end repeat`,
      `  end repeat`,
      // Blank the freshly inserted band.
      `  repeat with a from insertAt to (insertAt + k - 1)`,
      `    repeat with b from 1 to other`,
      isRow
        ? `      try`
        : `      try`,
      isRow
        ? `        set value of cell b of row a of tbl to ""`
        : `        set value of cell a of row b of tbl to ""`,
      `      end try`,
      `    end repeat`,
      `  end repeat`,
      saveLine,
      `  return (${axis} count of tbl) as text`,
    ];

    const res = await runAppleScript(pagesScript(target, body), 240_000);
    if (!res.ok) return bad(explainFailure(res));
    return ok(
      `Inserted ${count} ${axisPlural} at ${axis} ${opts.at ?? "end"} of table ${tableIndex} in ${target}. ` +
        `Table now has ${res.out.trim()} ${axisPlural}.`,
    );
  }

  // ---- deleteRows / deleteColumns -----------------------------------------
  if (op === "deleteRows" || op === "deleteColumns") {
    const count = opts.count ?? 1;
    const isRow = op === "deleteRows";
    const axis = isRow ? "row" : "column";
    const start = (isRow ? opts.row : opts.col) ?? 0;
    if (!start) return bad(`ERROR: op=${op} needs a 1-based \`${axis}\`.`);

    const body = [
      ...tablePreamble,
      `  set n to ${axis} count of tbl`,
      `  set k to ${count}`,
      `  set insertAt to ${start}`,
      `  if insertAt < 1 then set insertAt to 1`,
      `  if insertAt > n then error "${axis} ${start} is past the end (" & n & ")"`,
      `  if (insertAt + k - 1) > n then set k to (n - insertAt + 1)`,
      `  set other to ${isRow ? "column count of tbl" : "row count of tbl"}`,
      // Pull the surviving values up/left before shrinking the table.
      `  repeat with a from insertAt to (n - k)`,
      `    repeat with b from 1 to other`,
      isRow
        ? `      set src to cell b of row (a + k) of tbl`
        : `      set src to cell (a + k) of row b of tbl`,
      `      try`,
      `        set v to value of src`,
      isRow
        ? `        set value of cell b of row a of tbl to v`
        : `        set value of cell a of row b of tbl to v`,
      `      end try`,
      `    end repeat`,
      `  end repeat`,
      `  set ${axis} count of tbl to (n - k)`,
      saveLine,
      `  return (${axis} count of tbl) as text`,
    ];

    const res = await runAppleScript(pagesScript(target, body), 240_000);
    if (!res.ok) return bad(explainFailure(res));
    return ok(
      `Deleted ${count} ${axis}(s) starting at ${axis} ${start} of table ${tableIndex} in ${target}. ` +
        `Table now has ${res.out.trim()} ${axis}(s).`,
    );
  }

  // ---- merge / unmerge / clear -------------------------------------------
  if (op === "merge" || op === "unmerge" || op === "clear") {
    const row = opts.row ?? 1;
    const col = opts.col ?? 1;
    const rows = opts.rows ?? 1;
    const cols = opts.cols ?? 1;
    if (op === "merge" && rows * cols < 2) return bad("ERROR: op=merge needs a rectangle of at least two cells.");

    const ref = rangeRef(row, col, rows, cols);
    const body = [
      ...tablePreamble,
      `  set theRange to range ${asLit(ref)} of tbl`,
      op === "merge"
        ? `  merge theRange`
        : op === "unmerge"
          ? `  unmerge theRange`
          : `  clear theRange`,
      saveLine,
      `  return "ok"`,
    ];

    const res = await runAppleScript(pagesScript(target, body), 220_000);
    if (!res.ok) return bad(explainFailure(res));
    const verb = op === "merge" ? "Merged" : op === "unmerge" ? "Unmerged" : "Cleared";
    return ok(`${verb} ${ref} in table ${tableIndex} of ${target}.`);
  }

  // ---- sort ---------------------------------------------------------------
  if (op === "sort") {
    if (!opts.by) return bad("ERROR: op=sort needs a 1-based `by` column.");
    const direction = opts.direction ?? "ascending";

    const body = [
      ...tablePreamble,
      `  sort tbl by (column ${opts.by} of tbl) direction ${direction}`,
      saveLine,
      `  return "ok"`,
    ];

    const res = await runAppleScript(pagesScript(target, body), 220_000);
    if (!res.ok) return bad(explainFailure(res));
    return ok(`Sorted table ${tableIndex} of ${target} by column ${opts.by}, ${direction}.`);
  }

  // ---- resize -------------------------------------------------------------
  if (op === "resize") {
    if (!opts.rows && !opts.cols) return bad("ERROR: op=resize needs `rows` and/or `cols`.");
    const body = [
      ...tablePreamble,
      opts.rows ? `  set row count of tbl to ${opts.rows}` : "",
      opts.cols ? `  set column count of tbl to ${opts.cols}` : "",
      saveLine,
      `  return ((row count of tbl) as text) & "x" & ((column count of tbl) as text)`,
    ];

    const res = await runAppleScript(pagesScript(target, body), 220_000);
    if (!res.ok) return bad(explainFailure(res));
    return ok(`Resized table ${tableIndex} of ${target} to ${res.out.trim()}.`);
  }

  // ---- format -------------------------------------------------------------
  if (op === "format") {
    let fillRgb: [number, number, number] | null = null;
    let textRgb: [number, number, number] | null = null;
    try {
      if (opts.fill) fillRgb = hexToApple(opts.fill);
      if (opts.color) textRgb = hexToApple(opts.color);
    } catch (err) {
      return bad(`ERROR: ${(err as Error).message}`);
    }

    let face: string | null = opts.font ?? null;
    if (!face && (opts.bold !== undefined || opts.italic !== undefined)) {
      const formats = await readTableFormats(target);
      const current = formats.find((f) => f.table === tableIndex);
      face = faceFor(current?.font || FONT_FAMILIES["helvetica-neue"].regular, opts);
    }

    const row = opts.row ?? 1;
    const col = opts.col ?? 1;
    const rows = opts.rows ?? 0;
    const cols = opts.cols ?? 0;

    const body: string[] = [...tablePreamble];
    if (opts.headerRows !== undefined) body.push(`  set header row count of tbl to ${opts.headerRows}`);
    if (opts.headerCols !== undefined) body.push(`  set header column count of tbl to ${opts.headerCols}`);
    if (opts.footerRows !== undefined) body.push(`  set footer row count of tbl to ${opts.footerRows}`);

    const propLines = [
      face ? `set font name of cl to ${asLit(face)}` : "",
      opts.size ? `set font size of cl to ${opts.size}` : "",
      textRgb ? `set text color of cl to {${textRgb.join(", ")}}` : "",
      fillRgb ? `set background color of cl to {${fillRgb.join(", ")}}` : "",
      opts.align ? `set alignment of cl to ${opts.align}` : "",
      opts.verticalAlign ? `set vertical alignment of cl to ${opts.verticalAlign}` : "",
      opts.wrap !== undefined ? `set text wrap of cl to ${opts.wrap}` : "",
    ].filter(Boolean);

    if (propLines.length) {
      // rows/cols of 0 means "the whole table".
      body.push(
        `  set r0 to ${row}`,
        `  set c0 to ${col}`,
        `  set r1 to ${rows ? row + rows - 1 : 0}`,
        `  set c1 to ${cols ? col + cols - 1 : 0}`,
        `  if r1 < 1 or r1 > (row count of tbl) then set r1 to (row count of tbl)`,
        `  if c1 < 1 or c1 > (column count of tbl) then set c1 to (column count of tbl)`,
        `  repeat with ri from r0 to r1`,
        `    repeat with ci from c0 to c1`,
        `      try`,
        `        set cl to cell ci of row ri of tbl`,
        ...propLines.map((l) => `        ${l}`),
        `      end try`,
        `    end repeat`,
        `  end repeat`,
      );
    }

    (opts.columnWidths ?? []).forEach((w, i) => {
      if (!w) return;
      body.push(`  if (column count of tbl) \u2265 ${i + 1} then set width of column ${i + 1} of tbl to ${Math.round(w)}`);
    });
    (opts.rowHeights ?? []).forEach((h, i) => {
      if (!h) return;
      body.push(`  if (row count of tbl) \u2265 ${i + 1} then set height of row ${i + 1} of tbl to ${Math.round(h)}`);
    });

    if (body.length === tablePreamble.length) {
      return bad(
        "ERROR: op=format needs at least one of font, size, color, fill, align, verticalAlign, wrap, " +
          "headerRows, headerCols, footerRows, columnWidths or rowHeights.",
      );
    }

    body.push(saveLine, `  return "ok"`);

    const res = await runAppleScript(pagesScript(target, body), 240_000);
    if (!res.ok) return bad(explainFailure(res));
    return ok(`Reformatted table ${tableIndex} of ${target}.`);
  }

  return bad(`ERROR: unknown op ${op}.`);
}

// --- pages_verify ----------------------------------------------------------

export interface VerifyOptions {
  path?: string;
  maxParagraphs?: number;
  expectParagraphs?: number;
  expectTables?: number;
  maxIssues?: number;
}

/**
 * Full-document integrity check. This is the "did the 20-page document survive?"
 * tool: it reads everything, then reports structural problems, typography drift
 * and anything that looks like a truncated or half-applied edit.
 */
export async function pagesVerify(opts: VerifyOptions = {}): Promise<Result> {
  const missing = requireApp();
  if (missing) return missing;

  const target = opts.path ? path.resolve(opts.path.replace(/^~(?=\/|$)/, os.homedir())) : null;
  if (target && !fs.existsSync(target)) return bad(`ERROR: no such file: ${target}`);

  const scanCap = Math.min(Math.max(opts.maxParagraphs ?? 5000, 1), 5000);
  const model = await readDocument(target, scanCap);
  if (isResult(model)) return model;

  const paras = model.paragraphs;
  const issues: string[] = [];
  const warnings: string[] = [];
  const maxIssues = Math.min(Math.max(opts.maxIssues ?? 20, 1), 200);

  // ---- coverage -----------------------------------------------------------
  if (model.total > paras.length) {
    warnings.push(
      `only the first ${paras.length} of ${model.total} paragraphs were scanned - raise maxParagraphs for a full check`,
    );
  }
  if (!paras.length) issues.push("document has no paragraphs at all");

  // ---- text ---------------------------------------------------------------
  const text = paras.map((p) => p.text);
  const words = text.join("\n").split(/\s+/).filter(Boolean).length;
  const chars = text.reduce((n, t) => n + t.length, 0);
  const emptyIdx = paras.map((p, i) => (p.text.trim() ? -1 : i + 1)).filter((i) => i > 0);
  const emptyRatio = paras.length ? emptyIdx.length / paras.length : 0;

  if (emptyRatio > 0.4 && paras.length > 10) {
    warnings.push(
      `${emptyIdx.length} of ${paras.length} paragraphs are empty (${Math.round(emptyRatio * 100)}%) - ` +
        `check for duplicated blank lines`,
    );
  }

  // Runs of two or more empty paragraphs are usually a layout accident.
  const runs: string[] = [];
  let runStart = -1;
  for (let i = 0; i < paras.length; i++) {
    const isEmpty = !paras[i].text.trim();
    if (isEmpty && runStart < 0) runStart = i + 1;
    if (!isEmpty && runStart > 0) {
      if (i + 1 - runStart >= 2) runs.push(`${runStart}-${i}`);
      runStart = -1;
    }
  }
  if (runStart > 0 && paras.length + 1 - runStart >= 2) runs.push(`${runStart}-${paras.length}`);
  if (runs.length) {
    warnings.push(`${runs.length} run(s) of consecutive empty paragraphs: ${runs.slice(0, 5).join(", ")}`);
  }

  // ---- typography ---------------------------------------------------------
  // Blank spacer paragraphs report no typography at all. They are counted
  // separately rather than being allowed to invent a "0pt" style or trip the
  // "no font" check.
  const blank = paras.filter((p) => !p.text.trim());
  const styled = paras.filter((p) => p.text.trim() && p.size > 0 && !!p.font);

  const bodySize = (() => {
    const counts = new Map<number, number>();
    for (const p of styled) {
      counts.set(p.size, (counts.get(p.size) ?? 0) + 1);
    }
    let best = 0;
    let bestCount = -1;
    for (const [size, count] of counts) {
      if (count > bestCount) {
        best = size;
        bestCount = count;
      }
    }
    return best;
  })();

  const inventory = new Map<string, number>();
  for (const p of styled) {
    const key = `${p.size}pt  ${p.font}`;
    inventory.set(key, (inventory.get(key) ?? 0) + 1);
  }
  const topStyles = [...inventory.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  const badSizes = styled.filter((p) => p.size < 4 || p.size > 300);
  if (badSizes.length) {
    warnings.push(`${badSizes.length} paragraph(s) with an implausible point size (${badSizes[0].size}pt first)`);
  }
  // Only a paragraph with real text and no readable font is a problem.
  const noFont = paras.filter((p) => p.text.trim() && !p.font.trim());
  if (noFont.length) issues.push(`${noFont.length} paragraph(s) report no font at all`);
  const unstyled = paras.filter((p) => p.text.trim() && !p.size);
  if (unstyled.length) {
    warnings.push(`${unstyled.length} paragraph(s) report no point size - style read was refused for them`);
  }

  // ---- tables -------------------------------------------------------------
  let totalCells = 0;
  let expectedCells = 0;
  for (const table of model.tables) {
    const label = `table ${table.index}`;
    totalCells += table.grid.reduce((n, row) => n + row.length, 0);
    expectedCells += table.rows * table.cols;

    if (table.rows < 1 || table.cols < 1) {
      issues.push(`${label} has ${table.rows} row(s) x ${table.cols} column(s)`);
      continue;
    }
    if (table.headerRows > table.rows) {
      issues.push(`${label} claims ${table.headerRows} header rows but only has ${table.rows}`);
    }
    const widths = new Set(table.grid.map((r) => r.length));
    if (widths.size > 1) {
      warnings.push(`${label} has ragged rows (widths ${[...widths].join("/")}) - possible merged cells`);
    }
    const filled = table.grid.reduce((n, row) => n + row.filter((v) => v && v.trim()).length, 0);
    if (filled === 0) warnings.push(`${label} is completely empty`);
  }
  const unaddressed = expectedCells - totalCells;
  if (unaddressed > 0) {
    warnings.push(
      `${unaddressed} cell(s) could not be addressed directly (merged cells report only their anchor cell)`,
    );
  }

  // ---- expectations -------------------------------------------------------
  if (opts.expectParagraphs !== undefined && opts.expectParagraphs !== model.total) {
    issues.push(`expected ${opts.expectParagraphs} paragraphs, found ${model.total}`);
  }
  if (opts.expectTables !== undefined && opts.expectTables !== model.tables.length) {
    issues.push(`expected ${opts.expectTables} table(s), found ${model.tables.length}`);
  }

  // ---- report -------------------------------------------------------------
  const lines: string[] = [];
  lines.push(`${model.name || "(unnamed)"}`);
  lines.push(`path: ${model.filePath || target || "(unsaved)"}`);
  lines.push("");
  lines.push(
    `paragraphs: ${model.total}${model.total > paras.length ? ` (scanned ${paras.length})` : ""}   ` +
      `words: ${words}   characters: ${chars}`,
  );
  lines.push(`tables: ${model.tables.length}   cells read: ${totalCells}`);
  if (blank.length) lines.push(`blank paragraphs: ${blank.length} (no typography reported)`);
  if (bodySize) lines.push(`dominant body size: ${bodySize}pt`);

  if (topStyles.length) {
    lines.push("", "typography in use:");
    for (const [key, count] of topStyles) {
      lines.push(`  ${key.padEnd(32)} ${String(count).padStart(5)} paragraph(s)`);
    }
  }

  if (warnings.length) {
    lines.push("", `warnings (${warnings.length}):`);
    for (const w of warnings.slice(0, maxIssues)) lines.push(`  - ${w}`);
    if (warnings.length > maxIssues) lines.push(`  ... ${warnings.length - maxIssues} more`);
  }
  if (issues.length) {
    lines.push("", `problems (${issues.length}):`);
    for (const i of issues.slice(0, maxIssues)) lines.push(`  - ${i}`);
    if (issues.length > maxIssues) lines.push(`  ... ${issues.length - maxIssues} more`);
  }

  lines.push("");
  lines.push(
    issues.length
      ? `verdict: ${issues.length} problem(s), ${warnings.length} warning(s)`
      : warnings.length
        ? `verdict: structurally sound, ${warnings.length} warning(s)`
        : "verdict: clean",
  );

  return ok(lines.join("\n"));
}

// --- pages_export ----------------------------------------------------------

const EXPORT_FORMATS: Record<string, { as: string; ext: string }> = {
  pdf: { as: "PDF", ext: "pdf" },
  txt: { as: "unformatted text", ext: "txt" },
  rtf: { as: "formatted text", ext: "rtf" },
  epub: { as: "EPUB", ext: "epub" },
  // Pages' own Word writer - no Word installation involved.
  docx: { as: "Microsoft Word", ext: "docx" },
};

export interface ExportOptions {
  path: string;
  format: string;
  destPath?: string;
  overwrite?: boolean;
}

export async function pagesExport(opts: ExportOptions): Promise<Result> {
  const missing = requireApp();
  if (missing) return missing;

  const src = path.resolve(opts.path.replace(/^~(?=\/|$)/, os.homedir()));
  if (!fs.existsSync(src)) return bad(`ERROR: no such file: ${src}`);

  const key = opts.format.toLowerCase().replace(/^\./, "");
  const format = EXPORT_FORMATS[key];
  if (!format) {
    return bad(`ERROR: unsupported format ${opts.format}. Use one of: ${Object.keys(EXPORT_FORMATS).join(", ")}.`);
  }

  const dest = opts.destPath
    ? path.resolve(opts.destPath.replace(/^~(?=\/|$)/, os.homedir()))
    : src.replace(/\.pages$/i, `.${format.ext}`);
  if (fs.existsSync(dest) && !opts.overwrite) {
    return bad(`ERROR: ${dest} already exists. Pass overwrite=true to replace it.`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });

  const script = [
    `with timeout of 180 seconds`,
    `  tell application id "${PAGES_BUNDLE_ID}"`,
    `  ${bindDocument(src)}`,
    `  export doc to file (POSIX file ${asLit(dest)}) as ${format.as}`,
    `  return "ok"`,
    `  end tell`,
    `end timeout`,
  ].join("\n");

  const res = await runAppleScript(script, 200_000);
  if (!res.ok) return bad(explainFailure(res));

  let size = "";
  try {
    size = ` (${(fs.statSync(dest).size / 1024).toFixed(0)} KiB)`;
  } catch {
    /* export may still be flushing */
  }
  return ok(`Exported ${src} -> ${dest}${size}`);
}
