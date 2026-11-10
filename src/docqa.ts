// Rendered-page checks for exported documents.
//
// The document model says a paragraph exists. The exported page says whether it
// fits. This module reads the PDF that Pages, Numbers or Keynote produced, page by
// page, and reports the failures that only show up after layout: blank pages,
// text pushed outside the page, text crushed against the bottom edge, and pages
// whose rendering changed between two versions.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appHome } from "./config.js";
import { failed, good, jxa, truncate, type Outcome } from "./exec.js";

export interface PageReport {
  page: number;
  chars: number;
  snippet: string;
  empty: boolean;
  clipped: boolean;
  crowded: boolean;
  width: number;
  height: number;
  textBounds?: { x: number; y: number; width: number; height: number };
  /** Text boxes that sit on top of another line. Overlapping text is what a
   *  dropped-in text box over a paragraph, or a table cell that spilled, looks
   *  like on the rendered page. */
  overlaps?: number;
  overlapSamples?: string[];
  image?: string;
  hash?: string;
}

export interface TextLine {
  x: number;
  y: number;
  width: number;
  height: number;
  chars: number;
}

/** Two text boxes on different baselines intersect in both axes: text has been
 *  stacked on text. A superscript, an italic overhang or a table rule touching a
 *  glyph only grazes an edge, so a real overlap has to be a few points deep in
 *  both directions and cover a few square points. */
export function findOverlaps(lines: TextLine[], minDepth = 2, minArea = 24): Array<{ a: number; b: number; area: number }> {
  const found: Array<{ a: number; b: number; area: number }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const one = lines[i];
    for (let j = i + 1; j < lines.length; j += 1) {
      const two = lines[j];
      const width = Math.min(one.x + one.width, two.x + two.width) - Math.max(one.x, two.x);
      if (width <= minDepth) continue;
      const height = Math.min(one.y + one.height, two.y + two.height) - Math.max(one.y, two.y);
      if (height <= minDepth) continue;
      const area = width * height;
      if (area >= minArea) found.push({ a: i, b: j, area: Math.round(area) });
    }
  }
  return found;
}

export interface PdfReport {
  file: string;
  pages: number;
  pageSize?: { width: number; height: number };
  totals: { chars: number; empty: number; clipped: number; crowded: number; overlapping: number };
  problems: string[];
  warnings: string[];
  detail: PageReport[];
  rendered?: string;
}

const PDF_BODY = `
ObjC.import('PDFKit');
ObjC.import('Foundation');
var ARGS = __ARGS__;
var doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(ARGS.path));
if (!doc) { JSON.stringify({ error: 'could not open PDF: ' + ARGS.path }); } else {
  var count = doc.pageCount;
  var out = [];
  var rendered = ARGS.renderDir || '';
  for (var i = 0; i < count; i++) {
    var page = doc.pageAtIndex(i);
    var box = page.boundsForBox(0);
    // PDFKit returns NSString. In JXA that bridges to an object whose String() is
    // "[id __NSCFString]", so it has to be unwrapped or every page reads as empty.
    var rawText = page.string;
    var text = rawText ? String(ObjC.unwrap(rawText)) : '';
    // Character boxes are reliable. selectionForRect plus boundsForPage can report
    // a union far outside the page for ordinary text, which would read as a false
    // clipping report on a perfectly good document.
    var limit = Math.min(text.length, 20000);
    var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, boxed = false;
    for (var ci = 0; ci < limit; ci++) {
      var code = text.charCodeAt(ci);
      if (code === 10 || code === 13 || code === 32 || code === 9) continue;
      var cb = page.characterBoundsAtIndex(ci);
      if (!cb) continue;
      var cw = cb.size.width, chh = cb.size.height;
      if (!cw && !chh) continue;
      boxed = true;
      if (cb.origin.x < minX) minX = cb.origin.x;
      if (cb.origin.x + cw > maxX) maxX = cb.origin.x + cw;
      if (cb.origin.y < minY) minY = cb.origin.y;
      if (cb.origin.y + chh > maxY) maxY = cb.origin.y + chh;
    }
    var b = boxed ? { origin: { x: minX, y: minY }, size: { width: maxX - minX, height: maxY - minY } } : null;
    // Group characters into lines by baseline so a later pass can tell whether two
    // blocks of text sit on top of each other.
    var lines = [];
    var byRow = {};
    var lineCap = 250;
    for (var li = 0; li < limit && lines.length < lineCap; li++) {
      var lcode = text.charCodeAt(li);
      if (lcode === 10 || lcode === 13 || lcode === 32 || lcode === 9) continue;
      var lb = page.characterBoundsAtIndex(li);
      if (!lb) continue;
      var lw = lb.size.width, lh = lb.size.height;
      if (!lw && !lh) continue;
      var rowKey = String(Math.round(lb.origin.y / 3));
      var row = byRow[rowKey];
      if (!row) {
        row = { x: lb.origin.x, y: lb.origin.y, x2: lb.origin.x + lw, y2: lb.origin.y + lh, chars: 0 };
        byRow[rowKey] = row;
        lines.push(row);
      }
      if (lb.origin.x < row.x) row.x = lb.origin.x;
      if (lb.origin.x + lw > row.x2) row.x2 = lb.origin.x + lw;
      if (lb.origin.y < row.y) row.y = lb.origin.y;
      if (lb.origin.y + lh > row.y2) row.y2 = lb.origin.y + lh;
      row.chars++;
    }
    var entry = {
      page: i + 1,
      chars: text.length,
      snippet: text.replace(/\\s+/g, ' ').slice(0, 160),
      width: Math.round(box.size.width * 10) / 10,
      height: Math.round(box.size.height * 10) / 10
    };
    entry.lines = lines.map(function (row) {
      return {
        x: Math.round(row.x * 10) / 10,
        y: Math.round(row.y * 10) / 10,
        width: Math.round((row.x2 - row.x) * 10) / 10,
        height: Math.round((row.y2 - row.y) * 10) / 10,
        chars: row.chars
      };
    });
    if (b && b.size.width > 0) {
      entry.textBounds = {
        x: Math.round(b.origin.x * 10) / 10,
        y: Math.round(b.origin.y * 10) / 10,
        width: Math.round(b.size.width * 10) / 10,
        height: Math.round(b.size.height * 10) / 10
      };
    }
    if (rendered) {
      var data = page.dataRepresentation;
      if (data) {
        var target = rendered + '/page-' + (i + 1) + '.pdf';
        data.writeToFileAtomically(target, true);
        entry.image = target;
      }
    }
    out.push(entry);
  }
  JSON.stringify({ pages: out, pageCount: count });
}
`;

function resolveDocPath(file: string): string {
  return file.replace(/^~(?=\/|$)/, os.homedir());
}

/** A coarse fingerprint of one rendered page: downscale first so antialiasing
 *  noise does not register as a change, then hash. */
function hashFile(file: string, size = 120): string | undefined {
  const small = `${file}.qa.png`;
  let source = file;
  try {
    execFileSync("/usr/bin/sips", ["-Z", String(size), file, "--out", small], { timeout: 20_000, stdio: "ignore" });
    if (fs.existsSync(small)) source = small;
  } catch {
    // Fall back to hashing the page PDF itself.
  }
  try {
    return createHash("sha1").update(fs.readFileSync(source)).digest("hex").slice(0, 12);
  } catch {
    return undefined;
  }
}

export interface QaOptions {
  file: string;
  render?: boolean;
  firstPage?: number;
  lastPage?: number;
  maxProblems?: number;
}

/** Page by page report of what the rendered document actually looks like. */
export async function qaPdf(options: QaOptions): Promise<PdfReport> {
  const file = resolveDocPath(options.file);
  const renderDir = options.render ? fs.mkdtempSync(path.join(os.tmpdir(), "lap-qa-")) : "";
  const script = PDF_BODY.replace("__ARGS__", JSON.stringify({ path: file, renderDir }));
  const res = await jxa(script, 120_000);
  const raw = res.out.trim().split("\n").pop() ?? "";
  type Payload = {
    error?: string;
    pageCount?: number;
    pages?: Array<{
      page: number;
      chars: number;
      snippet: string;
      width: number;
      height: number;
      textBounds?: { x: number; y: number; width: number; height: number };
      lines?: TextLine[];
      image?: string;
    }>;
  };
  let payload: Payload = {};
  try {
    payload = JSON.parse(raw) as Payload;
  } catch {
    throw new Error(`Could not read ${file} as a PDF: ${truncate(raw || res.err, 300)}`);
  }
  if (payload.error) throw new Error(payload.error);
  const pages = payload.pages ?? [];
  const first = Math.max(1, options.firstPage ?? 1);
  const last = Math.min(pages.length, options.lastPage ?? pages.length);

  const detail: PageReport[] = [];
  const problems: string[] = [];
  const warnings: string[] = [];
  const maxProblems = options.maxProblems ?? 25;

  for (const page of pages) {
    if (page.page < first || page.page > last) continue;
    const tolerance = 1.5;
    const bounds = page.textBounds;
    const clipped = Boolean(
      bounds &&
        (bounds.x < -tolerance ||
          bounds.y < -tolerance ||
          bounds.x + bounds.width > page.width + tolerance ||
          bounds.y + bounds.height > page.height + tolerance),
    );
    const crowded = Boolean(bounds && bounds.y < 14 && page.chars > 120);
    const empty = page.chars < 40;
    const found = findOverlaps(page.lines ?? []).sort((a, b) => b.area - a.area);
    const overlapSamples = found.slice(0, 4).map((hit) => {
      const one = (page.lines ?? [])[hit.a];
      const two = (page.lines ?? [])[hit.b];
      const size = (line?: TextLine) => (line ? `${Math.round(line.width)}x${Math.round(line.height)} at ${Math.round(line.x)},${Math.round(line.y)}` : "?");
      return `${size(one)} and ${size(two)} overlap by ${hit.area} square points`;
    });
    const report: PageReport = {
      page: page.page,
      chars: page.chars,
      snippet: page.snippet,
      empty,
      clipped,
      crowded,
      width: page.width,
      height: page.height,
      textBounds: bounds,
      overlaps: found.length,
      overlapSamples: found.length ? overlapSamples : undefined,
      image: page.image,
    };
    if (page.image) report.hash = hashFile(page.image);
    detail.push(report);

    if (empty && problems.length < maxProblems) {
      problems.push(`page ${page.page} is essentially empty (${page.chars} characters)`);
    }
    if (clipped && problems.length < maxProblems) {
      problems.push(
        `page ${page.page} has text outside the page box (text ${Math.round(bounds?.width ?? 0)}x${Math.round(bounds?.height ?? 0)} at ${Math.round(bounds?.x ?? 0)},${Math.round(bounds?.y ?? 0)} in ${Math.round(page.width)}x${Math.round(page.height)})`,
      );
    }
    if (crowded && problems.length < maxProblems) {
      problems.push(`page ${page.page} pushes text to the bottom edge, which usually means a clipped last line or an overflowing table`);
    }
    if (found.length && problems.length < maxProblems) {
      problems.push(`page ${page.page} has ${found.length} pair(s) of overlapping text boxes, first ${overlapSamples[0]}`);
    }
  }

  if (!pages.length) warnings.push("the PDF has no pages");
  const rendered = options.render ? renderDir : undefined;
  return {
    file,
    pages: pages.length,
    pageSize: pages[0] ? { width: pages[0].width, height: pages[0].height } : undefined,
    totals: {
      chars: pages.reduce((sum, page) => sum + page.chars, 0),
      empty: detail.filter((page) => page.empty).length,
      clipped: detail.filter((page) => page.clipped).length,
      crowded: detail.filter((page) => page.crowded).length,
      overlapping: detail.filter((page) => (page.overlaps ?? 0) > 0).length,
    },
    problems,
    warnings,
    detail,
    rendered,
  };
}

export interface CompareResult {
  sameShape: boolean;
  pageDelta: number;
  changedPages: Array<{ page: number; textChanged: boolean; visualChanged: boolean }>;
  notes: string[];
}

/** Page by page comparison of two exports. Text change and visual change are
 *  reported separately, because a reflow can move a page without changing a word. */
export async function comparePdf(beforeFile: string, afterFile: string): Promise<CompareResult> {
  const [before, after] = await Promise.all([
    qaPdf({ file: beforeFile, render: true }),
    qaPdf({ file: afterFile, render: true }),
  ]);
  const notes: string[] = [];
  const changedPages: CompareResult["changedPages"] = [];
  const count = Math.max(before.detail.length, after.detail.length);
  for (let i = 0; i < count; i += 1) {
    const a = before.detail[i];
    const b = after.detail[i];
    if (!a || !b) {
      changedPages.push({ page: i + 1, textChanged: true, visualChanged: true });
      continue;
    }
    const textChanged = a.snippet !== b.snippet || a.chars !== b.chars;
    const visualChanged = Boolean(a.hash && b.hash && a.hash !== b.hash);
    if (textChanged || visualChanged) changedPages.push({ page: i + 1, textChanged, visualChanged });
  }
  if (before.pages !== after.pages) notes.push(`page count went from ${before.pages} to ${after.pages}`);
  if (after.problems.length > before.problems.length) {
    notes.push(`new page problems: ${after.problems.length - before.problems.length}`);
  }
  return {
    sameShape: before.pages === after.pages && before.pageSize?.width === after.pageSize?.width,
    pageDelta: after.pages - before.pages,
    changedPages,
    notes,
  };
}

// --- backups and rollback ---------------------------------------------------

export function backupRoot(): string {
  return path.join(appHome(), "backups");
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export interface BackupEntry {
  label: string;
  file: string;
  createdAt: string;
  size: number;
}

/** Copy the document next to the app's own state before an edit run. Rollback is
 *  a file copy, not an undo in the editor, so it works when the app is closed. */
export function backupDocument(file: string, label?: string): BackupEntry {
  const source = resolveDocPath(file);
  if (!fs.existsSync(source)) throw new Error(`No such file: ${source}`);
  const folder = path.join(backupRoot(), path.basename(source).replace(/\s+/g, "-"));
  fs.mkdirSync(folder, { recursive: true });
  const clean = (label ?? "manual").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 40) || "manual";
  const target = path.join(folder, `${stamp()}-${clean}${path.extname(source)}`);
  fs.copyFileSync(source, target);
  const stats = fs.statSync(target);
  return { label: clean, file: target, createdAt: stats.mtime.toISOString(), size: stats.size };
}

export function listBackups(file: string, limit = 100): BackupEntry[] {
  const source = resolveDocPath(file);
  const folder = path.join(backupRoot(), path.basename(source).replace(/\s+/g, "-"));
  const keep = Math.max(1, Math.min(limit, 5000));
  let dir: fs.Dir;
  try {
    dir = fs.opendirSync(folder);
  } catch {
    return [];
  }
  const out: BackupEntry[] = [];
  try {
    for (;;) {
      const entry = dir.readSync();
      if (!entry) break;
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      const full = path.join(folder, entry.name);
      try {
        const stats = fs.statSync(full);
        out.push({ label: entry.name, file: full, createdAt: stats.mtime.toISOString(), size: stats.size });
        out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        if (out.length > keep) out.length = keep;
      } catch {
        /* backup disappeared while listing */
      }
    }
  } finally {
    try { dir.closeSync(); } catch { /* already closed */ }
  }
  return out;
}

export function restoreBackup(file: string, backupFile?: string): Outcome {
  const source = resolveDocPath(file);
  const folder = path.join(backupRoot(), path.basename(source).replace(/\s+/g, "-"));
  let pick: BackupEntry | undefined;
  if (backupFile) {
    const direct = path.isAbsolute(backupFile) ? backupFile : path.join(folder, path.basename(backupFile));
    try {
      const stats = fs.statSync(direct);
      if (stats.isFile() && path.dirname(path.resolve(direct)) === path.resolve(folder)) {
        pick = { label: path.basename(direct), file: direct, createdAt: stats.mtime.toISOString(), size: stats.size };
      }
    } catch {
      /* report a useful recent list below */
    }
  } else {
    pick = listBackups(source, 1)[0];
  }
  if (!pick) {
    const recent = listBackups(source, 5);
    if (!recent.length) return failed(`No backups saved for ${path.basename(source)}. doc_backup creates one.`);
    return failed(`No backup labelled ${backupFile}. Available: ${recent.map((entry) => entry.label).join(", ")}`);
  }
  // Keep what is there now, so a restore can itself be undone.
  const safety = `${source}.before-restore-${stamp()}`;
  try {
    if (fs.existsSync(source)) fs.copyFileSync(source, safety);
    fs.copyFileSync(pick.file, source);
  } catch (error) {
    return failed(`Restore failed: ${(error as Error).message}`);
  }
  return good(`Restored ${path.basename(source)} from ${pick.label}. The previous version is at ${safety}.`);
}

export async function pdfPageCount(file: string): Promise<number> {
  const report = await qaPdf({ file });
  return report.pages;
}
