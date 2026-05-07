# Notes Mobile Audit

**Date:** 2026-04-20
**Branch:** feat/phase2-4-mcp-agents-plans
**Viewport:** 390×844 (iPhone 13) · deviceScaleFactor 2 · isMobile true · hasTouch true
**User Agent:** iPhone OS 17_0 Safari/604.1
**Duration:** 55s
**Findings:** P0×0 P1×4 P2×6 Nit×2
**Screenshots:** 16

---

## Overall impression

The Notes feature is a full-page TipTap-based editor. On a 390px viewport:

- The **note list** uses `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3` which correctly collapses to a single column on mobile.
- The **toolbar** uses `overflow-x-auto flex-nowrap` which scrolls rather than wraps — acceptable, but all buttons are hidden until the user discovers the scroll.
- The **toolbar buttons** use `p-1.5` (6px padding) around 15px icons — resulting in ~27×27px touch targets, well below the 44×44px WCAG minimum.
- **Modals** (Share, Promote-to-Wiki) are `w-80` (320px) centered on a 390px screen — they fit but are not full-screen.
- The **Undo delete toast** is `fixed bottom-6 left-1/2 -translate-x-1/2` — horizontally centered, which is correct.
- **Focus mode** uses `fixed inset-0 z-[90]` — covers the sidebar correctly.
- **Ctrl+K** is keyboard-only and has no floating FAB fallback for touch-only users.

---

## P0 — blocks release

_(none)_

## P1 — must fix

### 1. Notes/Landing

**What:** "New Note" button too short for touch (32px < 36px)

**Screenshot:** `01-notes-landing.png`

---

### 2. Notes/Editor

**What:** 28 icon buttons are smaller than 44×44px — too small for touch targets

**Detail:** (24×24), More options, (32×32), (32×32), 92, Focus mode, Share note, Version history

**Screenshot:** `03-editor-open.png`

---

### 3. Notes/Toolbar

**What:** 16 toolbar button(s) are below 44×44px touch target minimum

**Detail:** Heading 1 (27×27), Heading 2 (27×27), Bold (27×27), Italic (27×27), Strikethrough (27×27), Code (27×27), Underline (27×27), Highlight (27×27)

**Screenshot:** `04-toolbar-mobile.png`

---

### 4. Notes/Delete

**What:** Undo button too small for touch (28px < 36px)

**Screenshot:** `10-delete-undo-toast-mobile.png`

---

## P2 — should fix

### 1. Notes/SlashCommands

**What:** Slash command menu not shown when typing "/" on mobile

**Screenshot:** `09-slash-command-mobile.png`

---

### 2. Notes/Delete

**What:** Delete button too small for touch (27px < 36px)

---

### 3. Notes/Share

**What:** Share modal "Done" button too short for touch (30px)

**Screenshot:** `12-share-modal-mobile.png`

---

### 4. Notes/WikiPromotion

**What:** Page type button "concept" too small (25px) for touch in promote modal

**Screenshot:** `13-promote-wiki-modal-mobile.png`

---

### 5. Notes/CmdK

**What:** Ctrl+K (command palette) does not open on simulated mobile — expected: physical keyboards may trigger it, touch-only users have no access

**Detail:** Consider adding a floating search FAB for mobile users

**Screenshot:** `15-ctrl-k-mobile.png`

---

### 6. Notes/Landing

**What:** Note cards are narrower than expected on mobile (240px vs ~342px) — grid may not be single-column

**Screenshot:** `16-notes-list-final-mobile.png`

---

## Nits

### 1. Notes/Toolbar

**What:** Toolbar content wider than viewport on mobile (508px vs 342px) — requires horizontal scroll to reach all buttons

**Detail:** overflow-x-auto is set, so scroll works, but buttons at the end are hidden by default

---

### 2. Notes/Share

**What:** Share modal is centered (320px wide) not full-screen — OK for 390px, but consider full-screen on narrow viewports

**Screenshot:** `12-share-modal-mobile.png`

---

---

## Static analysis findings (from source code)

These were identified from reading `apps/web/src/app/(app)/notes/page.tsx` and do not depend on runtime test results:

### Toolbar button touch targets (WCAG P1)
`TBtn` renders `<button class="p-1.5 rounded ..."` with `size={15}` icons.
- `p-1.5` = 6px top/bottom padding → total height ≈ 15 + 12 = 27px.
- WCAG 2.5.5 requires 44×44px. Apple HIG recommends 44pt.
- **All 18 toolbar buttons fail this requirement on mobile.**

### Undo toast centering (OK)
`fixed bottom-6 left-1/2 -translate-x-1/2` → horizontally centered at 24px from bottom.
This is correct and unaffected by soft keyboard because the toast uses `fixed` positioning.

### Modals not full-screen on mobile (P2)
Both modals use `w-80` (320px). On 390px screen this leaves 35px side margin (17.5px each side).
The backdrop is `fixed inset-0` so tapping outside dismisses — OK. But on very narrow phones (<375px), the modal clips.

### Placeholder text (confirmed updated)
`Placeholder.configure({ placeholder: 'Start writing…' })` — the "type / for commands" placeholder was removed. ✅

### Slash commands (no extension registered)
The StarterKit and extensions registered in `useEditor` do **not** include a slash-command extension.
Typing `/` will not produce a command menu. The placeholder no longer promises it, which is correct.
But the feature is absent — users expect it from the old placeholder.

### No sidebar on mobile (by design)
Notes uses a full-page single-column layout (no sidebar panel). On mobile, the note list and editor
are swapped via the `activeId` URL param. This is a correct mobile-first pattern.

### Editor `min-h-[calc(100vh-350px)]` (Nit)
The editor content area uses a calculated minimum height. On mobile with a soft keyboard,
`100vh` may be the full screen height before keyboard appears — meaning the editor could become
taller than the visible area when the keyboard rises, requiring the user to scroll to reach the cursor.
This is a known TipTap/iOS limitation with no simple CSS-only fix; ScrollIntoView is needed.

### Focus mode z-index (OK)
`fixed inset-0 z-[90]` covers the sidebar layout. ✅

---

## Coverage gaps

- **Soft keyboard interaction**: Playwright cannot simulate iOS soft keyboard; `visualViewport` resize is not tested.
- **Touch gestures**: Swipe-to-go-back / long-press — not tested.
- **RTL layout**: Not tested.
- **Dark/light mode**: Only default theme tested.
- **Paste from clipboard**: Requires OS clipboard — not tested.
- **Image upload**: Requires file picker — partially tested (button presence only).

---

## Raw logs

### Console errors / warnings (first 20)
```
[error] Each child in a list should have a unique "key" prop.%s%s See https://react.dev/link/warning-keys for more information. 

Check the render method of `NoteEditor`. 
```

### Network 4xx/5xx errors (first 20)
```
(none)
```

### Uncaught page errors
```
(none)
```

---

## Screenshots index

- `01-*.png`
- `02-*.png`
- `03-*.png`
- `04-*.png`
- `05-*.png`
- `06-*.png`
- `07-*.png`
- `08-*.png`
- `09-*.png`
- `10-*.png`
- `11-*.png`
- `12-*.png`
- `13-*.png`
- `14-*.png`
- `15-*.png`
- `16-*.png`
