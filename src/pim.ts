// Everyday apps: browser tabs, Calendar, Reminders, Notes and Contacts.
//
// These are the places a person actually keeps their life, so the agent can
// read them and add to them - but nothing here deletes: no event, reminder,
// note or contact is ever removed.
import { runAppleScript, explainFailure, asLit, ok as Ok, bad as Bad, type Result } from "./applescript.js";
import { good, failed, type Outcome } from "./exec.js";

const US = String.fromCharCode(31);
const RS = String.fromCharCode(30);

async function osa(source: string, timeoutMs = 45_000, label = "the app"): Promise<Result> {
  const res = await runAppleScript(source, timeoutMs);
  if (!res.ok) return Bad(explainFailure(res, label));
  return Ok(res.out);
}

function rows(out: string): string[][] {
  return out
    .split(RS)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => r.split(US).map((f) => f.trim()));
}

// --- browser --------------------------------------------------------------

export type BrowserName = "Safari" | "Google Chrome" | "Microsoft Edge" | "Brave Browser" | "Arc";

export interface BrowserArgs {
  action: "tabs" | "open" | "active" | "read" | "close";
  app?: BrowserName;
  url?: string;
  index?: number;
  window?: number;
}

async function runningBrowser(preferred?: BrowserName): Promise<BrowserName | null> {
  const candidates: BrowserName[] = preferred
    ? [preferred]
    : ["Safari", "Google Chrome", "Arc", "Brave Browser", "Microsoft Edge"];
  for (const name of candidates) {
    const res = await runAppleScript(
      `tell application "System Events" to (name of processes) contains ${asLit(name)}`,
      10_000,
    );
    if (res.out.trim() === "true") return name;
  }
  return null;
}

export async function browser(args: BrowserArgs): Promise<Outcome> {
  const name = await runningBrowser(args.app);
  if (!name) {
    if (args.action === "open" && args.url) {
      const res = await runAppleScript(`open location ${asLit(args.url)}`, 20_000);
      return res.ok ? good(`Opened ${args.url} in the default browser.`) : failed(explainFailure(res, "the default browser"));
    }
    return failed("No supported browser is running (Safari, Chrome, Arc, Brave, Edge). Start one first.");
  }

  if (args.action === "open") {
    if (!args.url) return failed("action=open needs url");
    const res = await osa(`tell application ${asLit(name)}\n  open location ${asLit(args.url)}\n  activate\nend tell`, 30_000, name);
    return res.ok ? good(`Opened ${args.url} in ${name}.`) : failed(res.message);
  }

  if (args.action === "tabs") {
    const script = `set out to ""
tell application ${asLit(name)}
  set wIndex to 0
  repeat with w in windows
    set wIndex to wIndex + 1
    set tIndex to 0
    repeat with t in tabs of w
      set tIndex to tIndex + 1
      try
        set out to out & wIndex & "${US}" & tIndex & "${US}" & (name of t) & "${US}" & (URL of t) & "${RS}"
      end try
    end repeat
  end repeat
end tell
return out`;
    const res = await osa(script, 60_000, name);
    if (!res.ok) return failed(res.message);
    const list = rows(res.message);
    if (!list.length) return good(`${name} has no open tabs.`);
    const lines = list.map(([w, t, title, url]) => `  w${w}.${t}  ${title || "(untitled)"}\n        ${url}`);
    return good(`${list.length} tab(s) in ${name}:\n${lines.join("\n")}`);
  }

  if (args.action === "active") {
    const script = `tell application ${asLit(name)}
  set t to active tab of front window
  return (name of t) & "${US}" & (URL of t)
end tell`;
    const res = await osa(script, 30_000, name);
    return res.ok ? good(`${name} front tab:\n  ${res.message.split(US).join("\n  ")}`) : failed(res.message);
  }

  if (args.action === "close") {
    const w = Math.max(1, args.window ?? 1);
    const t = Math.max(1, args.index ?? 1);
    const script = `tell application ${asLit(name)} to close tab ${t} of window ${w}`;
    const res = await osa(script, 30_000, name);
    return res.ok ? good(`Closed tab ${t} of window ${w} in ${name}.`) : failed(res.message);
  }

  // read: page text of the active tab
  const js = "document.body ? document.body.innerText : document.documentElement.innerText";
  const isSafari = name === "Safari";
  const script = isSafari
    ? `tell application "Safari" to do JavaScript ${asLit(js)} in active tab of front window`
    : `tell application ${asLit(name)} to execute front window's active tab javascript ${asLit(js)}`;
  const res = await osa(script, 60_000, name);
  if (!res.ok) {
    if (/-1723|-2700|not allowed|JavaScript from Apple Events/i.test(res.message)) {
      return failed(
        `${name} blocks JavaScript from Apple Events. Enable it in the app's Develop menu ` +
          `(\"Allow JavaScript from Apple Events\") and retry. ${res.message}`,
      );
    }
    return failed(res.message);
  }
  const text = res.message.trim();
  return good(text ? text.slice(0, 30_000) : "(page has no text)");
}

// --- calendar -------------------------------------------------------------

const ISO_HANDLER = `
on isoToDate(s)
  set t to current date
  set y to (text 1 thru 4 of s) as integer
  set mo to (text 6 thru 7 of s) as integer
  set d to (text 9 thru 10 of s) as integer
  set h to 0
  set mi to 0
  if (length of s) >= 16 then
    set h to (text 12 thru 13 of s) as integer
    set mi to (text 15 thru 16 of s) as integer
  end if
  set day of t to 1
  set year of t to y
  set month of t to mo
  set day of t to d
  set hours of t to h
  set minutes of t to mi
  set seconds of t to 0
  return t
end isoToDate
`;

function isoOr(offsetHours: number): string {
  const d = new Date(Date.now() + offsetHours * 3600_000);
  return d.toISOString().slice(0, 16);
}

export interface CalendarArgs {
  action: "events" | "calendars" | "create";
  from?: string;
  to?: string;
  limit?: number;
  calendar?: string;
  summary?: string;
  start?: string;
  end?: string;
  notes?: string;
  location?: string;
}

export async function calendar(args: CalendarArgs): Promise<Outcome> {
  if (args.action === "calendars") {
    const res = await osa(`tell application "Calendar"\n  set out to ""\n  repeat with c in calendars\n    set out to out & (name of c) & "${RS}"\n  end repeat\n  return out\nend tell`, 30_000, "Calendar");
    if (!res.ok) return failed(res.message);
    return good(`Calendars:\n${rows(res.message).map((r) => `  - ${r[0]}`).join("\n")}`);
  }

  if (args.action === "create") {
    if (!args.summary || !args.start || !args.end) return failed("action=create needs summary, start and end (YYYY-MM-DDTHH:MM)");
    const target = args.calendar ? `calendar ${asLit(args.calendar)}` : "calendar 1";
    const script = `${ISO_HANDLER}
set startDate to isoToDate(${asLit(args.start)})
set endDate to isoToDate(${asLit(args.end)})
tell application "Calendar"
  tell ${target}
    set newEvent to make new event with properties {summary:${asLit(args.summary)}, start date:startDate, end date:endDate${args.notes ? `, description:${asLit(args.notes)}` : ""}${args.location ? `, location:${asLit(args.location)}` : ""}}
    return summary of newEvent
  end tell
end tell`;
    const res = await osa(script, 45_000, "Calendar");
    return res.ok ? good(`Created event "${res.message}" (${args.start} -> ${args.end}).`) : failed(res.message);
  }

  const from = args.from ?? isoOr(0);
  const to = args.to ?? isoOr(24 * 7);
  const limit = Math.min(Math.max(1, args.limit ?? 40), 200);
  const script = `${ISO_HANDLER}
set fromDate to isoToDate(${asLit(from)})
set toDate to isoToDate(${asLit(to)})
set out to ""
tell application "Calendar"
  repeat with c in calendars${args.calendar ? ` whose name is ${asLit(args.calendar)}` : ""}
    set calName to name of c
    repeat with e in (every event of c whose start date is greater than or equal to fromDate and start date is less than or equal to toDate)
      try
        set out to out & (start date of e as string) & "${US}" & (end date of e as string) & "${US}" & calName & "${US}" & (summary of e) & "${US}" & (location of e as string) & "${RS}"
      end try
      if (length of out) > 40000 then exit repeat
    end repeat
  end repeat
end tell
return out`;
  const res = await osa(script, 90_000, "Calendar");
  if (!res.ok) return failed(res.message);
  const list = rows(res.message).slice(0, limit);
  if (!list.length) return good(`No events between ${from} and ${to}.`);
  const lines = list.map(([start, end, cal, summary, location]) =>
    `  ${start} -> ${end}  [${cal}] ${summary}${location ? ` @ ${location}` : ""}`,
  );
  return good(`${list.length} event(s) between ${from} and ${to}:\n${lines.join("\n")}`);
}

// --- reminders ------------------------------------------------------------

export interface RemindersArgs {
  action: "lists" | "list" | "add" | "complete";
  list?: string;
  name?: string;
  due?: string;
  notes?: string;
  includeCompleted?: boolean;
  limit?: number;
}

export async function reminders(args: RemindersArgs): Promise<Outcome> {
  if (args.action === "lists") {
    const res = await osa(`tell application "Reminders"\n  set out to ""\n  repeat with l in lists\n    set out to out & (name of l) & "${US}" & (count of reminders of l) & "${RS}"\n  end repeat\n  return out\nend tell`, 45_000, "Reminders");
    if (!res.ok) return failed(res.message);
    const list = rows(res.message);
    return good(list.length ? `Lists:\n${list.map(([n, c]) => `  - ${n} (${c} item(s))`).join("\n")}` : "No reminder lists.");
  }

  if (args.action === "add") {
    if (!args.name) return failed("action=add needs name");
    const listName = args.list ?? "Reminders";
    const props = [`name:${asLit(args.name)}`];
    if (args.notes) props.push(`body:${asLit(args.notes)}`);
    const due = args.due ? `${ISO_HANDLER}\nset dueDate to isoToDate(${asLit(args.due)})\n` : "";
    const script = `${due}tell application "Reminders"
  set targetList to first list whose name is ${asLit(listName)}
  set newReminder to make new reminder at targetList with properties {${props.join(", ")}${args.due ? ", due date:dueDate" : ""}}
  return name of newReminder
end tell`;
    const res = await osa(script, 45_000, "Reminders");
    return res.ok ? good(`Added "${res.message}" to ${listName}${args.due ? ` due ${args.due}` : ""}.`) : failed(res.message);
  }

  if (args.action === "complete") {
    if (!args.name) return failed("action=complete needs name");
    const script = `tell application "Reminders"
  set matches to (every reminder of every list whose name is ${asLit(args.name)})
  set done to 0
  repeat with r in matches
    try
      set completed of r to true
      set done to done + 1
    end try
  end repeat
  return done
end tell`;
    const res = await osa(script, 45_000, "Reminders");
    if (!res.ok) return failed(res.message);
    const count = Number(res.message.trim() || 0);
    return count ? good(`Completed ${count} reminder(s) named "${args.name}".`) : failed(`No open reminder named "${args.name}".`);
  }

  const limit = Math.min(Math.max(1, args.limit ?? 40), 200);
  const script = `set out to ""
tell application "Reminders"
  repeat with l in lists${args.list ? ` whose name is ${asLit(args.list)}` : ""}
    set listName to name of l
    repeat with r in reminders of l
      if ${args.includeCompleted ? "true" : "(completed of r) is false"} then
        set dueText to ""
        try
          if due date of r is not missing value then set dueText to (due date of r as string)
        end try
        set out to out & listName & "${US}" & (name of r) & "${US}" & dueText & "${RS}"
      end if
      if (length of out) > 30000 then exit repeat
    end repeat
  end repeat
end tell
return out`;
  const res = await osa(script, 90_000, "Reminders");
  if (!res.ok) return failed(res.message);
  const list = rows(res.message).slice(0, limit);
  if (!list.length) return good("No reminders found.");
  return good(`${list.length} reminder(s):\n${list.map(([l, n, due]) => `  [${l}] ${n}${due ? `  due ${due}` : ""}`).join("\n")}`);
}

// --- notes ---------------------------------------------------------------

export interface NotesArgs {
  action: "list" | "search" | "read" | "create" | "append";
  folder?: string;
  title?: string;
  body?: string;
  limit?: number;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
}

export async function notes(args: NotesArgs): Promise<Outcome> {
  if (args.action === "list") {
    const limit = Math.min(Math.max(1, args.limit ?? 30), 100);
    const script = `set out to ""
tell application "Notes"
  repeat with n in notes${args.folder ? ` of folder ${asLit(args.folder)}` : ""}
    set out to out & (name of n) & "${US}" & (modification date of n as string) & "${US}" & (name of container of n) & "${RS}"
    if (length of out) > 20000 then exit repeat
  end repeat
end tell
return out`;
    const res = await osa(script, 90_000, "Notes");
    if (!res.ok) return failed(res.message);
    const list = rows(res.message).slice(0, limit);
    return good(list.length ? `${list.length} note(s):\n${list.map(([t, when, folder]) => `  ${t}  [${folder}]  ${when}`).join("\n")}` : "No notes.");
  }

  if (args.action === "search") {
    if (!args.title) return failed("action=search needs title (substring)");
    const script = `set out to ""
tell application "Notes"
  repeat with n in (every note whose name contains ${asLit(args.title)})
    set out to out & (name of n) & "${US}" & (name of container of n) & "${US}" & (modification date of n as string) & "${RS}"
    if (length of out) > 20000 then exit repeat
  end repeat
end tell
return out`;
    const res = await osa(script, 90_000, "Notes");
    if (!res.ok) return failed(res.message);
    const list = rows(res.message).slice(0, 30);
    return good(list.length ? `${list.length} match(es):\n${list.map(([t, f, w]) => `  ${t}  [${f}]  ${w}`).join("\n")}` : `No note whose title contains "${args.title}".`);
  }

  if (args.action === "read") {
    if (!args.title) return failed("action=read needs title");
    const script = `tell application "Notes"
  set matches to (every note whose name is ${asLit(args.title)})
  if (count of matches) is 0 then return "NOT_FOUND"
  set n to item 1 of matches
  return (name of n) & "${US}" & (name of container of n) & "${US}" & (body of n)
end tell`;
    const res = await osa(script, 90_000, "Notes");
    if (!res.ok) return failed(res.message);
    if (res.message === "NOT_FOUND") return failed(`No note titled "${args.title}". Use action=search for substrings.`);
    const [title, folder, body] = res.message.split(US);
    const text = body
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();
    return good(`# ${title}  [${folder}]\n\n${text}`);
  }

  if (!args.title || !args.body) return failed(`action=${args.action} needs title and body`);
  const folderName = args.folder ?? "Notes";
  const html = `<div>${escapeHtml(args.body)}</div>`;

  if (args.action === "create") {
    const script = `tell application "Notes"
  set targetFolder to first folder whose name is ${asLit(folderName)}
  set newNote to make new note at targetFolder with properties {name:${asLit(args.title)}, body:${asLit(html)}}
  return name of newNote
end tell`;
    const res = await osa(script, 90_000, "Notes");
    return res.ok ? good(`Created note "${res.message}" in ${folderName}.`) : failed(res.message);
  }

  const script = `tell application "Notes"
  set matches to (every note whose name is ${asLit(args.title)})
  if (count of matches) is 0 then return "NOT_FOUND"
  set n to item 1 of matches
  set body of n to (body of n) & ${asLit(html)}
  return name of n
end tell`;
  const res = await osa(script, 90_000, "Notes");
  if (!res.ok) return failed(res.message);
  return res.message === "NOT_FOUND" ? failed(`No note titled "${args.title}".`) : good(`Appended to "${res.message}".`);
}

// --- contacts ------------------------------------------------------------

export async function contacts(args: { query: string; limit?: number }): Promise<Outcome> {
  const query = (args.query ?? "").trim();
  if (!query) return failed("query is required");
  const limit = Math.min(Math.max(1, args.limit ?? 10), 50);
  const script = `set out to ""
tell application "Contacts"
  set matches to (every person whose name contains ${asLit(query)})
  set i to 0
  repeat with p in matches
    set i to i + 1
    if i > ${limit} then exit repeat
    set emails to ""
    repeat with e in emails of p
      set emails to emails & (value of e) & ","
    end repeat
    set phones to ""
    repeat with ph in phones of p
      set phones to phones & (value of ph) & ","
    end repeat
    set out to out & (name of p) & "${US}" & emails & "${US}" & phones & "${RS}"
  end repeat
end tell
return out`;
  const res = await osa(script, 60_000, "Contacts");
  if (!res.ok) return failed(res.message);
  const list = rows(res.message);
  if (!list.length) return good(`No contact matching "${query}".`);
  return good(
    `${list.length} contact(s):\n${list
      .map(([name, emails, phones]) => `  ${name}${emails ? `\n    email: ${emails.replace(/,$/, "")}` : ""}${phones ? `\n    phone: ${phones.replace(/,$/, "")}` : ""}`)
      .join("\n")}`,
  );
}
