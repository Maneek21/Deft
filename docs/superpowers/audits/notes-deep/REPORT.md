# Notes Deep Audit

**Date:** 2026-04-20
**Branch:** feat/phase2-4-mcp-agents-plans
**Duration:** 74s
**Notes found via API:** 6
**Findings:** P0×0 P1×3 P2×5 Nit×3
**Screenshots:** 23

---

## P0 — blocks release

_(none)_

## P1 — must fix

### 1. Notes/Landing — Wrong document title ("Deft AI" on all routes)

**URL:** http://localhost:3000/notes

**What:** The browser tab title reads "Deft AI" on every route, including /notes. The Notes page content h1 reads "Notes" correctly, but document.title is never updated per surface. This breaks bookmarking, browser history, accessibility (screen readers announce the title), and SEO.

**Suggested fix:** Add Next.js metadata export (`export const metadata = { title: 'Notes – Deft' }`) to the notes route, or call `document.title = 'Notes – Deft'` in a useEffect.

**Screenshot:** `01-notes-initial-load.png`

---

### 2. Notes/RichEditor — Blockquote toolbar button has no visible effect

**URL:** http://localhost:3000/notes?id=...

**What:** Clicking the Quote (blockquote) toolbar button while the cursor is in the editor does not produce a `<blockquote>` element. `editor.chain().focus().toggleBlockquote().run()` fires (button becomes active momentarily) but no `<blockquote>` appears in the DOM when queried after typing. Likely a focus race — the cursor loses focus between the toolbar click and the `toggleBlockquote` call because the toolbar `<button>` is not set to `type="button"` with `onMouseDown={e => e.preventDefault()}`.

**Suggested fix:** All TipTap toolbar buttons should use `onMouseDown={e => e.preventDefault()}` (not `onClick`) to prevent the editor from losing focus before the command runs.

**Screenshot:** `10-toolbar-features-tested.png`

---

### 3. Notes/RichEditor — Triple-backtick code block markdown shortcut broken

**URL:** http://localhost:3000/notes?id=...

**What:** Typing triple backtick (` ``` `) then pressing Enter does not create a TipTap fenced code block. The text remains as literal characters. The inline Code toolbar button works fine; only the triple-backtick input rule fails to fire.

**Detail:** `StarterKit.configure({ codeBlock: { HTMLAttributes: { class: 'deft-code-block' } } })` — passing `HTMLAttributes` does not disable input rules, so the root cause is elsewhere. The ` ``` ` input rule requires the cursor to be at the start of a new block; if existing content precedes it on the same line the rule won't fire. However, this was tested on a fresh blank line and still failed.

**Suggested fix:** Check whether `StarterKit` v3 requires an explicit `inputRules: true` option, or whether there is a conflicting global `keydown` handler swallowing the sequence.

**Screenshot:** `11-rich-editor-features.png`

---

## P2 — should fix

### 1. Notes/Landing — Slow initial page load (3.6s on localhost)

**What:** /notes took 3597ms to reach `networkidle` on localhost dev server (1440×900 viewport). Suggests an API waterfall or large client JS bundle at initial mount. Individual note loads are fast.

**Screenshot:** `01-notes-initial-load.png`

---

### 2. Notes/Delete — Hard delete with no trash or undo affordance

**What:** Deleting a note via the Trash icon shows `window.confirm()` with "Delete this note? This cannot be undone." and immediately hard-deletes (API returns 404 on re-fetch). No trash bin, no soft-delete, no undo toast. Accidental deletion is permanent with no recovery path.

**Suggested fix:** Add a soft-delete with 30-day retention and a "Recently Deleted" folder in the sidebar, or at minimum a 5-second Undo toast before the hard-delete fires.

**Screenshot:** `09-after-delete.png`

---

### 3. Notes/RichEditor — Slash command menu does not appear

**What:** Typing "/" in the editor body does not trigger a slash-command menu, despite the placeholder text explicitly reading "Start writing... (type / for commands)". The feature is prominently advertised in the UX but is not implemented.

**Detail:** `page.locator('[role="menu"], [role="listbox"], .slash-menu, .tippy-box').count()` returned 0 after typing "/" and waiting 500ms.

**Suggested fix:** Implement a TipTap suggestion plugin for slash commands (heading, list, code block, table, image, etc.), or change the placeholder to remove the false promise.

**Screenshot:** `13-rich-editor-final-state.png`

---

### 4. Notes/TipTap — Duplicate link+underline extensions warning on every editor mount

**What:** Browser console emits `[tiptap warn]: Duplicate extension names found: ['link', 'underline']. This can lead to issues.` every single time `NoteEditor` mounts (9 occurrences observed). StarterKit v3.21.0 already bundles `link` and `underline` internally; the component also imports `LinkExt` and `Underline` as standalone extensions, causing duplicates.

**File:** `apps/web/src/app/(app)/notes/page.tsx` lines 11, 19, 226, 236

**Suggested fix:** Either configure link/underline via `StarterKit.configure({ link: { openOnClick: true, HTMLAttributes: { class: 'deft-link' } } })` and remove the standalone imports, or add `StarterKit.configure({ link: false, underline: false })` to let the custom standalone versions take precedence.

---

### 5. Notes/React — Missing key props in NoteEditor list render

**What:** React console error: "Each child in a list should have a unique 'key' prop. Check the render method of NoteEditor." A .map() call in NoteEditor (likely the version history list, shares list, or references list) renders elements without a key prop.

**Suggested fix:** Add a stable `key` prop to every `.map()` call in the NoteEditor component. Version history versions have `v.id`, shares have `s.id`, references have `ref.id` — all present in the data.

---

## Nits

### 1. Notes/CrossRef — "References tasks" panel invisible when no refs exist

**What:** The references sidebar only appears when `references.length > 0`. For new notes there is no hint the feature exists or how to use it. A user would never discover that typing a task identifier (e.g. "PROJ-1") creates a cross-reference.

**Suggested fix:** Show a collapsed or greyed-out "References" section with an explanation like "Mention a task (e.g. PROJ-1) to link it here."

---

### 2. Notes/Accessibility — 3 icon buttons without accessible labels

**What:** Three buttons in the editor toolbar/header have no `title` attribute and no `aria-label`, making them invisible to screen readers and removing keyboard tooltip support. (Detected via DOM evaluation: buttons with no title, no aria-label, text content ≤1 character.)

**Suggested fix:** Add `title="..."` or `aria-label="..."` to every icon-only button in the NoteEditor header.

---

### 3. Notes/DailyNotes — /daily-notes is a 404

**What:** GET http://localhost:3000/daily-notes returns 404 (confirmed in network log). The `apps/web/src/app/(app)/daily-notes/` directory does not exist. There is no separate daily-notes calendar UI. The API uses `/api/daily-notes` as a naming prefix but the notes UI is only at `/notes`. Next.js serves its 404 page.

**Screenshot:** `17-daily-notes-view.png`

---

## What works well

- Note creation (blank + templates) and editor open correctly
- TipTap renders; H1/H2/Bold/Italic/Bullet/Ordered list/Inline code/Underline/Highlight/Checkbox toolbar buttons all functional
- Markdown shortcuts: `# heading` → H1, `**bold**` → bold, `- item` → bullet list all fire
- Autosave: 600ms debounce + verified via API re-fetch + DOM check after reload
- Title rename: debounced save works, persists after reload
- Delete: confirm dialog fires, hard-deletes, navigates to list
- "Promote to Wiki" modal: opens, 7 page type chips, Promote button wired
- Version history panel: opens, "No previous versions" shown for new notes
- Share modal: opens, lists org members, share/unshare API wired
- Visibility selector (Private/Org): present, wired to API
- Pin/Unpin: works, verified via API
- Focus mode: full-screen overlay activates/deactivates
- Inline search: client-side filter + "No notes matching" empty state
- Ctrl+K: opens global command palette
- Word count footer: shows words + chars + estimated read time
- Export as Markdown: Download button present
- Folder system: "All Notes" filter + folder pills + inline folder creation
- Templates dropdown: correct structure
- Undo/Redo (Ctrl+Z / Ctrl+Shift+Z): works

---

## Coverage gaps

- `/daily-notes` UI route: does not exist (404) — no daily-notes calendar view separate from /notes
- Drag-and-drop image upload: not tested (OS-level drag not supported in Playwright)
- Paste image from clipboard: not tested (OS clipboard injection limitation)
- Real-time collaboration: not in scope — single-user surface with explicit sharing
- Export PDF: no PDF export button — Markdown only via Download button
- Keyboard shortcut Ctrl+N / Cmd+N for new note: no evidence in source code; not tested
- `[[mention]]` syntax for cross-referencing: not implemented; cross-refs detected post-save via keyword scan in saved content
- Cross-reference live test: could not complete — task `identifier` field was null in API test data

## Raw console / network logs

### Console errors / warnings (first 30)
```
[warning] [tiptap warn]: Duplicate extension names found: ['link', 'underline']. This can lead to issues.
[warning] [tiptap warn]: Duplicate extension names found: ['link', 'underline']. This can lead to issues.
[warning] [tiptap warn]: Duplicate extension names found: ['link', 'underline']. This can lead to issues.
[warning] [tiptap warn]: Duplicate extension names found: ['link', 'underline']. This can lead to issues.
[warning] [tiptap warn]: Duplicate extension names found: ['link', 'underline']. This can lead to issues.
[warning] [tiptap warn]: Duplicate extension names found: ['link', 'underline']. This can lead to issues.
[warning] [tiptap warn]: Duplicate extension names found: ['link', 'underline']. This can lead to issues.
[warning] [tiptap warn]: Duplicate extension names found: ['link', 'underline']. This can lead to issues.
[error] Each child in a list should have a unique "key" prop.%s%s See https://react.dev/link/warning-keys for more information. 

Check the render method of `NoteEditor`. 
[error] Failed to load resource: the server responded with a status of 404 (Not Found)
[warning] [tiptap warn]: Duplicate extension names found: ['link', 'underline']. This can lead to issues.
```

### Network 4xx/5xx errors (first 30)
```
404 GET http://localhost:3000/daily-notes
```

### Uncaught page errors
```
(none)
```

## Screenshots index

| # | Filename | Description |
|---|----------|-------------|
| 01 | `01-notes-initial-load.png` | Notes list on first load (3.6s) |
| 02 | `02-notes-list-view.png` | Notes list with 6 seed notes visible |
| 03 | `03-new-note-dropdown.png` | "New Note" dropdown (Blank Note + Templates) |
| 04 | `04-new-note-editor-blank.png` | Fresh editor after note creation |
| 05 | `05-editor-content-typed.png` | Editor with H1 + paragraph + bold + bullets |
| 06 | `06-autosave-indicator.png` | "Saved" indicator in editor top bar |
| 07 | `07-after-reload-content-check.png` | Editor content restored after page reload |
| 08 | `08-before-delete.png` | Editor before deletion |
| 09 | `09-after-delete.png` | Notes list after hard-delete |
| 10 | `10-toolbar-features-tested.png` | H1/H2/Bold/Bullet/OL applied via toolbar |
| 11 | `11-rich-editor-features.png` | Code + blockquote attempt (blockquote failed) |
| 12 | `12-placeholder-check.png` | Blank editor showing placeholder text |
| 13 | `13-rich-editor-final-state.png` | Editor after slash command test (menu absent) |
| 14 | `14-promote-to-wiki-modal.png` | "Promote to Wiki" modal with type selector |
| 15 | `15-version-history-panel.png` | Version History panel open |
| 16 | `16-share-modal.png` | Share Note modal |
| 17 | `17-daily-notes-view.png` | /daily-notes — Next.js 404 fallback |
| 18 | `18-search-results.png` | Inline search results for "audit-note-" |
| 19 | `19-search-no-results.png` | "No notes matching" empty state |
| 20 | `20-ctrl-k-search.png` | Ctrl+K command palette |
| 21 | `21-templates-dropdown.png` | Templates dropdown (Blank Note + Templates section) |
| 22 | `22-focus-mode-active.png` | Focus mode full-screen overlay |
| 23 | `23-notes-list-final.png` | Final notes list state |
