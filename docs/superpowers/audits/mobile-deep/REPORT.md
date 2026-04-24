# Mobile UI Deep-Dive Audit

**Date:** 2026-04-24
**Viewports tested:** iPhone 14 (390×844) and iPhone SE (375×667), Chromium via Playwright
**Surfaces visited:** /login, /chat (general + thread), /dashboard, /tasks (board, calendar, pipeline) + task detail, /agent (Defty), /calendar (month, week), /notes, /knowledge, /library, /settings, /settings/agent-employees/[id]/personality
**User:** maneek@test.com (seed org owner)

Screenshots in `./screenshots/`. Numbered in capture order.

---

## Severity legend
- **P0** — broken / data-leak / blocks core mobile flow
- **P1** — fails platform conventions (iOS auto-zoom, 44×44 tap targets), present everywhere it matters
- **P2** — visible cracks but workable
- **P3** — polish

---

## P0 — Ship-blockers

### P0-1 — Dashboard "Unread" widget renders raw HTML as escaped text
**Where:** `apps/web/src/app/(app)/dashboard/widgets/unread.tsx:51`
**Evidence:** `screenshots/07-dashboard-mid-390.png` shows `Maneek: <p><strong>Deploy status:</strong></st...` literally.
**Cause:** `{s.last_message}` interpolates the API's `last_message` field which contains TipTap HTML; the widget never strips tags or HTML-decodes.
**Fix:** Strip tags in the component (`.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()`) or — better — return a plain-text `last_message_preview` from the dashboard facade (`apps/web/src/app/(app)/dashboard/lib/facade.ts`). Then the same string is safe to truncate without breaking on tag boundaries.

### P0-2 — Agent chat composer has no send button
**Where:** `/agent` (`apps/web/src/components/agent-chat.tsx`)
**Evidence:** `screenshots/14-agent-landing-390.png`. `document.querySelectorAll('button')` filtered by `lucide-send|lucide-arrow-up|aria-label*=send` returns **0** matches.
**Why it's P0:** mobile soft keyboards almost universally insert a newline on Enter (especially on multi-line `<textarea>`s). Without an explicit send affordance, mobile users cannot send a message to the agent at all.
**Fix:** Add a primary submit button (paper-plane / arrow-up) inside the composer, visible at all viewports, ≥44×44, disabled while empty.

### P0-3 — Chat composer has the same problem
**Where:** `/chat` (TipTap-based composer in `apps/web/src/components/space-chat.tsx`)
**Evidence:** `screenshots/02-chat-landing-390.png`, `08-chat-composer-focused-390.png`. The composer toolbar shows B / I / S / `<>` / code-block / lists / quote / link — and a paperclip / emoji / mic row — but **no send button**. The "N" at bottom-left is the Next.js dev-tools indicator, not a send button.
**Fix:** Add a paper-plane button (≥44×44) on the right side of the composer; on mobile it should also accept "Cmd/Ctrl+Enter" only and show the button as the primary send affordance.

---

## P1 — Mobile-platform violations

### P1-1 — All form inputs use 14px font → iOS Safari auto-zooms on focus
iOS Safari auto-zooms any input whose computed `font-size` is < 16px when focused. Auto-zoom shifts the layout, sometimes traps the user in a zoomed-in viewport, and is the single most common mobile React-app smell.

Confirmed instances:
| Surface | File:line | Computed font-size |
|---|---|---|
| Login email/password | `apps/web/src/app/login/page.tsx:120, 142` (`text-[0.875rem]`) | 14px |
| Chat composer (TipTap `.ProseMirror`) | `apps/web/src/components/space-chat.tsx:264` (`text-[14px]`) | 14px |
| Agent chat textarea | `apps/web/src/components/agent-chat.tsx` | 14px |
| Notes search input | `/notes` | 13px (worse) |

**Fix:** Either bump these to `text-base` / `16px`, or globally add a Tailwind utility e.g. `@media (max-width: 640px) { input, textarea, [contenteditable] { font-size: 16px } }` in `globals.css`. The visual size on small screens stays small via `transform: scale()` if needed, but the focus zoom stops.

### P1-2 — Chat composer formatting toolbar is 9 buttons at 22×22 each
**Where:** `apps/web/src/components/space-chat.tsx` (TipTap menubar)
**Evidence:** `screenshots/02-chat-landing-390.png` and the bounding-box dump in the audit script. Bold, Italic, Strikethrough, Inline code, Code block, Bullet list, Numbered list, Blockquote, Link — every one of them measures 22×22 px. Apple HIG and W3C WCAG 2.5.5 require **44×44** for primary tap targets.
**Also:** the tooltips reference desktop shortcuts (`Cmd+B`, `Cmd+I`, `Cmd+K`) that don't exist on mobile, and tooltips themselves are hover-only.
**Fix:** On `< md`, collapse the formatting strip behind a single "Aa" toggle. When opened, render the formatting controls in a slide-up sheet with 44×44 tiles (this is the Slack mobile / Linear mobile pattern).

### P1-3 — Mobile sidebar drawer is not dismissible by Escape
**Where:** `apps/web/src/components/sidebar.tsx:1038` — backdrop is `<div ... onClick={...}>` only.
**Evidence:** Verified by opening drawer (e195), pressing Escape, then querying `aside` — `x: 0`, backdrop still in DOM. Only backdrop-click closes it.
**Why it matters:** modal-pattern drawers should respond to Escape (assistive-tech users on mobile + iPad with hardware keyboard). It also means programmatic flows that rely on Escape (cmd+K → escape returns to the page) leave the drawer open.
**Fix:** Add a `useEffect` listening for `keydown` while drawer open; also ensure the close-X button is keyboard-focusable and add `role="dialog" aria-modal="true"` to the drawer.

### P1-4 — Login form has no autocomplete/autofill hints
**Where:** `apps/web/src/app/login/page.tsx:118-142`
**Evidence:** `inputs` array shows `autocomplete: ""` and `inputmode: null` for both fields.
**Fix:**
```tsx
<input type="email" autoComplete="email" inputMode="email" autoFocus ... />
<input type="password" autoComplete="current-password" ... />
```
Same change in `/signup` (`autocomplete="new-password"`). Also no password-visibility toggle — every banking and SaaS app has one now.

### P1-5 — "Forgot?" link and "Sign up" link below 44×44
- `Forgot?` measured 43×18 px.
- `Sign up` measured 50×17 px.
**Fix:** Increase tap target via `padding` (do not rely on visible text height). Both should be ≥44 in the touchable axis.

### P1-6 — Chat per-message hover actions remain hover-only
**Where:** Various `space-chat.tsx` rows using `group-hover` classes.
**Evidence:** `opacity-0 group-hover:opacity-100` patterns found; on mobile, hover doesn't exist, so reaction-pickers and quick-action menus are hidden until the user long-presses (which isn't wired).
**Fix:** On `< md`, either always-show a "•••" button per message, or wire a long-press handler that opens an action sheet. (Slack mobile uses long-press; Linear mobile uses always-visible "•••".)

### P1-7 — Channel header tab bar overflows horizontally without affordance
**Where:** `apps/web/src/components/space-chat.tsx` — header strip with channel name + pin count + people + bell + mic + "Catch Up" pill.
**Evidence:** `screenshots/02-chat-landing-390.png` — the strip's `scrollWidth=389` vs `clientWidth=356`, scroll bar visible. "Catch Up" gets clipped.
**Fix:** On mobile, drop secondary chrome (mic state badge, pin count, member count) into the channel-info modal accessed by tapping the channel name. Keep title + bell + Catch Up only.

### P1-8 — App header page-title is stale on `/library`
**Evidence:** `screenshots/20-library-390.png` shows app header title "Dashboard" while the page is `/library`. The page heading inside the body says "Library", but the global header stays on the previous route's title.
**Fix:** trace the `<AppHeader title=…>` prop wiring in `apps/web/src/components/app-header.tsx`. Likely a prop not passed from `/library/page.tsx`.

### P1-9 — Agent / chat composer obscured by Next.js dev tools "N" badge
**Evidence:** Visible in `02`, `08`, `14` screenshots. The dev-tools floating button sits at bottom-left, where the composer's attach / mic / file buttons live (and where the agent textarea begins).
**Note:** Dev-only, but worth flagging — production deploy must verify the badge is gone (or set `devIndicators: false` in `next.config.js` for production-like preview builds).

---

## P2 — Visible cracks

### P2-1 — Tasks **Pipeline** view doesn't collapse columns to tabs (board does)
**Evidence:** `screenshots/13-tasks-pipeline-390.png` — Backlog column visible full-width, "TO" peeking; horizontal scroll required.
**Compare:** Board view (`screenshots/10-tasks-board-390.png`) collapses statuses into a horizontal tab strip (Backlog (6) / To Do (2) / In Progress (4) …) and shows one column at a time.
**Fix:** Reuse the same status-tab pattern in pipeline-view at `< md`.

### P2-2 — Tasks **Calendar** view shows zero task content on mobile
**Evidence:** `screenshots/12-tasks-calendar-390.png`. Each day cell is ~55px wide; not even a single character of a task title fits. DEFT-9 is "Due today" but the cell is blank.
**Fix:** Either show event-dot indicators per day (the `/calendar` page already does this — `screenshots/15-calendar-390.png`) or auto-switch to agenda-list view at `< md`.

### P2-3 — `/calendar` Week view: events overflow their 7-column cells
**Evidence:** `screenshots/16-calendar-week-390.png`. "Tester interview — question bank" stretches across multiple day columns; "Sprint retro" overlaps; "cal-au…" truncated. 7 cols on 375-390px = 45-49px per column, which can't host any event.
**Fix:** Auto-redirect Week → Day at `< md` (or auto-collapse to 3 days centered on today). The Day toggle is also clipped at the right edge of the toolbar — it never gets used because users can't see it.

### P2-4 — Notes preview shows literal `??` as title prefix
**Evidence:** `screenshots/17-notes-390.png` — every note starts with `??`. Likely an emoji glyph that fails to render in the test font (or a missing column from the API). This isn't a font fallback problem on Windows — the emoji is rendering as the Unicode-replacement-character pair.
**Fix:** Inspect what the API returns for the note's "icon" / "emoji" field; null-check before rendering, and verify the actual emoji codepoints (likely the emoji is being saved as a surrogate pair that's getting decoded as `??`).

### P2-5 — Knowledge page has two horizontal tab strips that both overflow
**Evidence:** `screenshots/19-knowledge-390.png`. First strip (All / Org / Space / Personal) and second strip (All / Concepts / Entities / Decisions / Resources) both scroll horizontally on a 390px screen. The "Stats" button in the upper-right is clipped.
**Fix:** Convert one of the two (probably the type filter) to a `<select>` dropdown on mobile. Move "Activity" / "Stats" into a "•••" overflow menu.

### P2-6 — Command palette ⌘K works on mobile keyboards but its footer hints are desktop-only
**Evidence:** `screenshots/04-cmdk-390.png` — palette opens fine, but the footer shows `↑↓ to navigate ← to select ESC v1.0.0-beta`. Three problems:
1. `←` is the wrong arrow (should be `↵` for Enter / select).
2. ESC and arrow hints aren't useful on touch devices.
3. Version string `v1.0.0-beta` leaks into UI — fine for beta, remove before GA.
**Fix:** Hide the keyboard-shortcut footer at `< md`, or replace with "Tap to select / Tap outside to close".

### P2-7 — Sidebar drawer's user-row partially hidden by dev-tools button
**Evidence:** `screenshots/03-sidebar-drawer-390.png` — bottom user pill ("Maneek / Online" + "•••") is partly behind the "N" badge. Dev-only but check `bottom-3` spacing for the user row to ensure it doesn't fall under iOS Safari's home-indicator either.
**Fix:** Add `pb-[max(env(safe-area-inset-bottom),12px)]` or similar to the user row container.

### P2-8 — Dashboard uses an inner-scroll container (`scrollH=3241px`)
**Evidence:** `apps/web/src/app/(app)/dashboard/page.tsx` — the content area scrolls inside a div, body height stays at viewport.
**Why it matters on mobile:** native browser features that depend on body scroll break:
- iOS Safari URL bar doesn't auto-hide.
- Pull-to-refresh doesn't trigger.
- Two-finger scroll-to-top tap doesn't work.
- Mobile screenshot tools' "full page" capture truncates.
**Fix:** Let the page scroll naturally on `< md` (drop `overflow-hidden` on the wrapper). Inner-scroll is fine on desktop where the sidebar+main pattern needs it.

### P2-9 — Pinned-message bar truncates content with no expand affordance
**Evidence:** `screenshots/02-chat-landing-390.png` — `Maneek · All-hands — Friday 3pm. 30 min. Agen… +1`. The chevron-down is there but it's small.
**Fix:** Make the whole pinned-bar tappable (expand/collapse), and show the chevron at 44×44.

---

## P3 — Polish

- **`/notes` search input is 13px** — auto-zoom on iOS, plus inconsistent with the 14px elsewhere.
- **Settings tab strip ("General / Members / Groups / Tags / Integrations")** scrolls horizontally with no visual fade affordance — user may not notice "Integrations" exists.
- **View switcher icons in `/tasks` are unlabeled** (board / list / calendar / calendar / pipeline) — two of the icons look identical (both calendars). On mobile especially, prefer a labeled segmented control.
- **`/agent` starter prompts** are plain-text strings; tap target equals the visible text only. Increase the tap area with surrounding padding (currently they look like links, not tappable cards).
- **Floating "+" action button on `/tasks`** sits where iOS Safari's bottom toolbar normally floats — risk of accidental URL-bar tap. Consider raising it `bottom: max(env(safe-area-inset-bottom), 16px) + 56px`.
- **"1 thread reply>"** uses a literal `>` character (`screenshots/02`) — replace with a proper chevron icon.
- **`/notes` cards don't open on mobile tap** — the click handler appears to require the desktop split-pane to have already mounted. Wire it to push `?note=<id>` on mobile and render the editor full-screen (the same pattern that worked for the Tasks detail panel and Chat thread panel).
- **`/library` "+ New Note" / "+ Pages" / "+ Activity" header buttons wrap onto a second line** when the page heading is "Library" — the heading should stack on mobile rather than competing for the row.
- **Personality editor route returns 404** for the seeded Alex PM agent (`/settings/agent-employees/7e79b0a9.../personality`). Either the route was renamed or the seed agent isn't OpenClaw-kind. Worth a sanity check independent of mobile.

---

## Wins worth keeping

These already work well at 390px:
- **Sidebar drawer** opens fast, animates correctly, dims the page, restores on backdrop tap.
- **Tasks Board** view collapses statuses into a horizontal tab strip — exactly the right mobile pattern.
- **Tasks Detail** opens full-screen, has a back arrow, status / priority / assignee chips are inline-editable.
- **Chat Thread panel** opens full-screen with back arrow — clean.
- **Calendar Month view** uses tinted dots per date for events.
- **Library cards** stack and read well.
- **Sidebar nav links** all have `min-h-[44px]` on mobile (`sidebar.tsx:147` etc.) — explicit, correct.
- **Notification bell button** is `min-w-[44px] min-h-[44px]` on mobile (`app-header.tsx:121`). Good.

---

## Suggested fix order (by ROI)

1. **P0-1** (unread widget HTML leak) — single-file fix, public-facing data leak.
2. **P0-2 / P0-3** (no send button on agent + chat composer) — wire two buttons; unblocks the entire mobile use case.
3. **P1-1** (16px global on inputs) — one CSS rule, eliminates iOS zoom across the app.
4. **P1-2** (collapse chat formatting toolbar to "Aa" sheet on mobile).
5. **P1-3 / P1-4 / P1-5** (Escape on drawer, autocomplete on login, tap-target padding).
6. **P2-1 / P2-2 / P2-3** (collapse Pipeline + Tasks-Calendar + `/calendar` Week to mobile-friendly variants).
7. **P1-6** (mobile-visible message actions) and **P2-9** (expandable pinned bar).
8. The rest in P2/P3 as polish.

---

## How this was tested

Auth via existing seed user `maneek@test.com`. All viewport probes via Playwright `setViewportSize`. Tap targets, fonts, and overflow flags captured by injecting `getBoundingClientRect()` + `getComputedStyle()` into the page. Each surface was opened, screenshotted, then DOM-probed. No production data was touched.
