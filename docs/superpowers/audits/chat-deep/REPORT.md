# Chat Deep Audit

**Date:** 2026-04-20
**Branch:** feat/phase2-4-mcp-agents-plans
**Duration:** ~85s Playwright + ~20s debug pass
**Findings:** P0=0 P1=2 P2=4 Nit=2
**Console errors:** 1 (TipTap duplicate extension warning)
**Network 4xx/5xx:** 0
**Page errors (uncaught):** 0

---

## P0 — Blocks release

_None_

---

## P1 — Must fix before launch

1. **[Threads — Composer]** Thread panel opens but uses a plain textarea with no mention autocomplete, no slash commands, no markdown preview, and no file attachment. This is a noticeably degraded compose experience vs. the main channel composer.
   - Screenshot: `docs/superpowers/audits/chat-deep/09-thread-panel-open.png`
   - File: `apps/web/src/components/thread-panel.tsx` lines 482-509 — bare textarea, not RichComposer.
   - Fix: Replace textarea with RichComposer in ThreadPanel.

2. **[TipTap — Duplicate Link Extension]** TipTap logs a duplicate extension warning every time a message edit box opens. EditBox in space-chat.tsx adds Link.configure() without first disabling the Link bundled in StarterKit.
   - File: `apps/web/src/components/space-chat.tsx` line 2330-2332 (EditBox component).
   - Compare: `apps/web/src/components/rich-composer.tsx` correctly sets `link: false` in StarterKit.configure().
   - Fix: Add `link: false` to StarterKit.configure() inside EditBox.

---

## P2 — Should fix

1. **[Space Navigation — URL not updated]** Clicking a space in the sidebar does NOT update the URL to include ?space=. URL stays at /chat. Users cannot share or bookmark their current space.
   - Screenshot: `docs/superpowers/audits/chat-deep/02-sidebar-no-url-change.png`
   - Fix: In sidebar space click handler, call router.replace with ?space= param.

2. **[Delete Message — No confirm dialog]** Clicking Delete in the more-menu immediately deletes without a confirmation dialog. No undo. Compare: creating a task has a confirm step. For irreversible destructive actions, a confirm step is expected.
   - Screenshot: `docs/superpowers/audits/chat-deep/14-after-delete.png`

3. **[Search — Message result navigation broken]** Clicking a message result in the command palette navigates to /chat with no ?space= or ?message= param. Expected: deep-link to /chat?space=X&message=Y.
   - Screenshot: `docs/superpowers/audits/chat-deep/17-search-click-no-nav.png`
   - Fix: Resolve spaceId for each message result and navigate with full params.

4. **[Markdown Links not rendered]** Sending [link text](https://example.com) renders literally as raw text. Bold, italic, and code all render correctly, but link syntax is unhandled.
   - Screenshot: `docs/superpowers/audits/chat-deep/08-markdown-message-send.png`
   - File: renderInlineFormatting() in space-chat.tsx — no [text](url) pattern.
   - Fix: Add link regex to renderInlineFormatting().

---

## Nits

1. **[Thread URL — No deep-link]** Opening a thread does not update the URL — no way to share a direct link to a thread.

2. **[Composer placeholder]** The main compose box has no visible placeholder attribute in the DOM (data-placeholder not set). TipTap placeholder extension may not be rendering via CSS in current theme.

---

## What passed cleanly

- Messages load: 49 in general, correctly ordered
- Hover actions: React, Reply, Pin, Bookmark, Create Task, More all visible at 1440px
- Timestamps: consistent 12h format with sender-timezone tooltip — no ISO leaks
- Avatars: no broken images
- Markdown: bold, italic, code render correctly in sent messages
- Enter to send: works, message appears immediately
- Quick succession: 4 rapid messages all appear in order
- Shift+Enter: correctly inserts newline without sending
- Thread panel: opens on Reply button click
- Edit message: More > Edit > save > (edited) clickable indicator appears
- Ctrl+K: command palette opens
- Search results: 9 results for "chat-audit ping"
- Reactions: emoji picker (127 buttons) opens, reaction badge appears, toggle works
- Real-time: message from tab 2 appeared on tab 1 in 313ms
- Zero JS exceptions, zero API failures

---

## Coverage

### What was tested
- Group 1: Space navigation (sidebar, URL, 4 spaces, message loading)
- Group 2: Message rendering (timestamps, avatars, hover actions, markdown)
- Group 3: Send messages (Enter, quick succession x4, Shift+Enter, markdown)
- Group 4: Threads (Reply button, panel open, composer, close)
- Group 5: Reactions (React button, picker, pick, toggle off)
- Group 6: Edit + Delete (more menu, edit, (edited) marker, delete)
- Group 7: Search / Ctrl+K (palette open, results, navigation)
- Group 8: Real-time (two-tab, 313ms latency, socket connected)

### Coverage gaps
- Mobile viewports not tested
- File upload / drag-and-drop not tested
- Slash commands not tested
- @mention autocomplete not tested
- Pinned messages management not tested
- Message pagination / load-more not tested
- Huddle audio not tested
- Forward message flow not tested
- Scheduled messages panel not tested

---

## Raw console/network logs

### Console errors/warnings

```
[console.warn] [tiptap warn]: Duplicate extension names found: ['link']. This can lead to issues.
```

### Network 4xx/5xx

```
_No 4xx/5xx errors recorded_
```

### Uncaught page errors

```
_None_
```

### Screenshots index

| # | Filename | What it shows |
|---|----------|---------------|
| 01 | 01-chat-initial-load.png | /chat initial load |
| 02 | 02-sidebar-no-url-change.png | URL still /chat after sidebar click (P2) |
| 03 | 03-space-general-loaded.png | general space 49 messages |
| 04 | 04-message-feed.png | Message feed |
| 05 | 05-message-hover-actions.png | Hover toolbar confirmed |
| 06 | 06-after-send-ping1.png | ping 1 in feed |
| 07 | 07-quick-succession-pings.png | All 4 pings in order |
| 08 | 08-markdown-message-send.png | Markdown rendered; link not (P2) |
| 09 | 09-thread-panel-open.png | Thread panel — bare textarea (P1) |
| 10 | 10-emoji-picker-open.png | Emoji picker 127 buttons |
| 11 | 11-after-reaction-add.png | Reaction badges on message |
| 12 | 12-edit-mode.png | Edit box open |
| 13 | 13-after-edit-save.png | (edited) indicator visible |
| 14 | 14-after-delete.png | After delete (P2 — no confirm) |
| 15 | 15-command-palette-open.png | Ctrl+K palette |
| 16 | 16-search-results.png | 9 results for "chat-audit ping" |
| 17 | 17-search-click-no-nav.png | Click result — URL /chat (P2) |
| 18 | 18-general-space-overview.png | General space overview |
| 19 | 19-realtime-check.png | Tab 1 sees tab 2 message in 313ms |
