// High-level Pages Creator Studio inspector controls built on semantic AX labels.
// No screen coordinates are used; all mutations resolve an exact inspector control first.
import { failed, good, type Outcome } from "./exec.js";
import {
  ensureInspectorSegment,
  semanticChoose,
  semanticPress,
  semanticReadMany,
  semanticSet,
  semanticToggle,
} from "./iwork-ui.js";

export interface PagesTextLayoutOptions {
  action: "get" | "set";
  windowTitle?: string;
  dryRun?: boolean;
  font?: string;
  typeface?: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  align?: "left" | "center" | "right" | "justify";
  beforeParagraph?: string;
  afterParagraph?: string;
  lineSpacing?: string;
}

async function prepPagesFormat(windowTitle?: string, dryRun = false): Promise<Outcome> {
  const outer = await ensureInspectorSegment("pages", "Format", windowTitle, dryRun);
  if (!outer.ok) return outer;
  if (dryRun) return outer;
  return ensureInspectorSegment("pages", "Style", windowTitle, false);
}

export async function pagesTextLayout(opts: PagesTextLayoutOptions): Promise<Outcome> {
  const prep = await prepPagesFormat(opts.windowTitle, opts.dryRun === true);
  if (!prep.ok) return prep;
  if (opts.dryRun) return good("Pages Format > Text > Style inspector is resolvable; no change made.");

  if (opts.action === "get") {
    return semanticReadMany("pages", [
      { name: "font", target: { role: "AXPopUpButton", description: "Choose the font family." } },
      { name: "typeface", target: { role: "AXPopUpButton", description: "Choose the typeface." } },
      { name: "size", target: { role: "AXTextField", description: "Set the font size." } },
      { name: "bold", target: { role: "AXCheckBox", description: "bold" } },
      { name: "italic", target: { role: "AXCheckBox", description: "italic" } },
      { name: "underline", target: { role: "AXCheckBox", description: "underline" } },
      { name: "strikethrough", target: { role: "AXCheckBox", description: "strikethrough" } },
      { name: "before paragraph", target: { role: "AXTextField", description: "Set the amount of space before a paragraph." } },
      { name: "after paragraph", target: { role: "AXTextField", description: "Set the amount of space after a paragraph." } },
      { name: "line spacing", target: { role: "AXTextField", description: "Set the amount of space between lines of text." } },
    ], { windowTitle: opts.windowTitle });
  }

  const results: string[] = [];
  const run = async (r: Promise<Outcome>) => {
    const v = await r;
    if (!v.ok) return v;
    results.push(v.message);
    return null;
  };

  if (opts.font) { const e = await run(semanticChoose({ app: "pages", role: "AXPopUpButton", description: "Choose the font family.", option: opts.font, windowTitle: opts.windowTitle })); if (e) return e; }
  if (opts.typeface) { const e = await run(semanticChoose({ app: "pages", role: "AXPopUpButton", description: "Choose the typeface.", option: opts.typeface, windowTitle: opts.windowTitle })); if (e) return e; }
  if (opts.size !== undefined) { const e = await run(semanticSet({ app: "pages", role: "AXTextField", description: "Set the font size.", newValue: `${opts.size} pt`, windowTitle: opts.windowTitle })); if (e) return e; }
  for (const [key, value] of [["bold", opts.bold], ["italic", opts.italic], ["underline", opts.underline], ["strikethrough", opts.strikethrough]] as const) {
    if (value !== undefined) { const e = await run(semanticToggle({ app: "pages", role: "AXCheckBox", description: key, desired: value, windowTitle: opts.windowTitle })); if (e) return e; }
  }
  if (opts.align) {
    const desc = { left: "left", center: "centred", right: "right", justify: "justified" }[opts.align];
    const e = await run(semanticToggle({ app: "pages", role: "AXCheckBox", description: desc, desired: true, windowTitle: opts.windowTitle }));
    if (e) return e;
  }
  if (opts.beforeParagraph !== undefined) { const e = await run(semanticSet({ app: "pages", role: "AXTextField", description: "Set the amount of space before a paragraph.", newValue: opts.beforeParagraph, windowTitle: opts.windowTitle })); if (e) return e; }
  if (opts.afterParagraph !== undefined) { const e = await run(semanticSet({ app: "pages", role: "AXTextField", description: "Set the amount of space after a paragraph.", newValue: opts.afterParagraph, windowTitle: opts.windowTitle })); if (e) return e; }
  if (opts.lineSpacing !== undefined) { const e = await run(semanticSet({ app: "pages", role: "AXTextField", description: "Set the amount of space between lines of text.", newValue: opts.lineSpacing, windowTitle: opts.windowTitle })); if (e) return e; }
  if (!results.length) return failed("action=set needs at least one text-layout setting.");
  return good(`Updated ${results.length} Pages text-layout setting(s).`);
}

export interface PagesDocumentLayoutOptions {
  action: "get" | "set";
  windowTitle?: string;
  dryRun?: boolean;
  paperSize?: string;
  orientation?: "portrait" | "landscape";
  header?: boolean;
  footer?: boolean;
  headerDistance?: string;
  footerDistance?: string;
  topMargin?: string;
  bottomMargin?: string;
  leftMargin?: string;
  rightMargin?: string;
  facingPages?: boolean;
  hyphenate?: boolean;
  ligatures?: boolean;
}

async function prepPagesDocument(windowTitle?: string, dryRun = false): Promise<Outcome> {
  const first = await ensureInspectorSegment("pages", "Document", windowTitle, dryRun);
  if (!first.ok || dryRun) return first;
  return ensureInspectorSegment("pages", "Document", windowTitle, false);
}

export async function pagesDocumentLayout(opts: PagesDocumentLayoutOptions): Promise<Outcome> {
  const prep = await prepPagesDocument(opts.windowTitle, opts.dryRun === true);
  if (!prep.ok) return prep;
  if (opts.dryRun) return good("Pages Document inspector is resolvable; no change made.");
  if (opts.action === "get") {
    return semanticReadMany("pages", [
      { name: "paper size", target: { role: "AXPopUpButton", description: "Choose the paper size for this document." } },
      { name: "header", target: { role: "AXCheckBox", title: "Header" } },
      { name: "header distance", target: { role: "AXTextField", description: "Set the amount of space between the header and the top of the page." } },
      { name: "footer", target: { role: "AXCheckBox", title: "Footer" } },
      { name: "footer distance", target: { role: "AXTextField", description: "Set the amount of space between the footer and the bottom of the page." } },
      { name: "top margin", target: { role: "AXTextField", description: "Set the top margin." } },
      { name: "bottom margin", target: { role: "AXTextField", description: "Set the bottom margin." } },
      { name: "left margin", target: { role: "AXTextField", description: "Set the left margin." } },
      { name: "right margin", target: { role: "AXTextField", description: "Set the right margin." } },
      { name: "facing pages", target: { role: "AXCheckBox", title: "Facing Pages" } },
      { name: "hyphenate", target: { role: "AXCheckBox", title: "Hyphenate document" } },
      { name: "ligatures", target: { role: "AXCheckBox", title: "Show ligatures" } },
    ], { windowTitle: opts.windowTitle });
  }
  const tasks: Array<() => Promise<Outcome>> = [];
  if (opts.paperSize) tasks.push(() => semanticChoose({ app: "pages", role: "AXPopUpButton", description: "Choose the paper size for this document.", option: opts.paperSize!, windowTitle: opts.windowTitle }));
  if (opts.orientation) tasks.push(() => semanticPress({ app: "pages", role: "AXButton", description: `Make page orientation ${opts.orientation}.`, windowTitle: opts.windowTitle }));
  if (opts.header !== undefined) tasks.push(() => semanticToggle({ app: "pages", role: "AXCheckBox", title: "Header", desired: opts.header!, windowTitle: opts.windowTitle }));
  if (opts.footer !== undefined) tasks.push(() => semanticToggle({ app: "pages", role: "AXCheckBox", title: "Footer", desired: opts.footer!, windowTitle: opts.windowTitle }));
  if (opts.headerDistance !== undefined) tasks.push(() => semanticSet({ app: "pages", role: "AXTextField", description: "Set the amount of space between the header and the top of the page.", newValue: opts.headerDistance!, windowTitle: opts.windowTitle }));
  if (opts.footerDistance !== undefined) tasks.push(() => semanticSet({ app: "pages", role: "AXTextField", description: "Set the amount of space between the footer and the bottom of the page.", newValue: opts.footerDistance!, windowTitle: opts.windowTitle }));
  for (const [desc, value] of [["Set the top margin.", opts.topMargin], ["Set the bottom margin.", opts.bottomMargin], ["Set the left margin.", opts.leftMargin], ["Set the right margin.", opts.rightMargin]] as const) {
    if (value !== undefined) tasks.push(() => semanticSet({ app: "pages", role: "AXTextField", description: desc, newValue: value, windowTitle: opts.windowTitle }));
  }
  if (opts.facingPages !== undefined) tasks.push(() => semanticToggle({ app: "pages", role: "AXCheckBox", title: "Facing Pages", desired: opts.facingPages!, windowTitle: opts.windowTitle }));
  if (opts.hyphenate !== undefined) tasks.push(() => semanticToggle({ app: "pages", role: "AXCheckBox", title: "Hyphenate document", desired: opts.hyphenate!, windowTitle: opts.windowTitle }));
  if (opts.ligatures !== undefined) tasks.push(() => semanticToggle({ app: "pages", role: "AXCheckBox", title: "Show ligatures", desired: opts.ligatures!, windowTitle: opts.windowTitle }));
  if (!tasks.length) return failed("action=set needs at least one document-layout setting.");
  for (const task of tasks) { const r = await task(); if (!r.ok) return r; }
  return good(`Updated ${tasks.length} Pages document-layout setting(s).`);
}

export interface PagesSectionLayoutOptions {
  action: "get" | "set";
  windowTitle?: string;
  dryRun?: boolean;
  hideFirstPageHeaderFooter?: boolean;
  matchPreviousSection?: boolean;
  numbering?: "continue" | "start";
  startAt?: number;
  numberFormat?: string;
}

async function prepPagesSection(windowTitle?: string, dryRun = false): Promise<Outcome> {
  const first = await ensureInspectorSegment("pages", "Document", windowTitle, dryRun);
  if (!first.ok || dryRun) return first;
  return ensureInspectorSegment("pages", "Section", windowTitle, false);
}

export async function pagesSectionLayout(opts: PagesSectionLayoutOptions): Promise<Outcome> {
  const prep = await prepPagesSection(opts.windowTitle, opts.dryRun === true);
  if (!prep.ok) return prep;
  if (opts.dryRun) return good("Pages Section inspector is resolvable; no change made.");
  if (opts.action === "get") {
    return semanticReadMany("pages", [
      { name: "hide first page", target: { role: "AXCheckBox", title: "Hide on first page of section" } },
      { name: "match previous", target: { role: "AXCheckBox", title: "Match previous section" } },
      { name: "number format", target: { role: "AXPopUpButton", description: "Choose a number format." } },
      { name: "continue numbering", target: { role: "AXRadioButton", title: "Continue from previous section" } },
      { name: "start numbering", target: { role: "AXRadioButton", title: "Start at:" } },
      { name: "start number", target: { role: "AXTextField", description: "Set the first page number for this section.", allowDisabled: true } },
    ], { windowTitle: opts.windowTitle });
  }
  const tasks: Array<() => Promise<Outcome>> = [];
  if (opts.hideFirstPageHeaderFooter !== undefined) tasks.push(() => semanticToggle({ app: "pages", role: "AXCheckBox", title: "Hide on first page of section", desired: opts.hideFirstPageHeaderFooter!, windowTitle: opts.windowTitle }));
  if (opts.matchPreviousSection !== undefined) tasks.push(() => semanticToggle({ app: "pages", role: "AXCheckBox", title: "Match previous section", desired: opts.matchPreviousSection!, windowTitle: opts.windowTitle }));
  if (opts.numberFormat) tasks.push(() => semanticChoose({ app: "pages", role: "AXPopUpButton", description: "Choose a number format.", option: opts.numberFormat!, windowTitle: opts.windowTitle }));
  if (opts.numbering === "continue") tasks.push(() => semanticPress({ app: "pages", role: "AXRadioButton", title: "Continue from previous section", windowTitle: opts.windowTitle }));
  if (opts.numbering === "start" || opts.startAt !== undefined) tasks.push(() => semanticPress({ app: "pages", role: "AXRadioButton", title: "Start at:", windowTitle: opts.windowTitle }));
  if (!tasks.length && opts.startAt === undefined) return failed("action=set needs at least one section-layout setting.");
  for (const task of tasks) { const r = await task(); if (!r.ok) return r; }
  if (opts.startAt !== undefined) {
    const r = await semanticSet({ app: "pages", role: "AXTextField", description: "Set the first page number for this section.", newValue: String(opts.startAt), windowTitle: opts.windowTitle });
    if (!r.ok) return r;
  }
  return good("Updated Pages section-layout settings.");
}
