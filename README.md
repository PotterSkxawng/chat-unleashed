# Chat Unleashed

Chat Unleashed is a local MCP server that lets ChatGPT Chat use a Mac the way a person does: run
commands, read and write files, look at the screen, drive apps through their UI,
and reach the everyday apps (browser, Calendar, Reminders, Notes, Contacts,
Music). It is built for Chat, reaches the Mac through an OpenAI Secure MCP Tunnel,
and keeps every machine-specific detail on the machine.

Chat is where most work starts, and on its own it cannot touch the Mac. Work and Codex can act on a machine, and both draw on the shared agentic allowance. This connector closes that gap: the chat you already use can read files, run commands, drive apps and finish the job instead of describing the steps. Chat is not part of that shared allowance today, and its thinking is still unlimited, so the local agent runs on the Chat you already use.

The package is `local-agent-mcp`. The connector and the `chat-unleashed` command are the product surface.

Tool activity is recorded as JSON lines in the per-user application-data directory under `logs/audit.log`.

## Quickstart: Clone, Build & Run

Clone the repository and build the server executable right away:

```bash
# 1. Clone the repository
git clone https://github.com/PotterSkxawng/chat-unleashed.git
cd chat-unleashed

# 2. Install dependencies and compile
npm install
npm run build

# 3. Link CLI tool to your PATH
npm link

# 4. Run setup walkthrough
chat-unleashed setup
```

The build script compiles TypeScript with `tsc` and bundles the standalone executable into `dist/index.js` using `esbuild`.

---

## Chat Unleashed CLI

The connector is named **Chat Unleashed**, with **local mac** as its alias. The
`chat-unleashed` command is the terminal front end for it. It reads the machine
before it claims anything: the launchd jobs, the tunnel profile, the env file,
`/health`, `/readyz`, and a real MCP handshake.

```sh
chat-unleashed            # what is running, and the one next step
chat-unleashed setup      # guided install, skips every step already true
chat-unleashed doctor     # every check, with the fix for each failure
chat-unleashed connect    # prints exact connector settings for ChatGPT
local-mac                 # the same tool under its alias
```

| Command | What it does |
| --- | --- |
| `chat-unleashed` | Reads this Mac, the profile and both services, then names the next step. |
| `chat-unleashed setup` | Walks client, tunnel ID, runtime key, profile, server build and services. It creates a tunnel profile pointed at this server, keeps the key by reference, writes only what is missing, then waits for both services. `--check` prints the plan and writes nothing. |
| `chat-unleashed connect` | Prints the ChatGPT steps with your tunnel ID. `--open` opens the tunnel, key and connector pages. |
| `chat-unleashed doctor` | Four groups of checks with the failing detail and the exact fix under each failure. Exits 1 when something is broken, so it works in scripts. |
| `chat-unleashed status` | One line, or the full state with `--json`. |
| `chat-unleashed start` / `stop` / `restart` | Loads the launchd jobs, starts them, and waits for readiness. |
| `chat-unleashed logs [server\|tunnel\|launchd]` | Follows the matching log. |

## New machine, from nothing

ChatGPT cannot reach a server on your loopback interface. The supported path is an outbound Secure MCP Tunnel:

```text
ChatGPT -> OpenAI tunnel -> tunnel-client -> http://127.0.0.1:3344/mcp
```

1. Create a tunnel at [platform.openai.com](https://platform.openai.com/settings/organization/tunnels) and copy its ID, which starts with `tunnel_`.
2. Create a runtime API key at [API keys](https://platform.openai.com/settings/organization/api-keys) with Tunnels Read and Use. It is shown once.
3. Run `chat-unleashed setup` in a terminal and paste both. The key input is hidden and is never echoed.
4. Setup writes the tunnel profile for this server, stores the key at mode `0600`, installs the launchd jobs, starts the server, waits for the MCP handshake, starts the tunnel, and checks that the tunnel reports ready.
5. Run `chat-unleashed connect --open` and fill the connector form with these values:
   - Name: `Chat Unleashed`
   - Description: `Runs commands, reads and writes files, looks at the screen and drives apps on my Mac. Use it when a request needs work done on the local machine instead of only an answer.`
   - Connection: `Tunnel`
   - Tunnel: the ID from step 1
   - Authentication: `None`. The runtime key stays inside the tunnel on this Mac; ChatGPT never gets a token for the server.

   Save, refresh the tools in the connector details, then start a new chat and pick Chat Unleashed from the plus menu.
6. Grant macOS permissions when a tool first needs them: Accessibility, Screen Recording, Automation per app, and optionally Full Disk Access.

Chat is the surface this unlocks. Work and Codex act through the shared agentic allowance; Chat is not part of that pool today, so a chat that calls these tools gives you a local agent without spending it.

See [docs/CONNECT_CHATGPT.md](docs/CONNECT_CHATGPT.md) for the full walkthrough and what to do when a chat session goes stale.

Secrets never print. The runtime key is read from `~/.local/share/local-agent-mcp/.env.tunnel`
(mode `0600`) or from `CONTROL_PLANE_API_KEY`, and masked input is the only way
setup accepts it.

## Saved state

Saved settings are kept outside the published package at
`~/Library/Application Support/local-agent-mcp/config.json` on macOS
(`$XDG_CONFIG_HOME/local-agent-mcp/config.json` elsewhere, or
`$LOCAL_AGENT_MCP_HOME` when set). Tunnel credentials and profiles are stored separately by the tunnel client and must not be committed.

The file is created from defaults on first run, written atomically with mode
`0600`, and holds the device name, workspace/download/screenshot paths,
screenshot size and format, shell timeouts, the Computer Use plugin location and
any API keys you add. Change it with the `app_config` tool, the JSON API below, or
any editor: the server re-reads it on every tool call, so edits apply without a
restart, and typed values are validated instead of silently accepted. Secrets are
masked whenever settings are read.

### Local JSON API (for a desktop frontend)

With `--http` (loopback by default) the server also serves a small JSON API for a
settings UI. Loopback callers only.

| Route | Purpose |
| --- | --- |
| `GET /api/health` | process id and uptime |
| `GET /api/config` | current settings (secrets masked), file path, defaults |
| `PATCH /api/config` | merge a partial settings object |
| `PUT /api/config` | replace settings, filling gaps with defaults |
| `POST /api/config/reset` | restore defaults |
| `GET /api/status` | permissions, process identity, config path, version |
| `GET /api/diagnose` | the same diagnosis `mac_permissions` prints |
| `POST /api/permissions/request` | ask macOS for grants (`{"kinds":[...]}`) |
| `POST /api/permissions/open` | open the matching System Settings pane |

## Permissions

The server asks macOS for what it needs and names the exact binary that has to be
trusted, whatever launched it.

- **Accessibility** - read UI trees, click, type, arrange windows
- **Screen Recording** - screenshots with real pixels
- **Automation** - Apple Events to Calendar, Notes, browsers and the rest
  (per app, prompted on first use)
- **Full Disk Access** - optional, only for protected stores

`mac_permissions` reports each one; `action=request` triggers the OS prompts and
`action=fix` opens the right panes. Tools that need a grant say so in their error,
with the path to add.

## Tools

| Tool | What it does |
| --- | --- |
| `run_command` | Full terminal access. Runs any shell command with `cwd`, `timeoutSeconds` (default 60, max 600), optional `env`. Returns stdout, stderr, exit code (capped at 200 KB/stream). |
| `download_file` | Fetches an http(s) URL to disk (default `~/Downloads/<filename>`), follows redirects, 2 GiB cap, no silent overwrite. |
| `search_files` | Finds files by name (substring or `*` glob) and/or by content, skipping `node_modules`, `.git`, caches and `~/Library`. 20 s budget, partial results allowed. |
| `read_file` | Reads text files with `offset`/`limit`; returns images as images so the agent can see them; reports binary files. |
| `list_directory` | Lists a directory: type, size, modified time, dirs first. |
| `pages_status` | Diagnoses the Pages integration: app path/version, running state, Automation permission, open documents, optional template list. |
| `pages_create` | Writes a real `.pages` document from blocks (title/h1-h3/body/bullet/quote/code/...) with native Pages typography. |
| `pages_read` | Returns a document's full text plus a per-paragraph outline of index, point size and font. |
| `pages_inspect` | Format report: every paragraph's face/size/colour/bold-italic flags, plus each table's header fill, faces in use and header-marked grid. |
| `pages_styles` | `list` presets/families, `get` the stored default plus its resolved type scale, `set` a new default, `apply` restyle an existing document by inferred role. |
| `pages_replace` | Find-and-replace with explicit scope (document / paragraph / table / row / column / cell) and an explicit format mode. |
| `pages_edit` | Text and structure: `append`, `prepend`, `setBody`, `insertParagraph`, `replaceParagraph`, `insertText`, `deleteText`, `splitParagraph`, `mergeParagraphs`, `duplicateParagraph`, `moveParagraph`, `deleteParagraph`. |
| `pages_format` | Typography and colour: `paragraphs` (whole paragraphs), `characters` (a range inside each paragraph), `matches` (every occurrence of a string). |
| `pages_table` | Table values and structure: `setCell`, `setCells`, `format`, `insertRows`/`deleteRows`, `insertColumns`/`deleteColumns`, `merge`, `unmerge`, `sort`, `clear`, `resize`. |
| `pages_find` | Locates text across paragraphs and table cells, with a snippet and address for each hit. |
| `pages_stats` | Page, section, paragraph, word, character, table and object counts. |
| `pages_insert_image` | Places an image file as a real Pages image object (size, position, alt text, opacity). |
| `pages_insert_textbox` | Adds a floating text box (position, size, font, colour). |
| `pages_objects` | Lists floating objects (images, text boxes, shapes), or deletes one by index. |
| `pages_duplicate` | Copies a `.pages` package on disk - Pages is not involved at all. |
| `pages_verify` | Full-document integrity check: counts, typography in use, table structure, and problems (bad sizes, missing fonts, ragged tables, blank-paragraph runs). Built for 20+ page documents. |
| `iwork_apps` | Which iWork apps are installed/running, their versions, and every open document. |
| `iwork_document` | Overview of any Pages/Numbers/Keynote document: counts of paragraphs, pages, sheets, slides, tables, shapes, images, charts, movies. |
| `iwork_shapes` | List, add, move, resize, rotate, recolour or delete shapes in any iWork app. |
| `iwork_export` | Export through the owning app's exporter: pdf/txt/rtf/epub/docx, xlsx/csv, pptx/html/movie/images. |
| `iwork_script` | Escape hatch: run AppleScript against an iWork app with `doc` pre-bound. `close`/`quit` are refused. |
| `numbers_sheets` | List, add, delete, rename or activate sheets in a `.numbers` document. |
| `numbers_tables` | Table structure: add/delete/resize, native add-row-above/below and add-column-before/after, transpose, sort, merge/unmerge, format. |
| `numbers_cells` | Read/write cells by A1 reference, including 2D range writes and live `=` formulas. |
| `keynote_slides` | List, add, delete, duplicate and reorder slides; list the document's named layouts. |
| `keynote_content` | Set a slide's title/body through its placeholders, or add a text box, image or table. |
| `keynote_notes` | Read and write presenter notes. |
| `keynote_show` | Start, stop, step through or jump within a slideshow. |
| `mac_apps` | List apps with a UI, report the frontmost app, activate/launch/hide. No `quit` by design. |
| `mac_ui` | System Events: list windows, click menu items, send keystrokes, focus an app. |
| `mac_system` | Clipboard, notifications, volume/mute, battery, disk, uptime. |
| `mac_finder` | Reveal, open, inspect or Trash a path. Trash is the only removal offered. |
| `mac_shortcuts` | List and run the user's Shortcuts, optionally with a file input. |
| `pages_export` | Exports through Pages' own exporter to PDF, txt, RTF, EPUB or Word. |

## Pages (native)

The `pages_*` tools drive the actual Pages app over Apple Events. There is no
Word, no docx and no conversion step anywhere in the path - a document created
here is a normal `.pages` file that opens, edits and exports like any other.

Two rules are baked into the implementation:

- **Documents are never closed and Pages is never quit.** Anything the tools
  create is saved and left open for you.
- **No third-party format is used as an interchange layer.** Content goes
  straight into Pages' rich-text model.

Because Pages' scripting dictionary exposes font/size/color but not paragraph
styles, `format: "styled"` maps each block type onto a concrete font + size +
color instead of naming Heading 1. Pass `format: "plain"` (the default when you
supply a `template`) to leave the template's own paragraph styles in charge.

### What an edit preserves

Every editing op falls into one of three buckets, and knowing which is which is
the difference between a clean edit and a mangled document.

**Never rewrites anything it was not pointed at.** `append`, `prepend`,
`insertParagraph`, `deleteParagraph`, `duplicateParagraph`, `moveParagraph` and
`pages_table`'s structural ops work on real paragraph and cell objects. Every
other paragraph keeps its runs, including bold/italic *inside* the text.

**Rewrites one paragraph, keeps its look.** `replaceParagraph`, `insertText`,
`deleteText`, `splitParagraph` and `mergeParagraphs` set the paragraph's
contents and leave its font, size and colour alone. The paragraph looks the same
afterwards - but any character-level formatting *inside* that one paragraph
(a bold phrase mid-sentence) is flattened, because the text is being replaced
wholesale. Everything outside the paragraph is untouched.

**Formats without touching text.** `pages_format` and `pages_replace` never
change what a paragraph looks like except in the way you asked for.
`pages_format` can address a character range (`op: "characters"`) or every
occurrence of a string (`op: "matches"`), which is how you bold a term
everywhere without disturbing the rest of the paragraph.

`setBody` is the one op that rebuilds the whole body from plain text. Treat it
as the "start over" escape hatch, not the default.

### Editing without wrecking formatting

`pages_replace` is deliberately *narrow*: it only rewrites the units you point
it at, and never rebuilds the body.

- **scope** - `document` (all paragraphs + all cells), `paragraph` (one index),
  `table`, `row`, `column`, `cell`. Table scopes take `table`, `row`, `col`.
- **keepFormat** - `true` (default) re-applies the paragraph's own face, size
  and colour after the rewrite; `false` lets the paragraph's style default take
  over. Table cells keep their formatting either way: only the cell *value* is
  written, so fill, borders and alignment survive.

### Inserting text without disturbing the neighbours

Pages has no "insert paragraph at index N" command. The workaround is to splice
into the anchor paragraph's own contents (`anchorText & linefeed & newText`),
which creates the new paragraphs *in place* and lets the anchor keep its
formatting. `insertParagraph` and `prepend` both work this way, so an insert in
the middle of a styled document does not reset the paragraphs around it.

One consequence: the anchor paragraph is rewritten, so inline runs inside that
single paragraph are flattened. If that matters, anchor to an empty paragraph or
use `append`.

### Default styles

`pages_styles` owns a persisted default at
`~/.config/local-agent-mcp/pages-style.json`. `set` writes it; `pages_create`
picks it up whenever no `style` is passed, so "the look of new documents" is a
machine setting rather than a per-call argument. `get` prints the resolved type
scale so you can see exactly what each role will become.

`apply` restyles an existing document: it infers each paragraph's role from its
size relative to the document's dominant body size (and from italic/mono faces),
then rewrites font, size and colour per role, leaving every character of text
alone. The heuristic is size-based, so a document with unusual proportions can
be misread - `pages_inspect` first, then `pages_format` for surgical fixes.

### Styles

`style` takes a preset name - `classic`, `serif`, `modern`, `compact` - or an
object of overrides (`family`, `baseSize`, `accent`, `muted`, `headerFill`,
`headerText`, `zebra`). Families: `helvetica-neue`, `georgia`, `avenir-next`,
`palatino`, `times`. Every size is derived from `baseSize` through a fixed type
scale, so one number re-proportions the whole document.

### Tables

A `table` block builds a real Pages table: `header` (creates a true header row),
`rows`, `headerColumn`, per-column `align`, `columnWidths`, and `zebra`. Tables
must be the **last** blocks, because Pages cannot insert an inline table
mid-flow and reordering content silently would be worse than refusing.

Existing tables are edited in place with `pages_table`:

- **values** - `setCell` (one cell, plus `font`, `size`, `color`, `bold`,
  `italic`, `fill`, `align`), `setCells` (a rectangular grid at once). Writing a
  value resets the run to the table's body style, so the cell's own face, size
  and colour are captured first and written back afterwards - a value edit does
  not quietly restyle the cell.
- **structure** - `insertRows`/`deleteRows`, `insertColumns`/`deleteColumns`,
  `merge`, `unmerge`, `resize`, `clear`, `sort` (by column, ascending or
  descending).
- **formatting** - `format` with `font`, `size`, `color`, `fill`, `align`,
  `verticalAlign`, `wrap`, `headerRows`, `headerCols`, `footerRows`,
  `columnWidths`, `rowHeights`. Omit `rows`/`cols` to format the whole table.

`bold`/`italic` work by swapping to the matching face of the cell's *current*
family, so a Georgia cell stays Georgia when you bold it. Row and column
inserts shift *values*, not cell formatting: the cell keeps its own styling and
the data moves into it.

Set a cell value beginning with `=` to write a formula (`=SUM(B2:B5)`); Pages
evaluates it, and `pages_inspect` will report the computed value afterwards.

### What Pages does not expose

Worth knowing before you promise something the dictionary cannot do. Pages'
scripting interface covers font, size, colour, cell fill, cell alignment, table
geometry and object placement. It does **not** expose, for body text:

- paragraph alignment (left/centre/right/justify)
- line spacing, paragraph spacing, tabs, indents
- text highlight / background colour behind a run
- paragraph styles by name (which is why `format: "styled"` maps block types
  onto concrete font + size + colour instead of naming "Heading 1")

Table cells *do* have alignment and vertical alignment, so use a table when you
need centred or right-aligned content.

### Large documents

Reading used to cost four Apple Events *per paragraph* - a 20-page document
meant thousands of round trips, and the output string was built with quadratic
concatenation. Both are gone:

- **Bulk property reads.** `font of every paragraph`, `size of every paragraph`,
  `color of every paragraph` and `contents of every paragraph` each come back in
  a single event, so a long document is read in a handful of round trips. If any
  coercion fails the code falls back to the per-paragraph loop automatically.
- **One join at the end.** Records are accumulated in a list and joined once
  with `text item delimiters`, instead of `out & ...` inside the loop.
- **Argument-size safety.** `osascript -e` is bounded by the kernel's argument
  limit, so any script over ~60 KB is written to a temp file and run from there.
  Large `setBody`/`append` payloads no longer fail with "argument list too long".
- **Timeouts scale with the document** rather than cutting a long read off.

`pages_verify` is the companion tool: point it at a 20-page document and it
reports counts, the typography actually in use, table structure, and any
structural problems - implausible point sizes, missing fonts, empty or ragged
tables, runs of blank paragraphs, merged cells that cannot be addressed. Pass
`expectParagraphs` / `expectTables` to assert an exact structure.

### Running in the background

The Pages tools never bring Pages to the front. Nothing in the generated
AppleScript calls `activate`; every edit is sent as an Apple Event to the
running app, so the document is modified while you keep working in whatever
window you are actually using.

The single exception is opening a document that is not already open - macOS
raises the app for that. When it happens the script remembers which app had
focus and hands it straight back, so even that case does not leave you looking
at Pages.

Verified mechanically: of the 34 scripts the Pages suite generates, zero contain
`activate`. The only scripts in the whole server that do are the four Keynote
slideshow commands and Finder's `reveal`/`open`, where taking the screen is the
point.

## Numbers

Numbers is not Pages with a grid. Three differences matter, and the tools are
built around them:

- **Content lives on sheets.** `numbers_sheets` addresses them; every table and
  cell operation takes `sheet` (default 1).
- **Cells have A1 names.** `numbers_cells` speaks `B4` and `A1:C10` rather than
  row/column indices, and `get` renders the result as a grid.
- **Structure is native.** Numbers exposes `add row above`, `add row below`,
  `add column before`, `add column after`, `transpose`, `sort`, `merge` and
  `unmerge` as real commands. Pages tables needed value-shifting workarounds;
  Numbers does not, so rows and formulas move correctly.

Values are typed by shape: `42` is stored as a number, `true` as a boolean,
`=SUM(B2:B5)` as a live formula, anything else as text.

## Keynote

A slide's text lives in two placeholder shapes - `default title item` and
`default body item`. `keynote_content` writes through those, which keeps the
theme's typography; dropping a text box on top would look wrong on every theme.
If a layout has no title placeholder the tool says so instead of silently
creating an orphan text box.

Reordering is copy-then-delete, because Keynote exposes `duplicate ... to
<location>` but no plain `move`. Both halves run in one script so the document
never sits in a half-moved state.

`keynote_show` drives a real presentation - `start`, `goto`, `next`,
`previous`, `stop`. It activates Keynote, because that is what presenting means.

## Cross-app iWork

Pages, Numbers and Keynote share one object model: documents hold shapes,
images, text items, tables, charts, movies and lines, and each is an `iWork
item` with position, width, height, rotation and opacity. The only real
difference is where content lives:

| App | Content container |
| --- | --- |
| Pages | the document (body text, sections, pages) |
| Numbers | sheets, each holding tables |
| Keynote | slides |

`iwork_shapes`, `iwork_export` and `iwork_document` are written once against
that shared model. Pass `path` and the app is inferred from the extension
(`.pages`, `.numbers`, `.key`); pass `app` to use the frontmost document.

`iwork_script` is the escape hatch for anything the structured tools do not
cover: your AppleScript runs inside the target app with `doc` already bound.
Scripts containing `close` or `quit` are refused - the never-close rule is
enforced, not just documented.

## Computer use

Seeing and driving the machine itself. These are the tools to reach for when an
app has no scripting interface, or when the point is what is on screen.

| Tool | What it does |
| --- | --- |
| `screen_capture` | Screenshot of a display, window or region, returned as an image the model can see (and saved to disk). Optional downscaling keeps tokens sane. Needs Screen Recording. |
| `window_list` | Every on-screen window with id, app, title, bounds and layer. No permission needed. |
| `ui_tree` | An app's accessibility tree as text: roles, titles, values, positions, actions, and a path per node. |
| `ui_find` | Search that tree by label text or role and report where each match is. |
| `ui_act` | Press/confirm/open-menu/focus/raise an element, or set its value - by label, at any depth. More reliable than clicking coordinates. |
| `mouse` | Move, click, double/right/middle click, drag, scroll the real pointer. |
| `keyboard` | Type text, press named keys, or send shortcuts like `command+shift+t`, optionally activating the app first. |
| `window_control` | Focus, move, resize, minimise, restore, zoom, fullscreen, tile left/right. |
| `app_control` | List apps, read the frontmost one, activate, launch, hide, show, quit gracefully, relaunch, force quit. |

## System, workflow and everyday apps

| Tool | What it does |
| --- | --- |
| `system_info` | OS, chip, memory pressure, swap, load, uptime, disk, power, battery, thermal, top processes. |
| `process_list` / `process_control` | Top processes by cpu/memory; signal, stop, continue or renice one (never this server or its parents). |
| `network_info` | Interfaces and addresses, gateway, Wi-Fi, DNS, listening ports. |
| `power` | Lock, display sleep, sleep, keep awake with caffeinate for N minutes, allow sleep again. |
| `audio` / `speak` / `media` | Volume, mute, speech, and Music/Spotify transport + now playing. |
| `shell_session` | A persistent shell: start, run and read across calls, write to a running program, Ctrl-C, stop. Keeps dev servers and REPLs alive between turns. |
| `wait_for` | Poll until a file appears/changes, a port opens, a URL answers, a process/app runs, or a window title matches. |
| `file_ops` | Move, copy, mkdir, symlink, `du`, zip/tar create and extract, touch, open with a specific app. Refuses to overwrite unless asked; never deletes. |
| `spotlight` / `recent_files` | `mdfind` by name, content, kind or recency; what changed under a folder in the last N hours. |
| `browser` | Tabs with titles and URLs, open a URL, read the active page's text, front tab, close a tab (Safari/Chrome/Edge/Brave/Arc). |
| `calendar` / `reminders` / `notes` / `contacts` | Read and add events, reminders and notes; look people up. Nothing is ever deleted. |
| `app_config` | Read and edit this machine's saved settings. |
| `mac_permissions` | Report, request and open the panes for macOS permissions. |

## Durable tasks

A task is a plan on disk, not a plan in a conversation. `task_plan` writes it,
`task_run` executes the steps that can run now, and every step has to be proven
by a check before it counts as done.

| Tool | What it does |
| --- | --- |
| `task_plan` | Records a goal, success criteria (each with the check that proves it) and ordered steps that name the tool they run. |
| `task_run` | Runs the runnable steps, verifies each one, and writes progress after every step. |
| `task_next` | The next step, or the approval that is holding the task up. |
| `task_status` | Steps, evidence, criteria results and the recent log. Without an id it lists every open task. |
| `task_resume` | Reads the task back from disk, re-checks the criteria, and reports where the work stopped. |
| `task_steer` | Note, insert, skip or re-queue a step mid-run. |
| `task_approve` | Clears the gate on a step that changes something outside the project. |
| `task_close` | Re-runs the criteria and refuses to close while anything lacks evidence. |

Three rules make the stored state trustworthy:

- **Executed is not verified.** A step with no `verify` check ends `unverified`.
  A task with an unmet criterion cannot close as done unless `task_close force`
  writes the gap into the reason.
- **Evidence belongs to a definition.** Editing a verified step clears its proof
  and puts it back in the queue, because the old check proved the old command.
- **Approval is a stored decision, not a conversation.** Steps that run `rm`,
  `sudo`, `git push`, force flags or shutdown wait until `task_approve` records
  a timestamp for that exact step.

Checks cover a shell command and its output, a file that exists or does not,
a window title, interface text, another tool call, and polling with `wait`. The
same vocabulary verifies a step and tests a success criterion.

Everything lives in `<appHome>/tasks/<id>.json` with an append-only
`<id>.jsonl` action log, so a run survives a dropped conversation, a new client,
or a restart of this server. Long work can run with no client attached:

```bash
node dist/index.js --run-task task_ab12cd34 --max-steps 10
```

That entry point loads the same plan, runs what can run, prints the report, and
exits non-zero when a step failed or another process holds the lock.

## Screen control

Two tools replace guessing at coordinates.

| Tool | What it does |
| --- | --- |
| `screen_observe` | One call that answers what is on screen: front app, window title and bounds, every display with its Retina scale, the accessibility tree, and the states that change what to do next (dialog, permission prompt, loading, open menu), plus an optional screenshot and a hash of it. `context: true` adds the trail of apps and windows this session already observed. |
| `ui_do` | Resolves an element by name, role or identifier, picks the most reliable method the app supports, performs it, then looks again and reports what changed. Ambiguous matches are reported with their scores so the caller can pass an index or a role. `resume: true` continues with the app last observed instead of the frontmost one. |

A window that exists but is not drawn is reported as such, which is how a
minimized window or one on another Space shows up instead of as an element that
cannot be found. The context trail is kept on disk across calls, so a workflow that
moves between Pages, Numbers and Finder does not have to re-establish where it was.

The method ladder is the point. In order:

1. **Accessibility action** when the element exposes a press, because it survives a
   window moving, a display changing scale or a Space switch.
2. **Menu shortcut** when the app binds the intent (`save`, `find`, `print`) to
   keys, which needs no target at all.
3. **Scripting command** when the app is scriptable and answers the intent
   directly, such as `make new document` in Pages.
4. **Pointer click** on the element's current center, only when nothing above is
   available, and always verified afterwards.

A click that changes nothing is reported as `verified: no` rather than as success.
Pixel-only change is labelled as weak evidence. Focus drift and a window moving
under a click get one automatic retry at the new bounds, and no more than one.

## Documents

| Tool | What it does |
| --- | --- |
| `doc` | `qa` reads the exported PDF page by page and reports blank pages, text outside the page box, text pushed to the bottom edge and text boxes stacked on top of each other. Overlap detection groups characters into lines by baseline and only calls a real overlap when two boxes intersect a couple of points deep in both directions, so an italic overhang or a superscript is not reported. `compare` reports per page whether the text changed and whether the rendering changed. `backup`, `backups` and `restore` give an edit run a way back. |

The document model says a paragraph exists; the page says whether it fits. Tasks
can require a clean render with a `pdf` check, which is how a compile and verify
loop refuses to call a document finished while a page is clipped.

## Coding

| Tool | What it does |
| --- | --- |
| `code_index` | `build` indexes every function, type, class, protocol and Metal kernel with its file and line; `find` searches those declarations; `summary` reads manifests, test layout, git state and TODO count. |
| `code_loop` | `run` executes acceptance commands and reports exactly which ones failed, keeping a history per goal; `resources` reports load, free memory and swap; `profile` samples a running process with the system sampler and returns the frames carrying the most samples; `crashes` reads recent crash reports with the top frames of the failing thread. |
| `bench` | Records samples by channel (kernel, model, end_to_end, memory) and only compares like with like, so a kernel microbenchmark is never averaged with a full model run. |
| `git_work` | `status`, `diff`, `stage`, `unstage`, `commit`, isolated worktrees on their own branch, and checkpoints. `checkpoint` snapshots the whole working tree, untracked files included, through a throwaway index, so the real index and the files on disk are untouched and nothing has to be stashed. `restore_checkpoint` first checkpoints whatever is on disk, then makes the tree match the checkpoint exactly, so a restore cannot be the step that loses work. |

`code_loop` is the goal engine: it runs the acceptance commands, prints the failing
output and records the iteration. It records the machine's resource state with
every run, because a benchmark taken at load 200 on eight cores measures the
thermal state, not the code.

## Browser

| Tool | What it does |
| --- | --- |
| `web` | Structured control of a Chromium browser through the DevTools protocol: tabs, navigation, DOM outline with stable element ids, locators (`css=`, `text=`, `role=`, `label=`, `id=`, `xpath=`), click, type, text, screenshots, console and network capture, waiting, evaluation, downloads, and page snapshots for change detection. `changes` diffs the current text against the stored snapshot line by line and prints what appeared and disappeared. `download` sets the download folder, clicks the link that offers the file and waits for the partial file to finish; `downloads` lists what arrived. |

Clicks and typing are verified against the url and the page text. The browser is
started with its own profile, separate from the one the person is signed into, so a
page that needs their session has to be signed into once in that profile. Without a
Chromium, `engine=safari` gives tab listing, navigation and page text, and says what
else is unavailable instead of pretending.

## Skills

| Tool | What it does |
| --- | --- |
| `skill` | `save` a workflow with trigger phrases, steps and acceptance criteria; `list` and `show`; `match` routes a request to the skills whose phrases appear, ranked by measured success rate; `compile` turns a skill into a durable task; `report` records a finished task's verdict against it; `seed` writes the builtin skills for Swift packages, Metal kernels, MLX models and Apple silicon measurement. |

Success rates are Laplace smoothed, so a new skill is not punished for having no
history and one lucky run does not read as certainty. A compiled skill is a task,
which means it inherits retries, checkpoints, approval gates and evidence.

## System automation

`mac_*` tools cover the parts of a Mac that are not documents:

- **`mac_apps`** - what is running, what is in front, activate/launch/hide.
- **`mac_ui`** - System Events: windows, menu clicks, keystrokes. This is the
  long tail for apps with no scripting interface, and it needs **Accessibility**
  permission in addition to Automation. The error message tells you where.
- **`mac_system`** - clipboard text, notifications, volume, battery, disk,
  uptime.
- **`mac_finder`** - reveal, open, inspect, Trash.
- **`mac_shortcuts`** - list and run Shortcuts, optionally with a file input.
  Prefer this over UI scripting when a shortcut exists.

The `mac_apps` and `mac_finder` convenience tools favor explicit app activation
and recoverable Trash operations. Other tools have broader authority:
`app_control` can quit or force-quit applications, and shell access can modify or
delete files. Restrict which agents can connect and review the per-user audit log.
`iwork_apps` only queries already-running apps and does not launch them.

### One-time permission

macOS blocks Apple Events until the host app is granted Automation access. The
first call raises a prompt; if it was declined, every call returns `-1743` /
`-10004` and `pages_status` prints the exact System Settings path plus the
process chain, so you know which app to authorise:

**System Settings → Privacy & Security → Automation → [host app] → Pages → on**

Pages is addressed by bundle id (`com.apple.Pages`) rather than by name, so a
renamed copy of the app still works.


## Install and validate

Requires an Apple Silicon Mac with Node.js 20.11.1 or newer. Run from a checkout or unpacked package:

```bash
npm install
npm run build
npm run smoke:portability
npm run validate:release
```

`npm run build` typechecks and bundles the current source in `dist/`; it does not deploy or restart the running service. `npm run deploy:local` installs the bundle atomically into `~/.local/share/local-agent-mcp/dist/`, retaining the previous installed file as `index.js.previous` when one exists. Deploying the file does not replace the code already loaded by a running Node process. Do not restart a tunnel carrying an active chat merely to update the bundle.

A checkout with Git metadata enables Git-aware `project_context` and `project_review` features. A source copy without `.git` can still build and run, but those review features cannot inspect history or diffs.

## Connect ChatGPT through the Secure MCP Tunnel

Normal ChatGPT sessions do not connect directly to `localhost` on your Mac. The remote architecture is:

```text
ChatGPT -> OpenAI Secure MCP Tunnel -> tunnel-client -> local-agent-mcp
```

The recommended private local target is the Streamable HTTP endpoint on `127.0.0.1`:

```bash
npm run http
curl --fail http://127.0.0.1:3344/health
```

Use `tunnel-client init --help` to generate a profile for **your own** tunnel ID and endpoint, selecting `--mcp-server-url http://127.0.0.1:3344/` for an HTTP-backed tunnel. The profile belongs in the tunnel client's user configuration directory. Refer to your tunnel provider's connection flow for the control-plane key and ChatGPT plugin binding. Never commit a real tunnel ID, credential, private profile or LaunchAgent environment file to the package.

A correctly supervised tunnel can run with a user-specific LaunchAgent. Provide credentials through a protected environment or secret file (mode `0600`) and keep application-data directories restricted to the current user. The installer does not currently create the tunnel or register a LaunchAgent automatically; those are separate setup steps. The default HTTP endpoint is loopback only and must not be exposed directly to a network or public reverse proxy.

Stdio MCP remains supported for compatible clients, including local CLIs. If a stdio tunnel reports `MCP server is not initialized`, consult the initialization-specific troubleshooting guidance before changing transports. The `MCP_STDIO_SEND_INITIALIZED_NOTIFICATION` option is specific to `tunnel-client`; it is not required for HTTP-backed targets.

See [Connection and runtime troubleshooting](docs/TROUBLESHOOTING.md) for diagnosing `Session terminated`, missing tunnel credentials, server exits, 503/413 responses, permissions, app discovery and browser CDP issues.

## Deferred updates without cutting off ChatGPT

After validating a candidate, `npm run update:install` registers an independent
per-user launchd watcher and `npm run update:stage` stages the bundle by hash.
The watcher only activates it after at least 20 minutes without observed
local/remote tool traffic. Only the separately supervised HTTP MCP server is
restarted; the Secure MCP Tunnel stays alive. A watchdog cannot prove that an
idle ChatGPT session has disconnected, so a request arriving during the small
restart window may still need retrying. Failed health checks trigger a rollback.

See [Deferred updates](docs/DEFERRED_UPDATES.md) for the idle criteria, staging,
rollback, status and cancellation commands.

## Optional dependencies

Pages/Numbers/Keynote are needed for their native document tools. A supported Chromium-family browser and debugging target are needed for CDP automation. Python, MLX, Metal development tools, and Homebrew are optional and discovered at runtime when present. Features that rely on them should report a missing dependency instead of assuming an exact installation path or chip generation.

The package currently declares `UNLICENSED`; select and add a redistribution license before presenting it as open source. Chat acts during the turn: it can call tools, read the results and keep going until the answer is done, but it does not keep working after the turn ends. Work and Codex provide that background loop. This connector is local reach for Chat, not a second scheduler.

## Audit log

The audit history is stored under the per-user application-data root. With the default macOS configuration:

```bash
tail -f "$HOME/Library/Application Support/local-agent-mcp/logs/audit.log"
```

Setting `LOCAL_AGENT_MCP_HOME` changes the application-data root. The audit log may contain file paths, command arguments and tool summaries: treat it as sensitive local history and exclude it from release archives.

## Security notes

- No built-in HTTP authentication - the endpoint is loopback-only and rejects foreign Host/Origin headers. Do **not** pass
  `--host 0.0.0.0` and do not port-forward it.
- The tools have full user-level permissions: anything your account can do, the
  connected agent can do. The audit log is your accountability trail, not a guardrail.
- ChatGPT's replies can be manipulated by content it reads on this machine
  (a webpage or file telling it to run a command). Treat the audit log as
  must-review after agent sessions, and run it as a non-admin user if you want a
  harder ceiling.
- Disconnect or disable the ChatGPT connector to revoke ChatGPT access. Stop the tunnel for an immediate remote cutoff; stopping only the local HTTP process does not revoke tunnel credentials. Keep audit history private.

## Development

```bash
npm run stdio   # stdio transport
npm run http    # Streamable HTTP on 127.0.0.1:3344
npx tsc -p tsconfig.json --noEmit   # typecheck
```