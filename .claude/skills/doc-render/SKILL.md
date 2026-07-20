---
name: doc-render
description: Render a markdown document into a clean, professional, readable HTML view and open it in the app browser. Use whenever the user asks to view, render, open, or present a document/report/audit readably, or when delivering a written report worth reading in the browser. Also use its stylesheet as the base for any new standalone HTML document.
---

# doc-render — professional document rendering

Turn a markdown file into a polished standalone HTML page and show it in the
app's browser. pandoc is installed at `/usr/bin/pandoc`; no other install needed.

## Workflow

1. Render:
   ```bash
   .claude/skills/doc-render/scripts/render.sh <path/to/doc.md>
   ```
   The last line of output is a `file://` URL with a **content-hashed filename**.
2. Open that exact URL with `browser_navigate` (readySelector: `table` for
   table-heavy docs, else `h1`).
3. For long docs, verify visually with `browser_screenshot` — especially any
   wide table — before telling the user it's done.

Source markdown is never modified; rendered output goes to `/tmp/doc-render/`.

## Hard-won gotchas (do not rediscover these)

- **file:// cache trap:** the app browser caches `file://` pages aggressively;
  `location.reload()` can serve stale HTML/CSS. Never re-render to the same
  filename and reload — the script's content-hash filename exists precisely to
  force a fresh load. If you must reuse a name, add `?v=N` to the URL.
- **Fragment navigation doesn't reload:** navigating `page.html#section` when
  the tab is already on `page.html` is same-document — new CSS/HTML will NOT
  load. Navigate to the new hashed filename instead.
- **Wide tables:** GFM tables with many columns must scroll within themselves
  with a sticky first column, or row labels scroll out of view and the table
  becomes unreadable. The stylesheet handles this — don't override it.
- **No zebra striping on dark themes:** alternating row backgrounds read as
  "disabled/faded rows." Use hairline row separators + hover highlight.
- **GFM `---:` alignment:** pandoc emits inline `text-align: right` on cells,
  which makes matrix cells ragged; the stylesheet force-overrides to left.
- **pandoc `-s` title block:** duplicates the document's own H1; the stylesheet
  hides `#title-block-header`.

## Styling changes

Edit `assets/doc-style.html` (single canonical stylesheet, plain `<style>` tag
injected via `--include-in-header`). Keep it one file; every improvement here
upgrades all future documents. Verify changes by rendering a table-heavy doc
(e.g. `docs/market-comparison-2026-07-19.md`) and screenshotting the widest table.

## Upgrade path (not built yet)

- PDF export: `pandoc -t pdf` needs a PDF engine (weasyprint/wkhtmltopdf not
  installed); check before promising PDFs.
- Light-mode variant, print stylesheet, TOC sidebar (`pandoc --toc`).
