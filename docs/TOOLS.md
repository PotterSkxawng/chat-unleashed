# Tool reference

Chat Unleashed exposes 90 MCP tools directly in Public Beta 2 while preserving all 114 Public Beta 1 capabilities. Twenty-six long-tail iWork capabilities are deferred behind the capability bridge, so their schemas are loaded only when needed. This file is the compact catalog; focused references cover behavior that needs more detail.

## Deferred capability bridge

`capability_search` searches the deferred specialist catalog by intent and returns the exact capability name, description, risk level and JSON argument schema. `capability_call` invokes that exact hidden handler. The underlying implementations are unchanged and remain directly addressable by durable tasks and skills.

Deferred in Public Beta 2: `pages_inspect`, `pages_verify`, `pages_styles`, `pages_find`, `pages_stats`, `pages_objects`, `pages_duplicate`, `pages_text_layout`, `pages_document_layout`, `pages_section_layout`, `iwork_ui_control`, `iwork_arrange`, `iwork_apps`, `iwork_document`, `iwork_shapes`, `iwork_script`, `numbers_inspect`, `numbers_verify`, `numbers_find`, `numbers_stats`, `keynote_notes`, `keynote_inspect`, `keynote_verify`, `keynote_find`, `keynote_stats`, and `keynote_image_slides`.

## Tools

| Tool | What it does |
| --- | --- |
| `capability_search` | Finds deferred specialist capabilities by plain-language intent and returns their exact argument schema. |
| `capability_call` | Calls one exact capability returned by `capability_search`; public tools remain directly callable. |
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

## iWork

Pages, Numbers, and Keynote use native Apple Events and edit real iWork documents. The catalog above lists the individual tools; [IWORK.md](IWORK.md) explains formatting preservation, Pages table behavior, Numbers formulas and ranges, Keynote placeholders, background editing, scripting limits, and iWork permissions.

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

The task state follows three rules:

1. A step without a `verify` check ends as `unverified`. An unmet success criterion blocks normal closure; `task_close force` records the gap in the reason.
2. Editing a verified step clears its existing evidence and returns the step to the queue because the old check proved the old definition.
3. `task_approve` stores approval on the exact step. Commands involving `rm`, `sudo`, `git push`, force flags, or shutdown wait for that recorded decision.

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
cannot be found. Chat Unleashed keeps the context trail on disk across calls, so a workflow that
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
| `code_index` | `build` indexes every function, type, class, protocol and Metal kernel with its file and line; `find` searches those declarations; `summary` reads manifests, test layout, git state and unfinished-marker count. |
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

Chat Unleashed verifies clicks and typing against the URL and page text. Browser
automation starts with its own profile, separate from the one the person is signed
into, so a page that needs their session must be signed into once in that profile. Without a
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

`mac_*` tools cover the parts of a Mac that are not documents.

| Tool | Purpose |
| --- | --- |
| `mac_apps` | Report running/frontmost apps and activate, launch, or hide an app |
| `mac_ui` | Work with windows, menu items, and keystrokes through System Events |
| `mac_system` | Clipboard text, notifications, volume, battery, disk, and uptime |
| `mac_finder` | Reveal, open, inspect, or move a path to Trash |
| `mac_shortcuts` | List and run Shortcuts, optionally with a file input |

`mac_ui` needs Accessibility permission in addition to Automation. Prefer `mac_shortcuts` over UI scripting when an existing shortcut already expresses the action.

The `mac_apps` and `mac_finder` convenience tools favor explicit app activation
and recoverable Trash operations. Other tools have broader authority:
`app_control` can quit or force-quit applications, and shell access can modify or
delete files. Restrict which agents can connect and review the per-user audit log.
`iwork_apps` only queries already-running apps and does not launch them.

For iWork-specific Automation permission behavior, see [IWORK.md](IWORK.md#permissions).
