# Mobile Spillover Analysis — All Pages

**Date:** 2026-04-24
**Viewport:** 390×844 (iPhone 14)
**Method:** Per route, ran a DOM probe that returns three categories
- **`spills`** — element bounding boxes that extend past `innerWidth` (visual content cut off at the right edge)
- **`clipped`** — `overflow:hidden` containers whose `scrollWidth > clientWidth` (content silently truncated, no affordance)
- **`scrollers`** — `overflow-x: auto|scroll` containers actively scrolling (intentional, but worth listing because the scroll affordance is often invisible)

Plus visual screenshots, captured at `./screenshots/`.

**Routes covered (16):** /login, /dashboard, /chat, /tasks (board, calendar, week, pipeline-attempt), /tasks?task=DEFT-9, /calendar (month, week), /notes, /knowledge, /library, /agent, /reminders, /skills, /skills/deft-mcp-client, /settings/integrations, /settings/agent-employees, /settings/agent-employees/create, /settings/agent-employees/[id]/developer, /settings/members, /settings/workflows, /settings/api-access, /settings/tags

**Page-level horizontal scroll (`html.scrollWidth > clientWidth`):** *NONE found.* Every page contains its overflow inside child elements, so the body never scrolls horizontally — good. The bugs below are all *internal* spillover.

---

## Severity legend
- 🔴 **Critical** — content visibly cut off, overlapping, or unreadable
- 🟠 **High** — content silently truncated where the user must guess at the missing piece
- 🟡 **Medium** — intentional scroller without affordance, or partially clipped tab in a strip
- 🟢 **Low** — single chip / label clipped where ellipsis is acceptable

---

## 🔴 Critical — visible breakage

### C1 — `/settings/api-access`: three rows of overlapping text per card
**Screenshot:** `screenshots/19-settings-api-access.png`
Each API key card stacks five UI atoms in one row:
- masked token (`deft_657f313...`)
- "full access" pill
- "0 requests" label
- toggle switch
- delete icon

On 390px these collide visually — the token text is *behind* the "full access" pill, and the third card adds a fourth conflicting label ("Maneek's Claude Code") on the same axis. Users see three layers of text rendering on top of each other.
**Fix:** stack the meta below the title at `< md`. Toggle + delete row beneath. The desktop "all in one row" pattern doesn't scale.

### C2 — `/settings/agent-employees`: tooltip / role badge overlaps actions
**Screenshot:** `screenshots/16-settings-agents.png`
Row contents: avatar + truncated name "Man..." + "Engineering Lead" pill + "0/50 actions" + "Active" + "Autonomous" + toggle + delete. The "Engineering Lead" black pill renders *on top of* "0/50 actions" / "Active / Autonomous" text. Pure z-index/flex collision.
**Fix:** same as C1 — stack secondary metadata below the name at narrow widths.

### C3 — `/calendar` Week view: hour×day grid clipped 660px past right edge
**Probe:** clipped `1018→358` (660px hidden). Day events ("Sprint retro — gap-fixes week") spill `right:397` beyond viewport.
**Screenshot:** `screenshots/08-calendar-week.png`
The week grid renders 7 day columns plus an hour gutter at desktop column widths and is then `overflow:hidden` clipped with no horizontal scroller. The user sees only the leftmost ~3.5 days; everything else is silently invisible. Events cross into hidden territory and look malformed at the cut edge.
**Fix:** Auto-redirect `view=week → view=day` at `< md`, or wrap the grid in `overflow-x: auto` (with snap stops per day).

### C4 — `/tasks` task detail tabs: "Activity" tab drops off-screen
**Probe:** `Activity` button right=439 (49px past viewport). The tab strip is `637→390`, scrollable but no edge fade.
**Screenshot:** `screenshots/06-task-detail.png`
Tabs visible: Description / Subtasks / Dependencies / Comments / **A**(ctivity cut off). The fifth tab is half-visible; users may not know it exists.
**Fix:** add a right-edge gradient fade (12-16px) on the tab strip to signal scroll, or shorten labels at narrow widths ("Sub" / "Deps" / "Cmts" / "Act").

### C5 — `/tasks` board: "In Review" status pill clipped
**Probe:** `In Review (2)` button right=407 (17px past viewport). Strip is 610→390.
**Screenshot:** `screenshots/03-tasks-board.png`
Same pattern as C4 — the rightmost item in a horizontally scrollable strip is partly visible without an edge-fade affordance.
**Fix:** edge-fade gradient on horizontally-scrollable tab strips, *as a project-wide convention*.

---

## 🟠 High — silent truncation

### H1 — `/dashboard` Unread widget: every preview heavily clipped
**Probe (8 hits, all `overflow:hidden ellipsis`):**
| Full text | Shown |
|---|---|
| `Maneek: <p><strong>Deploy status:</strong> Neon Postgres is …` | 224 of 486 px |
| `Sara: <p>design is green — Knowledge empty state is shipped, …` | 228 of 459 px |
| `Priya: <p>Sharing the final version of the Create Agent wiza…` | 224 of 439 px |
| `Arjun: <p>Shoutout to whoever's been using the agent to summ…` | 224 of 477 px |

Two compounding bugs:
1. The literal `<p>` / `<strong>` tags are leaking into the preview (already filed as P0-1 in mobile-deep audit) — fix at the data layer.
2. Even after the HTML strip, the previews are < 50% visible. On mobile these previews contribute almost no information past the sender name.
**Fix:** allow 2-line wrapping (`-webkit-line-clamp: 2`) at `< md` so the user gets a useful glimpse.

### H2 — `/knowledge`: "Stats" header button and "Procedures" type-filter tab spill
**Probe:**
- `Stats` button right=421 (31px past viewport) — clipped action
- `Procedures` button right=474 (84px past viewport) — second tab strip overflows further
- Header strip with `Knowledge Wiki / + New / Pages / Activity / Stats` is 681→390 (291px hidden) **with no scroller** (the header is `overflow:hidden`, not auto)
**Screenshot:** `screenshots/10-knowledge.png`
**Fix:** the second tab strip is already `overflow-x:auto` and scrolls. The page header (top toolbar) needs to either collapse `Activity / Stats` into a "•••" overflow menu *or* become horizontally scrollable too.

### H3 — `/skills`: "Your org" tab + page header partially clipped
**Probe:**
- `Your org` tab right=417 (27px past viewport)
- Counter badge `0` right=405 (15px past)
- `Skills / Reusable bundles you can install` header is 417→390 (27px clipped, no scroller)
**Screenshot:** `screenshots/14-skills.png`
**Fix:** trim 16-24px of horizontal padding from the page wrapper at `< md`, or ensure the tab strip is `overflow-x:auto`.

### H4 — `/notes`: card titles silently truncated
**Probe:** `H3` "Mobile note detail title that used to cli…" 549→272 px (only 50% shown).
**Screenshot:** `screenshots/09-notes.png`
This is intentional `text-overflow: ellipsis`, but allowing a 2-line clamp would surface ~3× more title text on mobile. Pair with the previously-flagged note-tap-doesn't-open-on-mobile bug — users currently can't even open the note to read its full title.

### H5 — `/calendar` and `/tasks`: Month/Week/Day view-switcher button "Day" partially clipped
**Probe:** `Month / Week / Day` row is 156→140 (16px hidden — the right ~half of "Day" is gone).
**Screenshots:** `screenshots/07-calendar-month.png`, `08-calendar-week.png`
The toggle visually shows "Day" wrapping to a second line in the week view, and is 16px clipped in month view. Right next to it is "Connect Calendar" link wrapping awkwardly.
**Fix:** drop the "Connect Calendar" inline button into a "+" / settings menu at `< md`. With it gone, the segmented control fits.

### H6 — `/chat` channel header strip: 33px hidden right edge, "Catch Up" half visible
**Probe:** strip `general / 2 / 8 / Catch Up` is 389→356 (33px past visible).
**Screenshot:** `screenshots/02-chat.png`
Strip is `overflow-x:auto` (intentional) but the right-side button "Catch Up" is the primary AI surface and being half-visible undersells it. Same edge-fade fix from C4/C5.

---

## 🟡 Medium — intentional scroller without affordance

| Route | Scroller content | Width | Hidden |
|---|---|---|---|
| `/tasks` (any view) | Status tab strip `Backlog (6) / To Do (2) / In Progress (4) / In Review (2) / Done / Cancelled` | 610 | 220px |
| `/tasks?task=DEFT-9` | Detail tab strip `Description / Subtasks / Dependencies / Comments / Activity` | 637 | 247px |
| `/knowledge` | Type filter strip `All / Concepts / Entities / Decisions / Resources / Procedures / Facts` | 615 | 257px |
| `/chat` | Channel header strip | 389 | 33px |
| `/chat` | Messages list (4-pixel padding spillover) | 384 | 4px (false positive — scrollbar) |

All are by-design horizontal scrollers, but none have the "fade + arrow" affordance that signals scrollability. On mobile (no hover, no scrollbar visible by default) users routinely miss these.
**Fix:** project-wide convention — wrap horizontal scroll containers in a parent that adds `mask-image: linear-gradient(to right, black 0, black calc(100% - 24px), transparent)` so the right edge fades, hinting at scroll.

---

## 🟢 Low — small clipped chip / single label

| Route | Element | Probe |
|---|---|---|
| Most pages | Agent picker chip "Maneek's Claude Code" in some chrome | 144→129 (15px clipped) |
| `/notes` | Audit placeholder note title | 270→266 (4px) |
| `/settings/members` | "Maneek's Claude Code" member name | 155→141 (14px) |
| `/agent` | History-sidebar conversation previews ("Create a task titled…") | 343→104 (in hidden right rail) |

These are within ellipsis tolerance — the right call is to leave them with `text-overflow: ellipsis`. Low priority unless we standardize the chip width.

---

## Wins worth keeping

These pages probed *zero* spillover and *zero* clipped overflow at 390px:

- `/settings/integrations` — clean stacked cards
- `/settings/workflows` — clean empty state
- `/settings/tags` — clean empty state
- `/settings/agent-employees/create` — wizard layout adapts well; tabs wrap to 2 lines but stay legible
- `/skills/deft-mcp-client` — JSON code block has its own scroll container (right pattern)
- `/library` (body content) — cards stack cleanly (header has the "Dashboard" stale-title bug but no spillover)
- `/dashboard` (overall) — bento cards stack vertically; only the unread widget previews need the data-layer fix from H1
- `/reminders` — clean empty state

---

## Repeat offenders (worth a global fix)

Each of these patterns shows up on 3+ pages — fix the pattern, not the instance.

1. **Horizontal tab strips with no edge fade** (C4, C5, H2, H6). Single Tailwind utility/class can fix all of them.
2. **Multi-action rows that flex-wrap into overlap** (C1, C2). Always stack secondary metadata beneath the title at `< md` instead of squeezing it horizontally.
3. **Page-header toolbars with too many actions** (H2, H3, H5). Move secondary actions into a "•••" menu at `< md`.
4. **Inner-scroll containers leaking content past the viewport** (C3 calendar, dashboard's `scrollH=3241` from prior audit). Container width math assumes desktop; calendar grid doesn't recompute column widths for mobile.
5. **Stale page-title in `<AppHeader>`** — fixed in the prior audit's P1 bucket; mention here because it was visible on `/library`, `/reminders`, `/settings/agent-employees`, `/settings/api-access`, and `/settings/agent-employees/create` (all show "Settings" or "Dashboard" rather than the page heading).

---

## Suggested fix order (by ROI)

1. **C1 + C2** — stack metadata below the title in `/settings/api-access` and `/settings/agent-employees` rows. Two component fixes resolve the most visually-broken screens in the audit.
2. **C3** — auto-route Calendar Week → Day at `< md`, or scroll-wrap the grid. (The current state silently hides four days of the user's week.)
3. **Repeat-offender #1** — add a tab-strip wrapper component with edge-fade. Resolves C4, C5, H2, H6 in one PR.
4. **H2 + H3** — collapse page-header secondary actions into a "•••" menu (also fixes the stale title bug if you re-touch the header).
5. **H1** — fix the unread widget at the data layer (already in mobile-deep P0-1) and allow 2-line clamp for previews.
6. **H4** — 2-line clamp for note titles + wire mobile-tap to open the note (also previously flagged).
7. **H5** — drop "Connect Calendar" inline button into the settings/+ menu so the view-switcher fits.

---

## Probe methodology

```js
() => {
  const VW = innerWidth, html = document.documentElement;
  const spills = [], clipped = [], scrollers = [];
  document.querySelectorAll('*').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return;
    const cs = getComputedStyle(el);
    // 1. Visual spill — element extends past viewport right edge
    if (r.right > VW + 1 && cs.position !== 'fixed' && r.left < VW && r.left >= -1) {
      const t = (el.innerText||'').trim().slice(0,45);
      if (t && el.children.length < 5) spills.push({tag:el.tagName, right:Math.round(r.right), text:t});
    }
    // 2. Content overflow within a fixed-size container
    if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 80) {
      const ovx = cs.overflowX;
      const item = {tag:el.tagName, sw:el.scrollWidth, cw:el.clientWidth, text:(el.innerText||'').trim().slice(0,40)};
      if (ovx === 'auto' || ovx === 'scroll') scrollers.push(item);
      else if (ovx === 'hidden') clipped.push(item);
    }
  });
  return {
    pageH: { sw: html.scrollWidth, cw: html.clientWidth, overflow: html.scrollWidth > html.clientWidth },
    spills, clipped, scrollers,
  };
}
```

This catches the three real categories of spillover; it does *not* catch z-index collisions where two visible elements overlap each other (C1, C2 were caught by reading screenshots, not the probe). For a stricter pass, add an "intersect any sibling" check.
