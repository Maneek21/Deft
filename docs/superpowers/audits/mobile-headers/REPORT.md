# Mobile Header Design Analysis

**Date:** 2026-04-24
**Viewport:** 390×844 (iPhone 14)
**Source:** `apps/web/src/components/app-header.tsx` + each page's own toolbar
**Screenshots:** `./screenshots/h01-h11.png`

---

## TL;DR — why the headers feel cramped

You're cramming **3-5 stacked rows of chrome** above the content on most pages, while *also* leaving the global header itself half-empty. The result is a viewport that looks busy *and* wastes vertical space at the same time.

| Page | Header rows | Total chrome above content | % of 844px viewport |
|---|---|---|---|
| `/dashboard` | 1 | 48 px | 6% |
| `/reminders` | 2 | ~110 px | 13% |
| `/agent` | 3 | ~165 px | 20% |
| `/chat` | 4 | ~145 px | 17% |
| `/tasks` | 4 | ~205 px | 24% |
| `/calendar` | 4 | ~205 px | 24% |
| `/settings` | 4 | ~205 px | 24% |
| `/notes` | 4 | ~245 px | **29%** |
| `/library` | 4 | ~240 px | 28% |
| `/skills` | 4 | ~240 px | 28% |
| `/knowledge` | 5 | ~245 px | **29%** |

On a 667px iPhone SE these numbers translate to **35-37% of the screen consumed by header chrome before content begins**. That's the cramped feeling.

---

## Problem 1 — The global AppHeader is mostly empty space

**Source:** `apps/web/src/components/app-header.tsx:70-137`

```
[ ☰ ]  [ Chat ]  ←———— ~250px of nothing ————→  [ 🔍 ]  [ 🔔16 ]
```

48px tall, four interactive elements, **only ~140px of the 390px width is actually used**. The breadcrumb word is one of:
`Dashboard / Chat / Tasks / Agent / Settings / Notes / Knowledge / Calendar / Skills`

…and then literally nothing happens for the next ~250 horizontal pixels until the search icon. Two compounding consequences:

1. **The breadcrumb is dead weight.** It tells users what page they're on — but they just tapped to navigate here, *and* every page repeats the same word as a `<h1>` two rows below. Pure redundancy.
2. **The dead space is where the page-context atoms should live** (channel name in /chat, project picker in /tasks, agent picker in /agent, "Apr 24, 2026" in /calendar). Today each page invents its own row to host these, pushing the content further down.

**Fix:** Replace the static breadcrumb with a slot for page-context atoms. The hamburger and bell stay anchored; the middle is whatever the current page wants to put there.

```
Before:
[ ☰ ]  Chat                              [ 🔍 ]  [ 🔔 ]   ← 48px wasted

After:
[ ☰ ]  general  •  Catch Up              [ 🔍 ]  [ 🔔 ]   ← 48px useful (saves a whole 48px row)
```

The breadcrumb word itself disappears — the sidebar's active nav state is the source of truth for "what page am I on", and the hamburger + sidebar is one tap away.

The current `breadcrumb` switch (`pathname.startsWith('/chat')` etc.) also has a real bug — `/library` and `/reminders` aren't in the chain, so they fall through to "Dashboard". Visible in `h07-library.png` and `h11-reminders.png`. Removing the breadcrumb closes that bug too.

---

## Problem 2 — Every page invents its own header pattern

There's no shared layout system, so siblings disagree on where the title, description, actions, and tabs go.

| Page | Pattern (top → bottom) |
|---|---|
| `/notes` | Title + count → Filter chip + folder → Search bar → list |
| `/knowledge` | Title + 4 actions → Scope tabs → Type tabs → list |
| `/library` | Title → Description (2 lines) → Tabs → cards |
| `/skills` | Title → Description (2 lines) → Tabs → cards |
| `/tasks` | Project picker + view-switcher → Filters dropdown → Status tabs → cards |
| `/calendar` | Nav arrows + month → "+ New event" + "Connect Calendar" + Mon/Wk/Day → grid |
| `/chat` | Channel name + meta + Catch Up → Subtitle → Pinned bar → messages |
| `/agent` | Agent picker chips → History button → empty state |
| `/settings` | Tab strip → Page title → content |

`/library` and `/skills` are essentially the same product surface (browse + install) and they almost agree, but everything else feels hand-rolled.

**Fix:** standardize a `<PageHeader>` component with three slots:

```
<PageHeader
  title="Skills"
  primary={<Button>+ New</Button>}      // 1-2 buttons max on mobile
  secondary={<Tabs ... />}              // optional second row
/>
```

Anything that doesn't fit goes into a `•••` overflow menu beside the primary action. Description text moves into a tooltip / info-popover triggered by an `(i)` next to the title, freeing the 30-40px each description chews on `/library`, `/skills`, `/settings/workflows`, etc.

---

## Per-page problems (sorted by severity)

### `/notes` — h05 — 4 stacked rows + 100% redundant title
- AppHeader breadcrumb says "Notes"
- Below: `<h1>Notes</h1>` plus `12 notes` subtitle
- Below: "All Notes" pill + small folder + "+ New Note" — three different actions on one row
- Below: search bar
- 245px gone before the first note card

**Trim:** drop the duplicate "Notes" heading entirely. Move "12 notes" count next to the search-result count. Search bar moves into the global header (replaces the magnifying-glass icon).

### `/knowledge` — h06 — 5 rows, two stacked tab strips
- AppHeader: "Knowledge"
- "Knowledge Wiki" page title (2 lines because + New, Pages, Activity, Stats compete for the same row — Stats is clipped)
- Scope tabs: All / Org / Space / Personal
- Type tabs: All / Concepts / Entities / Decisions / Resources / Procedures / Facts (also clipped)

**Trim:** scope-vs-type is two filter axes — collapse one to a `<select>` ("Show: Org / Space / Personal" dropdown). "Activity" and "Stats" go into a `•••`. Saves an entire row plus the second tab strip's right-edge clipping.

### `/calendar` — h04 — view toggle clipped because of "Connect Calendar"
- AppHeader: "Calendar"
- Nav arrows + "April 2026" + Today
- "+ New event" + "Connect Calendar" link + Month/Week/**D**ay (the "Day" label is clipped — see mobile-spillover H5)

**Trim:** the "Connect Calendar" link belongs in /settings/integrations, not as primary chrome. Removing it lets the segmented control breathe and the page loses one row of competing actions.

### `/tasks` — h03 — view-switcher icons unlabeled, cryptic
- AppHeader: "Tasks"
- Project picker "Deft v1 ▾" + 5 view-switcher icons (board, list, calendar, calendar (?), pipeline) + filter button
- "Filters" dropdown
- Status tabs (Backlog / To Do / In Progress / In Review (clipped))

**Trim:** two icons in the view switcher look identical (both calendars) — distinguish or label them. Move "Filters" into the same row as the project picker (it's an action, not a header). The status tab strip is the right pattern; just add an edge-fade affordance.

### `/chat` — h01 — channel meta strip is six atoms in 48px
- AppHeader: "Chat"
- `general` + pin count + people count + bell + mic state + "Catch Up" pill (overflows; "Catch Up" is half-cut)
- "General discussion" subtitle (with a horizontal scroll bar visible — confusing)
- Pinned message bar with chevron

**Trim:** keep `general` + Catch Up + bell. The mic state, pin count, people count belong in the channel-info modal accessed by tapping the channel name. Subtitle "General discussion" duplicates the channel description shown in that modal — drop on mobile.

### `/library` and `/skills` — h07, h09 — duplicate title pattern
Both follow the same anti-pattern:
- AppHeader breadcrumb (Dashboard ← bug, or Skills)
- `<h1>` repeating the same word
- 2-line description paragraph
- Tabs (Skills/Templates or Bundled/Marketplace/Your-org)

**Trim:** drop the `<h1>`, drop the description (move to `(i)` info popover beside title in app header). Saves ~80px on each page.

### `/settings` — h10 — title appears AFTER the tabs
- AppHeader: "Settings"
- Tab strip: General / Members / Groups / Tags / Integrations
- `<h1>Settings</h1>` (third occurrence of the word "Settings")
- content

**Trim:** drop the `<h1>` (it's the third "Settings" on the screen). Tabs alone are fine — which tab is active is the page title.

### `/agent` — h08 — agent picker doesn't scale
- AppHeader: "Agent"
- Two agent chips inline ("Defty" / "Maneek's Claude Code")
- "History" pill below
- Empty state

**Trim:** at 2 agents the chip row is fine. At 8 agents it'll wrap and become a small grid. Convert to a `<select>` "Defty ▾" with all agents listed, freeing the row for a New Conversation button. Move "History" into the header as a button (or move to a side-drawer like Claude Code).

### `/dashboard` and `/reminders` — h02, h11 — actually fine
- `/dashboard` is just the AppHeader; content begins at 48px. This is the right baseline.
- `/reminders` adds a single icon + title row (~62px); minimal and fine, though the title row could be trimmed by giving the AppHeader a context slot (problem 1 fix).

These two pages are evidence the cramping isn't required — when you don't ladle on extra header rows, the header reads as clean.

---

## Within-row cramming patterns

Even where the row count is reasonable, individual rows mash together too much:

| Pattern | Example | Symptom |
|---|---|---|
| 3+ buttons + title in 48px row | `/knowledge` "Knowledge Wiki + New + Pages + Activity + Stats" | Buttons clipped, header bursts to 2 lines |
| Nav-arrows + title + Today pill | `/calendar` "‹ April 2026 › [Today]" | works, but Today pill is an inconsistent shape vs others |
| Project + view-switcher + filter in one row | `/tasks` "Deft v1 ▾ ⌘⌘⌘⌘⌘ ⚙" | view-switcher icons indistinguishable at 22px each |
| Channel + 5 status atoms + action | `/chat` "general 📌2 👥8 🔔 🎤 [Catch Up]" | atoms at thumbnail size; intent unclear |
| Stacked filter axes | `/knowledge` scope-tabs over type-tabs | Two scrollable tab strips on mobile is too many |

The unifying issue: **mobile chrome is not just "the desktop chrome but smaller".** The desktop versions of these rows have 1200-1400px of width to work with; on 390px the same atom count collapses into either clipping (knowledge "Stats", chat "Catch Up", calendar "Day") or visual mush (tasks view-switcher icons, chat channel-meta atoms).

**Fix pattern:** for any chrome row, define a "mobile manifest" — which atoms survive at `< md`. Everything else collapses into:
- a `•••` overflow menu (for actions)
- the channel/project info modal (for meta read-outs)
- a `<select>` (for filters)

---

## Recommended order of operations

1. **Re-architect AppHeader** to provide a `pageContext` slot in place of the breadcrumb. Single PR, fixes the dead-space + the stale-title bug. (`apps/web/src/components/app-header.tsx:83-87`)
2. **Build a `<PageHeader>` component** with `title / primary / secondary` slots. Migrate `/library`, `/skills`, `/notes`, `/reminders`, `/settings/*` to it first — those are the visually loudest offenders.
3. **Trim each page's manifest at `< md`:** every header row gets either a "ship", "merge into another row", "move to overflow", or "move to info-modal" decision. Notes drops 1 row, knowledge drops 2, library/skills drop 2, settings drops 1.
4. **Tab-strip wrapper component** with right-edge mask-fade — fixes `/knowledge`, `/tasks`, `/chat`, `/calendar` clipping in one go (already called out in mobile-spillover REPORT, repeating because it lives in the header zone).
5. **Channel-strip in /chat:** trim to `general + Catch Up + bell`. Move pin/people/mic into the channel-info modal.

After steps 1-3 alone, average header chrome drops from ~210px to ~96px. That's 114 vertical pixels of content recovered on every screen — roughly two extra task cards visible above the fold.

---

## Wins worth keeping

- **44×44 tap targets** on the global AppHeader hamburger / bell / search-icon — `app-header.tsx:76, 100, 121` already do this correctly with `min-w-[44px] min-h-[44px]`.
- **Notification badge styling** — small, well-positioned, doesn't compete with the bell glyph.
- **Mobile-only icon search button** — correct decision to drop the desktop "Search workspace... ⌘K" pill at `< md`.
- **`/dashboard` header** — proves the chrome doesn't have to be heavy when the page doesn't need extra atoms. Use it as the baseline.
- **`/tasks` board → status-tab collapse** — the right pattern in principle; just needs the edge-fade affordance.
