# Chat Mobile Audit

**Date:** 2026-04-20
**Branch:** feat/phase2-4-mcp-agents-plans
**Viewport:** 390×844 px, deviceScaleFactor 2, isMobile true, hasTouch true
**User-Agent:** iPhone 13 Safari 17
**Duration:** 19.9s
**Counts:** P0: 0 | P1: 2 | P2: 1 | Nit: 2
**Screenshots:** 12

---

## Overall impression

Cairn Chat has meaningful mobile adaptations already in the codebase. The sidebar uses a slide-over drawer pattern (`fixed md:relative` + `-translate-x-full md:translate-x-0`) with a hamburger button in the AppHeader. The ThreadPanel detects `window.innerWidth < 768` and switches to `fixed inset-0 z-50` (full-screen) on mobile. Each message row includes a persistent `md:hidden` ellipsis button so tap users can access message actions without hover. Text rendering uses `break-words` and `min-w-0` throughout.

The primary concerns are: (1) numerous small touch targets (icon buttons sized at 24–32px), (2) the chat header action row (`overflow-x-auto`) crams many actions into 390px and hides them behind a horizontal scroll that users won't discover, (3) the compose box likely gets occluded by the iOS virtual keyboard because no `env(safe-area-inset-bottom)` is applied, and (4) the search icon dispatches a `KeyboardEvent` to open the command palette — a pattern that may not work on mobile browsers. The app is **usable with issues** — navigation works, message sending works, thread panel is properly full-screen — but several touch ergonomics improvements are needed before a mobile-polished release.

---

## P0 — blocks release

_None_


## P1 — must fix

### 1. Small touch targets (< 32px) in chat-landing

33 interactive elements are under 32px in at least one dimension (Apple HIG minimum is 44px). The offenders include:

- **Mute channel** button: 26×26px (Bell/BellOff icon, `p-1.5` padding — renders as ~26px)
- **Knowledge** button: ~26×26px (BookOpen icon, same padding)
- **Sidebar space items**: `height: 32px` — all space/DM list rows in the sidebar
- **Notification bell**: ~28×28px

These are primarily icon-only buttons with `p-1.5` padding around small icons (14–16px Lucide icons). The effective tap target is far below the 44px Apple HIG standard and the 48px Material Design guideline.

**Suggested fix:** Add `min-h-[44px] min-w-[44px]` or use `-m-1.5 p-3` negative-margin expansion trick to increase tap target without changing visual size.

### 2. Small touch targets (< 32px) in message-feed

24 interactive elements are under 32px in at least one dimension (Apple HIG minimum is 44px). In the message feed view, the same icon buttons persist plus:

- **Mute channel** button: 26×26px
- **Huddle** button (icon only on mobile, `hidden md:inline` hides label): 33×28px
- **Pin/Bookmark icon buttons**: ~26px

The header action row shows 6+ icon buttons (Members, Mute, Huddle, Catch Up, Knowledge) squeezed into ~300px with tiny touch areas. On mobile this row is `overflow-x-auto` — scrollable but with no visual affordance that it is scrollable.


## P2 — should fix

### 1. Hamburger button is 32×32px — below 44px HIG minimum

Hamburger touch target is 32×32px. Apple HIG requires ≥ 44×44px.


## Nits

### 1. Mobile message ellipsis button has opacity-40

The md:hidden message action button uses `opacity-40 active:opacity-70` — barely visible at rest. Consider opacity-60 or always-visible icon at 70%.

### 2. Compose box lacks env(safe-area-inset-bottom) padding

The RichComposer wrapper does not use env(safe-area-inset-bottom). On iPhone 13 and newer, the home indicator can overlap the send button / composer edge. Add `padding-bottom: env(safe-area-inset-bottom)` to the composer container.


---

## Coverage gaps

- Real iOS keyboard raise/lower was simulated by viewport resize (h=500), not an actual on-screen keyboard. Real-device or BrowserStack testing recommended for keyboard-occlusion validation.
- Reaction emoji picker (`EmojiPicker`) positioning was not tested — it uses absolute positioning and may overflow the 390px viewport.
- File upload drag-and-drop (`FileDropZone`) not tested on touch — verify tap-to-attach works with `fileInputRef.current?.click()`.
- Link preview cards (`LinkPreviewCard`) were not exercised (no URL messages in visible seed data).
- Clip recorder (Mic button in RichComposer) not tested — `mediaDevices.getUserMedia` on mobile.
- DM spaces not tested separately from public spaces.
- Dark mode layout not audited.
- iOS-specific overscroll/bounce behavior and elastic scrolling not evaluated.

---

## Key code observations (static analysis)

| Area | Code location | Note |
|------|--------------|------|
| Sidebar slide-in | `sidebar.tsx:1048` | `fixed md:relative z-50` + translate — correct |
| Thread full-screen | `thread-panel.tsx:431` | `isMobile` → `fixed inset-0 z-50` — correct |
| Message mobile ellipsis | `space-chat.tsx:1347` | `md:hidden` always visible — correct. But `opacity-40` makes it nearly invisible |
| Mobile more menu | `space-chat.tsx:1586` | Renders when `!isHovered` — may not show if touch sets hover |
| Header action row | `space-chat.tsx:1081` | `overflow-x-auto` hides actions on narrow screens |
| Compose safe-area | `rich-composer.tsx` | No `env(safe-area-inset-bottom)` — iOS home indicator risk |
| Search trigger | `app-header.tsx:57` | `dispatchEvent(new KeyboardEvent('keydown', {metaKey, ctrlKey}))` — may not fire on mobile |
| Sidebar buttons | `sidebar.tsx:148` | Space items: `height: 32px` — below 44px HIG |

---

## Screenshots index

| # | Filename |
|---|---------|
| 1 | 01-*.png |
| 2 | 02-*.png |
| 3 | 03-*.png |
| 4 | 04-*.png |
| 5 | 05-*.png |
| 6 | 06-*.png |
| 7 | 07-*.png |
| 8 | 08-*.png |
| 9 | 09-*.png |
| 10 | 10-*.png |
| 11 | 11-*.png |
| 12 | 12-*.png |
