# iWork automation reference

Chat Unleashed drives Pages, Numbers, and Keynote through their native Apple Events interfaces. The structured tools edit real iWork documents instead of converting through Word, Excel, or PowerPoint formats.

The general tool catalog lives in [TOOLS.md](TOOLS.md). This document covers the editing behavior that matters when an agent changes an iWork file.

## Shared iWork tools

| Tool | Purpose |
| --- | --- |
| `iwork_apps` | Report installed/running iWork apps, versions, and open documents |
| `iwork_document` | Summarize a Pages, Numbers, or Keynote document |
| `iwork_shapes` | List, add, move, resize, rotate, recolor, or delete shapes |
| `iwork_export` | Export through the owning app's native exporter |
| `iwork_script` | Run AppleScript with the current document pre-bound as `doc` |

`iwork_script` refuses scripts containing `close` or `quit`. Structured iWork operations leave documents open.

## Pages

The `pages_*` tools address the native Pages document model. A file created with `pages_create` is a normal `.pages` document.

### Editing behavior

Different operations preserve different amounts of formatting.

| Operation type | Tools | What stays intact |
| --- | --- | --- |
| Structural paragraph/cell edits | `append`, `prepend`, `insertParagraph`, `deleteParagraph`, `duplicateParagraph`, `moveParagraph`, structural `pages_table` operations | Other paragraphs and cells, including their inline runs |
| Single-paragraph text rewrites | `replaceParagraph`, `insertText`, `deleteText`, `splitParagraph`, `mergeParagraphs` | Paragraph-level font, size, and color; inline formatting inside the rewritten paragraph can flatten |
| Formatting-only edits | `pages_format`, formatting modes of `pages_replace` | Text content |
| Whole-body replacement | `setBody` | Rebuilds the body from plain text; use it only when a full reset is intended |

`pages_replace` works within an explicit scope: document, paragraph, table, row, column, or cell. With `keepFormat: true`, paragraph face, size, and color are restored after the rewrite. Table value edits keep cell formatting.

### Inserting paragraphs

Pages does not expose a direct "insert paragraph at index" AppleScript command. Chat Unleashed inserts text at an anchor paragraph and adds line breaks in place.

That keeps surrounding paragraphs where they are and preserves their formatting. The anchor paragraph itself is rewritten, so inline runs inside that paragraph can flatten. Use an empty anchor or `append` when inline runs must survive.

### Styles

`pages_styles` stores the default document look at:

```text
~/Library/Application Support/Chat Unleashed/pages-style.json
```

`pages_create` uses that default when no `style` is supplied.

A style can be one of the built-in presets (`classic`, `serif`, `modern`, `compact`) or an object with overrides such as `family`, `baseSize`, `accent`, `muted`, `headerFill`, `headerText`, and `zebra`.

Pages' scripting dictionary exposes font, size, and color, but not paragraph styles by name. With `format: "styled"`, Chat Unleashed maps block roles onto concrete typography. With `format: "plain"` and a template, the template remains responsible for its own paragraph styles.

`pages_styles apply` infers paragraph roles from the document's size hierarchy and face. Inspect unusual documents first with `pages_inspect`; the role inference is intentionally heuristic.

### Tables

A `table` block in `pages_create` creates a native Pages table. Because Pages cannot insert an inline table at an arbitrary body position, table blocks must come last.

`pages_table` can change values, structure, and formatting:

| Area | Operations |
| --- | --- |
| Values | `setCell`, `setCells` |
| Structure | `insertRows`, `deleteRows`, `insertColumns`, `deleteColumns`, `merge`, `unmerge`, `resize`, `clear`, `sort` |
| Formatting | font, size, color, fill, alignment, vertical alignment, wrapping, header/footer rows, column widths, row heights |

When a cell value changes, Chat Unleashed captures and reapplies the cell's face, size, and color. Bold and italic changes stay within the cell's current font family.

A value beginning with `=` becomes a formula. `pages_inspect` reports the computed value after Pages evaluates it.

### Pages scripting limits

The Pages AppleScript dictionary does not expose every text-layout property.

For body text, it does not expose:

- paragraph alignment
- line or paragraph spacing
- tabs and indents
- text highlight/background color
- paragraph styles by name

Table cells do expose horizontal and vertical alignment.

### Large documents

Long Pages documents avoid per-paragraph round trips where possible. Font, size, color, and contents can be requested in bulk, then joined locally.

For large AppleScript payloads, Chat Unleashed writes a temporary script file instead of passing the full payload through `osascript -e`. Timeouts also scale with document size.

`pages_verify` checks document counts, typography, table structure, blank-paragraph runs, implausible point sizes, missing fonts, ragged tables, and merged-cell cases that cannot be addressed normally. `expectParagraphs` and `expectTables` can enforce an expected structure.

### Background behavior

Pages editing scripts do not call `activate`, so edits can run while another app remains frontmost.

Opening a document that is not already open can temporarily raise Pages. Chat Unleashed records the previous frontmost app and returns focus after the open.

## Numbers

Numbers content lives inside sheets and tables.

| Tool | Purpose |
| --- | --- |
| `numbers_sheets` | List, add, delete, rename, or activate sheets |
| `numbers_tables` | Add, delete, resize, transpose, sort, merge, unmerge, or format tables |
| `numbers_cells` | Read and write cells or ranges using A1 notation |

`numbers_cells` accepts references such as `B4` and `A1:C10`. A rectangular write can set a full 2D range in one operation.

`numbers_cells` stores values by shape: numeric input as a number, booleans as booleans, strings beginning with `=` as live formulas, and other strings as text.

Numbers exposes native row and column insertion commands. Rows, columns, and formulas therefore move through the document model instead of being simulated by shifting values.

## Keynote

Keynote slide text normally belongs in the theme's title and body placeholders. `keynote_content` writes through those placeholders so the presentation keeps its theme typography.

| Tool | Purpose |
| --- | --- |
| `keynote_slides` | List, add, delete, duplicate, reorder slides, and list layouts |
| `keynote_content` | Set title/body placeholders or add text boxes, images, and tables |
| `keynote_notes` | Read or write presenter notes |
| `keynote_show` | Start, stop, step through, or jump within a slideshow |

If a layout lacks a title placeholder, the tool reports that condition instead of silently adding an unrelated text box.

Keynote exposes duplication to another location but not a plain move command. Reordering therefore duplicates and deletes within one script so the document does not sit in a half-moved state.

`keynote_show` activates Keynote because presenting requires it to own the screen.

## Cross-app object model

Pages, Numbers, and Keynote share the same base iWork object types for shapes, images, text items, tables, charts, movies, and lines.

| App | Main content container |
| --- | --- |
| Pages | document body, sections, and pages |
| Numbers | sheets containing tables |
| Keynote | slides |

`iwork_shapes`, `iwork_export`, and `iwork_document` operate against that shared model. Pass a file path and the app is inferred from `.pages`, `.numbers`, or `.key`; pass `app` to work with the frontmost document.

## Permissions

Native iWork automation uses Apple Events. macOS may ask the host process for Automation permission the first time it controls Pages, Numbers, or Keynote.

If permission was denied, iWork calls commonly return `-1743` or `-10004`. Use `mac_permissions` or `pages_status` to identify the host process and open the correct System Settings pane.

The permission belongs to the process macOS names, which can differ between an interactive Terminal and a LaunchAgent-hosted server.
