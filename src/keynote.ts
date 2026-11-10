// Keynote automation.
//
// Keynote keeps its content on *slides*, and a slide's text lives in two
// placeholder shapes: `default title item` and `default body item`. Setting text
// through those keeps the theme's typography, which is what you want - dropping
// a text box on top would look wrong on every theme.
//
// Presenting is scriptable too: `start slideshow`, `start from <slide>`,
// `show <slide>`, `show next`, `show previous`, `stop slideshow`.
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

const KEYNOTE = IWORK_APPS.keynote;

function target(pathArg?: string): string | Result {
  return resolveTarget(pathArg, ".key file");
}

function slidePreamble(slide: number): string[] {
  return [
    `  set theSlides to slides of doc`,
    `  if (count of theSlides) < ${slide} then error "no slide ${slide} (document has " & (count of theSlides) & ")"`,
    `  set s to item ${slide} of theSlides`,
  ];
}

// --- keynote_slides --------------------------------------------------------

export type SlideAction = "list" | "layouts" | "add" | "delete" | "duplicate" | "move";

export interface SlidesOptions {
  path?: string;
  action: SlideAction;
  slide?: number;
  toIndex?: number;
  layout?: string;
  count?: number;
}

export async function keynoteSlides(opts: SlidesOptions): Promise<Result> {
  const missing = requireApp(KEYNOTE);
  if (missing) return missing;
  const doc = target(opts.path);
  if (failed(doc)) return doc;

  if (opts.action === "layouts") {
    const body = [
      `  set out to ""`,
      `  repeat with l in slide layouts of doc`,
      `    set out to out & (name of l) & (ASCII character 31)`,
      `  end repeat`,
      `  return out`,
    ];
    const res = await runAppleScript(appScript(KEYNOTE, doc, body), 130_000);
    if (!res.ok) return bad(explainFailure(res, KEYNOTE.label));
    const names = res.out.split(String.fromCharCode(31)).filter(Boolean);
    if (!names.length) return ok("This document exposes no named slide layouts.");
    return ok(`Slide layouts in ${path.basename(doc)}:\n${names.map((n) => `  - ${n}`).join("\n")}`);
  }

  if (opts.action === "list") {
    const body = [
      `  set out to ""`,
      `  set i to 0`,
      `  repeat with sl in slides of doc`,
      `    set i to i + 1`,
      `    set lay to ""`,
      `    set ttl to ""`,
      `    set nts to ""`,
      `    set skp to false`,
      `    try`,
      `      set lay to name of base layout of sl`,
      `    end try`,
      `    try`,
      `      set ttl to (object text of default title item of sl) as text`,
      `    end try`,
      `    try`,
      `      set nts to (presenter notes of sl) as text`,
      `    end try`,
      `    try`,
      `      set skp to skipped of sl`,
      `    end try`,
      `    set out to out & (i as text) & (ASCII character 30) & lay & (ASCII character 30) & (skp as text) & (ASCII character 30) & ttl & (ASCII character 30) & nts & (ASCII character 31)`,
      `  end repeat`,
      `  return out`,
    ];
    const res = await runAppleScript(appScript(KEYNOTE, doc, body), 180_000);
    if (!res.ok) return bad(explainFailure(res, KEYNOTE.label));

    const rows = parseRecords(res.out);
    if (!rows.length) return ok(`${path.basename(doc)} has no slides.`);
    const lines = rows.map((r) => {
      const title = (r[3] ?? "").replace(/\s+/g, " ").slice(0, 46);
      const notes = (r[4] ?? "").trim();
      return (
        `  ${String(r[0]).padStart(3)}  ${(r[1] || "(no layout)").padEnd(22)} ${r[2] === "true" ? "SKIP " : "     "}` +
        `${title || "(no title)"}${notes ? `   [notes: ${notes.length} chars]` : ""}`
      );
    });
    return ok(`Slides in ${path.basename(doc)}:\n${lines.join("\n")}`);
  }

  if (opts.action === "add") {
    const layoutProp = opts.layout
      ? ` with properties {base layout: (slide layout ${asLit(opts.layout)} of doc)}`
      : "";
    const body = [
      `  set newSlide to make new slide at end of slides of doc${layoutProp}`,
      `  save doc`,
      `  return (count of slides of doc) as text`,
    ];
    const res = await runAppleScript(appScript(KEYNOTE, doc, body), 130_000);
    if (!res.ok) return bad(explainFailure(res, KEYNOTE.label));
    return ok(
      `Added a slide${opts.layout ? ` using layout ${JSON.stringify(opts.layout)}` : ""}. ` +
        `Document now has ${res.out.trim()} slides.`,
    );
  }

  if (!opts.slide) return bad(`ERROR: action=${opts.action} needs a 1-based \`slide\`.`);

  if (opts.action === "delete") {
    const body = [
      ...slidePreamble(opts.slide),
      `  if (count of slides of doc) is 1 then error "cannot delete the only slide"`,
      `  delete s`,
      `  save doc`,
      `  return (count of slides of doc) as text`,
    ];
    const res = await runAppleScript(appScript(KEYNOTE, doc, body), 130_000);
    if (!res.ok) return bad(explainFailure(res, KEYNOTE.label));
    return ok(`Deleted slide ${opts.slide}. ${res.out.trim()} slide(s) remain.`);
  }

  // duplicate / move
  const toIndex = opts.toIndex;
  if (opts.action === "duplicate" && toIndex === undefined) {
    const body = [
      ...slidePreamble(opts.slide),
      `  duplicate s to end of slides of doc`,
      `  save doc`,
      `  return (count of slides of doc) as text`,
    ];
    const res = await runAppleScript(appScript(KEYNOTE, doc, body), 130_000);
    if (!res.ok) return bad(explainFailure(res, KEYNOTE.label));
    return ok(`Duplicated slide ${opts.slide} to the end. ${res.out.trim()} slide(s) now.`);
  }

  if (toIndex === undefined) {
    return bad("ERROR: action=move needs `toIndex` - the slide number it should occupy afterwards.");
  }

  // Keynote has `duplicate ... to <location>` but no plain `move`, so a move is
  // copy-then-delete. Doing it in one script keeps the document consistent.
  const body = [
    ...slidePreamble(opts.slide),
    `  set total to count of slides of doc`,
    `  set targetIdx to ${toIndex}`,
    `  if targetIdx < 1 then set targetIdx to 1`,
    `  if targetIdx > total then set targetIdx to total`,
    `  if targetIdx is ${opts.slide} then return "unchanged"`,
    `  if targetIdx > ${opts.slide} then`,
    `    duplicate s to before (item (targetIdx + 1) of (slides of doc))`,
    `  else`,
    `    duplicate s to before (item targetIdx of (slides of doc))`,
    `  end if`,
    `  delete s`,
    `  save doc`,
    `  return "moved"`,
  ];

  const res = await runAppleScript(appScript(KEYNOTE, doc, body), 180_000);
  if (!res.ok) return bad(explainFailure(res, KEYNOTE.label));
  if (res.out.trim() === "unchanged") return ok(`Slide ${opts.slide} is already at position ${toIndex}.`);
  return ok(`Moved slide ${opts.slide} to position ${toIndex}.`);
}

// --- keynote_content -------------------------------------------------------

export type ContentAction = "setTitle" | "setBody" | "addTextBox" | "addImage" | "addTable";

export interface ContentOptions {
  path?: string;
  action: ContentAction;
  slide: number;
  text?: string;
  imagePath?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  font?: string;
  size?: number;
  color?: string;
  rows?: number;
  cols?: number;
}

export async function keynoteContent(opts: ContentOptions): Promise<Result> {
  const missing = requireApp(KEYNOTE);
  if (missing) return missing;
  const doc = target(opts.path);
  if (failed(doc)) return doc;
  if (!opts.slide) return bad("ERROR: slide is required (1-based).");

  let colorRgb: [number, number, number] | null = null;
  try {
    if (opts.color) colorRgb = hexToApple(opts.color);
  } catch (err) {
    return bad(`ERROR: ${(err as Error).message}`);
  }

  // ---- title / body -------------------------------------------------------
  if (opts.action === "setTitle" || opts.action === "setBody") {
    if (opts.text === undefined) return bad(`ERROR: action=${opts.action} needs \`text\`.`);
    const isTitle = opts.action === "setTitle";
    const itemName = isTitle ? "default title item" : "default body item";
    const showFlag = isTitle ? "title showing" : "body showing";

    const body = [
      ...slidePreamble(opts.slide),
      `  set ${isTitle ? "title showing" : "body showing"} of s to true`,
      `  set object text of ${itemName} of s to ${asLit(opts.text)}`,
      opts.font ? `  set font of object text of ${itemName} of s to ${asLit(opts.font)}` : "",
      opts.size ? `  set size of object text of ${itemName} of s to ${opts.size}` : "",
      colorRgb ? `  set color of object text of ${itemName} of s to {${colorRgb.join(", ")}}` : "",
      `  save doc`,
      `  return "ok"`,
    ];

    const res = await runAppleScript(appScript(KEYNOTE, doc, body), 130_000);
    if (!res.ok) {
      if (res.code === -1728) {
        return bad(
          `ERROR: slide ${opts.slide} has no ${isTitle ? "title" : "body"} placeholder - its layout ` +
            `(${showFlag} placeholder) does not provide one. Pick a different layout with keynote_slides, ` +
            `or use addTextBox instead.`,
        );
      }
      return bad(explainFailure(res, KEYNOTE.label));
    }
    return ok(`Set the ${isTitle ? "title" : "body"} of slide ${opts.slide}.`);
  }

  // ---- addTextBox ---------------------------------------------------------
  if (opts.action === "addTextBox") {
    if (opts.text === undefined) return bad("ERROR: action=addTextBox needs `text`.");
    const props = [
      opts.x !== undefined && opts.y !== undefined ? `position:{${Math.round(opts.x)}, ${Math.round(opts.y)}}` : "",
      opts.width ? `width:${Math.round(opts.width)}` : "",
      opts.height ? `height:${Math.round(opts.height)}` : "",
    ].filter(Boolean);
    const propList = props.length ? ` with properties {${props.join(", ")}}` : "";

    const body = [
      ...slidePreamble(opts.slide),
      `  set tb to make new text item at end of s${propList}`,
      `  set object text of tb to ${asLit(opts.text)}`,
      opts.font ? `  set font of object text of tb to ${asLit(opts.font)}` : "",
      opts.size ? `  set size of object text of tb to ${opts.size}` : "",
      colorRgb ? `  set color of object text of tb to {${colorRgb.join(", ")}}` : "",
      `  save doc`,
      `  return "ok"`,
    ];
    const res = await runAppleScript(appScript(KEYNOTE, doc, body), 130_000);
    if (!res.ok) return bad(explainFailure(res, KEYNOTE.label));
    return ok(`Added a text box to slide ${opts.slide}.`);
  }

  // ---- addImage -----------------------------------------------------------
  if (opts.action === "addImage") {
    if (!opts.imagePath) return bad("ERROR: action=addImage needs `imagePath`.");
    const image = resolveUserPath(opts.imagePath);
    if (!fs.existsSync(image)) return bad(`ERROR: no such image: ${image}`);

    const body = [
      ...slidePreamble(opts.slide),
      `  set img to make new image at end of s with properties {file:(POSIX file ${asLit(image)})}`,
      ...(opts.width ? [`  try`, `    set width of img to ${Math.round(opts.width)}`, `  end try`] : []),
      ...(opts.height ? [`  try`, `    set height of img to ${Math.round(opts.height)}`, `  end try`] : []),
      ...(opts.x !== undefined && opts.y !== undefined
        ? [`  try`, `    set position of img to {${Math.round(opts.x)}, ${Math.round(opts.y)}}`, `  end try`]
        : []),
      `  save doc`,
      `  return "ok"`,
    ];
    const res = await runAppleScript(appScript(KEYNOTE, doc, body), 180_000);
    if (!res.ok) return bad(explainFailure(res, KEYNOTE.label));
    return ok(`Added ${path.basename(image)} to slide ${opts.slide}.`);
  }

  // ---- addTable -----------------------------------------------------------
  const rows = opts.rows ?? 3;
  const cols = opts.cols ?? 3;
  const body = [
    ...slidePreamble(opts.slide),
    `  make new table at end of s with properties {row count:${rows}, column count:${cols}}`,
    `  save doc`,
    `  return "ok"`,
  ];
  const res = await runAppleScript(appScript(KEYNOTE, doc, body), 130_000);
  if (!res.ok) return bad(explainFailure(res, KEYNOTE.label));
  return ok(`Added a ${rows}x${cols} table to slide ${opts.slide}.`);
}

// --- keynote_notes ---------------------------------------------------------

export interface NotesOptions {
  path?: string;
  action: "get" | "set";
  slide: number;
  text?: string;
}

export async function keynoteNotes(opts: NotesOptions): Promise<Result> {
  const missing = requireApp(KEYNOTE);
  if (missing) return missing;
  const doc = target(opts.path);
  if (failed(doc)) return doc;
  if (!opts.slide) return bad("ERROR: slide is required (1-based).");

  if (opts.action === "get") {
    const body = [...slidePreamble(opts.slide), `  return (presenter notes of s) as text`];
    const res = await runAppleScript(appScript(KEYNOTE, doc, body), 130_000);
    if (!res.ok) return bad(explainFailure(res, KEYNOTE.label));
    const text = res.out.trim();
    return ok(text ? `Presenter notes for slide ${opts.slide}:\n${text}` : `Slide ${opts.slide} has no presenter notes.`);
  }

  if (opts.text === undefined) return bad("ERROR: action=set needs `text`.");
  const body = [...slidePreamble(opts.slide), `  set presenter notes of s to ${asLit(opts.text)}`, `  save doc`, `  return "ok"`];
  const res = await runAppleScript(appScript(KEYNOTE, doc, body), 130_000);
  if (!res.ok) return bad(explainFailure(res, KEYNOTE.label));
  return ok(`Set ${opts.text.length} character(s) of presenter notes on slide ${opts.slide}.`);
}

// --- keynote_document ------------------------------------------------------

export interface KeynoteDocumentOptions {
  path?: string;
  action: "get" | "set";
  autoLoop?: boolean;
  autoPlay?: boolean;
  autoRestart?: boolean;
  maximumIdleDuration?: number;
  width?: number;
  height?: number;
  theme?: string;
  slideNumbersShowing?: boolean;
}

export async function keynoteDocument(opts: KeynoteDocumentOptions): Promise<Result> {
  const missing = requireApp(KEYNOTE);
  if (missing) return missing;
  const doc = target(opts.path);
  if (failed(doc)) return doc;

  if (opts.action === "get") {
    const body = [
      `  set th to ""`,
      `  try`,
      `    set th to name of document theme of doc`,
      `  end try`,
      `  return (auto loop of doc as text) & (ASCII character 30) & (auto play of doc as text) & (ASCII character 30) & (auto restart of doc as text) & (ASCII character 30) & (maximum idle duration of doc as text) & (ASCII character 30) & (width of doc as text) & (ASCII character 30) & (height of doc as text) & (ASCII character 30) & th & (ASCII character 30) & (slide numbers showing of doc as text)`,
    ];
    const res = await runAppleScript(appScript(KEYNOTE, doc, body), 130_000);
    if (!res.ok) return bad(explainFailure(res, KEYNOTE.label));
    const f = res.out.split(US);
    return ok(
      `Keynote document settings:\n` +
        `  auto loop             ${f[0]}\n` +
        `  auto play             ${f[1]}\n` +
        `  auto restart          ${f[2]}\n` +
        `  idle duration         ${f[3]} s\n` +
        `  slide size            ${f[4]} x ${f[5]} pt\n` +
        `  theme                 ${f[6] || "(unknown)"}\n` +
        `  slide numbers showing ${f[7]}`,
    );
  }

  const body: string[] = [];
  if (opts.autoLoop !== undefined) body.push(`  set auto loop of doc to ${opts.autoLoop}`);
  if (opts.autoPlay !== undefined) body.push(`  set auto play of doc to ${opts.autoPlay}`);
  if (opts.autoRestart !== undefined) body.push(`  set auto restart of doc to ${opts.autoRestart}`);
  if (opts.maximumIdleDuration !== undefined) body.push(`  set maximum idle duration of doc to ${Math.round(opts.maximumIdleDuration)}`);
  if (opts.width !== undefined) body.push(`  set width of doc to ${Math.round(opts.width)}`);
  if (opts.height !== undefined) body.push(`  set height of doc to ${Math.round(opts.height)}`);
  if (opts.theme) body.push(`  set document theme of doc to theme ${asLit(opts.theme)}`);
  if (opts.slideNumbersShowing !== undefined) body.push(`  set slide numbers showing of doc to ${opts.slideNumbersShowing}`);
  if (!body.length) return bad("ERROR: action=set needs at least one document setting.");
  body.push(`  save doc`, `  return "ok"`);
  const res = await runAppleScript(appScript(KEYNOTE, doc, body), 180_000);
  if (!res.ok) return bad(explainFailure(res, KEYNOTE.label));
  return ok(`Updated Keynote document settings.`);
}

// --- keynote_slide_format --------------------------------------------------

export interface SlideFormatOptions {
  path?: string;
  action: "get" | "set";
  slide: number;
  layout?: string;
  skipped?: boolean;
  titleShowing?: boolean;
  bodyShowing?: boolean;
}

export async function keynoteSlideFormat(opts: SlideFormatOptions): Promise<Result> {
  const missing = requireApp(KEYNOTE);
  if (missing) return missing;
  const doc = target(opts.path);
  if (failed(doc)) return doc;
  if (!opts.slide) return bad("ERROR: slide is required (1-based).");

  if (opts.action === "get") {
    const body = [
      ...slidePreamble(opts.slide),
      `  set lay to ""`,
      `  try`,
      `    set lay to name of base layout of s`,
      `  end try`,
      `  return lay & (ASCII character 30) & (skipped of s as text) & (ASCII character 30) & (title showing of s as text) & (ASCII character 30) & (body showing of s as text)`,
    ];
    const res = await runAppleScript(appScript(KEYNOTE, doc, body), 130_000);
    if (!res.ok) return bad(explainFailure(res, KEYNOTE.label));
    const f = res.out.split(US);
    return ok(`Slide ${opts.slide}: layout=${JSON.stringify(f[0] || "")}, skipped=${f[1]}, titleShowing=${f[2]}, bodyShowing=${f[3]}`);
  }

  const body: string[] = [...slidePreamble(opts.slide)];
  if (opts.layout) body.push(`  set base layout of s to slide layout ${asLit(opts.layout)} of doc`);
  if (opts.skipped !== undefined) body.push(`  set skipped of s to ${opts.skipped}`);
  if (opts.titleShowing !== undefined) body.push(`  set title showing of s to ${opts.titleShowing}`);
  if (opts.bodyShowing !== undefined) body.push(`  set body showing of s to ${opts.bodyShowing}`);
  if (body.length === slidePreamble(opts.slide).length) return bad("ERROR: action=set needs layout, skipped, titleShowing and/or bodyShowing.");
  body.push(`  save doc`, `  return "ok"`);
  const res = await runAppleScript(appScript(KEYNOTE, doc, body), 180_000);
  if (!res.ok) return bad(explainFailure(res, KEYNOTE.label));
  return ok(`Updated slide ${opts.slide} layout/visibility settings.`);
}

// --- keynote_transition ----------------------------------------------------

const TRANSITION_EFFECTS = new Set([
  "no transition effect", "magic move", "shimmer", "sparkle", "swing", "object cube", "object flip",
  "object pop", "object push", "object revolve", "object zoom", "perspective", "clothesline", "confetti",
  "dissolve", "drop", "droplet", "fade through color", "grid", "iris", "move in", "push", "reveal", "switch",
  "wipe", "blinds", "color planes", "cube", "doorway", "fall", "flip", "flop", "mosaic", "page flip", "pivot",
  "reflection", "revolving door", "scale", "swap", "swoosh", "twirl", "twist", "fade and move", "radial wipe",
]);

export interface TransitionOptions {
  path?: string;
  action: "get" | "set" | "clear";
  slide: number;
  effect?: string;
  duration?: number;
  delay?: number;
  automatic?: boolean;
}

export async function keynoteTransition(opts: TransitionOptions): Promise<Result> {
  const missing = requireApp(KEYNOTE);
  if (missing) return missing;
  const doc = target(opts.path);
  if (failed(doc)) return doc;
  if (!opts.slide) return bad("ERROR: slide is required (1-based).");

  if (opts.action === "get") {
    const body = [
      ...slidePreamble(opts.slide),
      `  set tr to transition properties of s`,
      `  return (transition effect of tr as text) & (ASCII character 30) & (transition duration of tr as text) & (ASCII character 30) & (transition delay of tr as text) & (ASCII character 30) & (automatic transition of tr as text)`,
    ];
    const res = await runAppleScript(appScript(KEYNOTE, doc, body), 130_000);
    if (!res.ok) return bad(explainFailure(res, KEYNOTE.label));
    const f = res.out.split(US);
    return ok(`Slide ${opts.slide} transition: effect=${f[0]}, duration=${f[1]} s, delay=${f[2]} s, automatic=${f[3]}.`);
  }

  const effect = opts.action === "clear" ? "no transition effect" : (opts.effect?.trim().toLowerCase() || undefined);
  if (effect && !TRANSITION_EFFECTS.has(effect)) {
    return bad(`ERROR: unknown transition effect ${JSON.stringify(opts.effect)}. Supported: ${[...TRANSITION_EFFECTS].join(", ")}.`);
  }
  if (opts.duration !== undefined && opts.duration < 0) return bad("ERROR: duration must be >= 0.");
  if (opts.delay !== undefined && opts.delay < 0) return bad("ERROR: delay must be >= 0.");

  const body = [
    ...slidePreamble(opts.slide),
    `  set tr to transition properties of s`,
    `  set eff to transition effect of tr`,
    `  set dur to transition duration of tr`,
    `  set dly to transition delay of tr`,
    `  set aut to automatic transition of tr`,
    effect ? `  set eff to ${effect}` : "",
    opts.duration !== undefined ? `  set dur to ${opts.duration}` : "",
    opts.delay !== undefined ? `  set dly to ${opts.delay}` : "",
    opts.automatic !== undefined ? `  set aut to ${opts.automatic}` : "",
    `  set transition properties of s to {transition effect:eff, transition duration:dur, transition delay:dly, automatic transition:aut}`,
    `  save doc`,
    `  return "ok"`,
  ];
  const res = await runAppleScript(appScript(KEYNOTE, doc, body), 180_000);
  if (!res.ok) return bad(explainFailure(res, KEYNOTE.label));
  return ok(`${opts.action === "clear" ? "Cleared" : "Updated"} transition on slide ${opts.slide}.`);
}

// --- keynote_show ----------------------------------------------------------

export interface ShowOptions {
  path?: string;
  action: "start" | "stop" | "next" | "previous" | "goto";
  slide?: number;
}

export async function keynoteShow(opts: ShowOptions): Promise<Result> {
  const missing = requireApp(KEYNOTE);
  if (missing) return missing;

  // Presenting does not need a document binding - it acts on whatever Keynote
  // currently has frontmost, which is the only thing that makes sense here.
  const body: string[] = [];
  switch (opts.action) {
    case "start":
      body.push(`  start slideshow`);
      break;
    case "stop":
      body.push(`  stop slideshow`);
      break;
    case "next":
      body.push(`  show next`);
      break;
    case "previous":
      body.push(`  show previous`);
      break;
    case "goto":
      if (!opts.slide) return bad("ERROR: action=goto needs a 1-based `slide`.");
      body.push(`  show (item ${opts.slide} of (slides of document 1))`);
      break;
    default:
      return bad(`ERROR: unknown action ${opts.action}.`);
  }

  const script = [
    `with timeout of 60 seconds`,
    `  tell application id "${KEYNOTE.bundleId}"`,
    `  activate`,
    ...body,
    `  end tell`,
    `end timeout`,
  ].join("\n");

  const res = await runAppleScript(script, 70_000);
  if (!res.ok) return bad(explainFailure(res, KEYNOTE.label));

  if (opts.action === "goto") return ok(`Showing slide ${opts.slide}.`);
  const labels: Record<string, string> = {
    start: "Started the slideshow.",
    stop: "Stopped the slideshow.",
    next: "Advanced one step.",
    previous: "Went back one step.",
  };
  return ok(labels[opts.action] ?? "Done.");
}
