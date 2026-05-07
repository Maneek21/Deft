# Mobile UX Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 40+ findings from the three mobile audits (`docs/superpowers/audits/mobile-deep`, `mobile-spillover`, `mobile-headers`) so Deft is usable on a 390×844 phone — composer can send, chrome doesn't waste 25% of the viewport, no horizontal spillover, no auto-zoom on input focus.

**Architecture:** Build foundation primitives once (`MobileInputs` global rule, `<TabStrip>`, `<PageHeader>`, `AppHeader` context slot), then apply them across pages. Group fixes into 6 phases that can each ship independently. Phase 0 is a single-PR data fix; phases 1-2 introduce shared components; phases 3-6 are application of those primitives across the 25 routes.

**Tech Stack:** Next.js 14 App Router, TypeScript, Tailwind CSS, TipTap (chat composer), Playwright (audit harness at `docs/superpowers/audits/`), pnpm workspaces.

---

## Source audits (the spec)

- `docs/superpowers/audits/mobile-deep/REPORT.md` — auth/chat/agent/dashboard issues, P0-P3 severity
- `docs/superpowers/audits/mobile-spillover/REPORT.md` — overflow / clipping / layout-collision issues per route
- `docs/superpowers/audits/mobile-headers/REPORT.md` — header design analysis with per-page recommendations

If a finding here references "P0-1" / "C3" / "Problem 2" — open the audit. The audits are the canonical spec; this plan is the execution path.

---

## Phase map

Each phase is a self-contained shipping unit. Suggested PR per phase.

| Phase | Theme | Tasks | Risk | Why this order |
|---|---|---|---|---|
| **0** | Data-layer + breadcrumb bugs | 3 | low | Single-file fixes; ship before any layout work to remove the "raw HTML" embarrassment |
| **1** | Foundation primitives | 5 | medium | `<TabStrip>`, `<PageHeader>`, mobile-input CSS, sidebar Escape — every later phase depends on these |
| **2** | AppHeader re-architecture | 4 | medium | New `pageContext` slot; remove static breadcrumb; wire 2 pages to prove the slot works |
| **3** | Composer rebuild (chat + agent) | 6 | medium-high | TipTap toolbar collapse; explicit send button; safe-area; this is the P0 ship-blocker |
| **4** | Per-page header trims | 9 | low | Apply Phase 1+2 primitives to /notes, /knowledge, /library, /skills, /settings, /calendar, /tasks, /chat, /agent |
| **5** | Layout collisions + view rescues | 5 | medium | `/settings/api-access` row stack, `/settings/agent-employees`, calendar week→day, tasks pipeline collapse, dashboard inner-scroll |
| **6** | Auth & polish | 8 | low | Autocomplete, autofocus, password toggle, note 2-line clamp + mobile-tap navigation, agent picker, long-press chat actions, pinned-bar expander, dev-tools indicator audit |

**Total:** 40 tasks across 6 phases.

---

## File responsibilities (locked-in decomposition)

New files:
- `apps/web/src/components/page-header.tsx` — shared `<PageHeader title primary secondary />` (Phase 1)
- `apps/web/src/components/tab-strip.tsx` — horizontal scroll wrapper with right-edge mask-fade (Phase 1)
- `apps/web/src/components/mobile-action-sheet.tsx` — bottom-sheet for the chat formatting toolbar (Phase 3)
- `apps/web/src/lib/strip-html.ts` — single canonical helper for unread previews (Phase 0)
- `apps/web/test/audits/mobile-headers.audit.ts` — Playwright regression harness (extends existing `docs/superpowers/audits/`)

Modified:
- `apps/web/src/components/app-header.tsx` — `pageContext` slot, breadcrumb removal (Phase 2)
- `apps/web/src/components/sidebar.tsx` — Escape handler, `role="dialog"` (Phase 1)
- `apps/web/src/components/space-chat.tsx` — composer toolbar collapse, send button (Phase 3)
- `apps/web/src/components/agent-chat.tsx` — composer send button (Phase 3)
- `apps/web/src/app/globals.css` — 16px input rule for `< md` (Phase 1)
- `apps/web/src/app/(app)/dashboard/widgets/unread.tsx` — strip HTML before truncating (Phase 0)
- `apps/web/src/app/(app)/{notes,knowledge,library,skills,settings,calendar,tasks,chat,agent}/page.tsx` — Phase 4 migrations
- `apps/web/src/app/(app)/settings/api-access/page.tsx` and `agent-employees/page.tsx` — Phase 5 row layout
- `apps/web/src/app/login/page.tsx` and `signup/page.tsx` — Phase 6 form polish

---

## Conventions for every task

1. **Always work in `apps/web/`** — no other workspace touched by this plan.
2. **Run the dev server** (`pnpm dev` from repo root, or `pnpm --filter web dev`) — verify visually after each task.
3. **Manual mobile verification:** Chrome DevTools at 390×844 (iPhone 14) and 375×667 (iPhone SE).
4. **Test infrastructure:** the audit harness at `docs/superpowers/audits/` already runs Playwright via `pnpm audit:session1/2/3`. Phase 4-6 tasks add a new `mobile-headers.audit.ts` that asserts header heights and overflow predicates per route.
5. **Commit per task** with message form: `fix(scope): <one-liner>` or `feat(scope): <one-liner>`.
6. **No `--no-verify`** on commits. If hooks fail, fix the underlying issue.

---

# Phase 0 — Data-layer + breadcrumb bugs

Three independent single-file fixes. Ship as one PR.

## Task 0.1 — Strip HTML from unread message previews (audit P0-1)

**Files:**
- Create: `apps/web/src/lib/strip-html.ts`
- Modify: `apps/web/src/app/(app)/dashboard/widgets/unread.tsx:51`

**Why:** `screenshots/07-dashboard-mid-390.png` in mobile-deep shows literal `<p><strong>Deploy status:</strong></st…` rendered as text. The widget interpolates `s.last_message` from the dashboard facade, which carries TipTap HTML.

**Steps:**

- [ ] **Step 1: Write the helper**

Create `apps/web/src/lib/strip-html.ts`:

```ts
/**
 * Strip HTML tags + decode common entities from a string.
 * Used for plain-text previews of TipTap-rendered content.
 */
export function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
```

- [ ] **Step 2: Wire it in the widget**

In `apps/web/src/app/(app)/dashboard/widgets/unread.tsx`, add the import at top and update line 51:

```tsx
import { stripHtml } from '@/lib/strip-html';

// line 51, replace:
{s.last_message_by ? `${s.last_message_by.split(' ')[0]}: ` : ''}{stripHtml(s.last_message)}
```

- [ ] **Step 3: Verify on /dashboard**

Run dev server, log in as `maneek@test.com / test1234`, open `/dashboard` at 390px. Scroll to "UNREAD" card. Confirm previews now read like prose ("Maneek: Deploy status: Neon Postgres is …"), no `<p><strong>` markup.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/strip-html.ts apps/web/src/app/(app)/dashboard/widgets/unread.tsx
git commit -m "fix(dashboard): strip HTML from unread message previews"
```

## Task 0.2 — Fix stale `breadcrumb` for `/library` and `/reminders`

**Files:**
- Modify: `apps/web/src/components/app-header.tsx:26-34`

**Why:** mobile-headers report `screenshots/h07-library.png` and `h11-reminders.png` show "Dashboard" instead of "Library" / "Reminders". The if-chain in `app-header.tsx:26-34` doesn't include those paths.

NOTE: this is a stop-gap. Phase 2 removes the breadcrumb entirely. Doing this now prevents the bug from being visible in Phase 0 ship.

**Steps:**

- [ ] **Step 1: Extend the breadcrumb chain**

In `apps/web/src/components/app-header.tsx`, replace lines 26-34:

```tsx
let breadcrumb = 'Deft';
if (pathname.startsWith('/dashboard')) breadcrumb = 'Dashboard';
if (pathname.startsWith('/chat')) breadcrumb = 'Chat';
if (pathname.startsWith('/tasks')) breadcrumb = 'Tasks';
if (pathname.startsWith('/agent')) breadcrumb = 'Agent';
if (pathname.startsWith('/settings')) breadcrumb = 'Settings';
if (pathname.startsWith('/notes')) breadcrumb = 'Notes';
if (pathname.startsWith('/knowledge')) breadcrumb = 'Knowledge';
if (pathname.startsWith('/calendar')) breadcrumb = 'Calendar';
if (pathname.startsWith('/skills')) breadcrumb = 'Skills';
if (pathname.startsWith('/library')) breadcrumb = 'Library';
if (pathname.startsWith('/reminders')) breadcrumb = 'Reminders';
```

- [ ] **Step 2: Verify**

Visit `/library` and `/reminders` at 390px. Confirm header shows the matching word.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/app-header.tsx
git commit -m "fix(app-header): map /library and /reminders to correct breadcrumb"
```

## Task 0.3 — `/tasks?view=list` and `?view=pipeline` redirect to board on mobile

**Files:**
- Inspect: `apps/web/src/app/(app)/tasks/page.tsx`

**Why:** mobile-spillover audit observed `/tasks?view=list` and `?view=pipeline` both URL-rewrite to `?view=board`. Either intentional (mobile-only fallback) or a bug. If intentional, document it; if not, fix it.

**Steps:**

- [ ] **Step 1: Reproduce + investigate**

Open `apps/web/src/app/(app)/tasks/page.tsx`. Search for `view=` and `searchParams`. Note whether `view=list|pipeline` is being normalized to `board` somewhere, and whether it's gated on a viewport check.

- [ ] **Step 2: Decide and act**

If the rewrite is intentional (e.g. board+tabs is the only mobile-friendly variant), leave the behavior but add a comment at the rewrite site:

```ts
// Mobile collapses pipeline/list to board (status-tab pattern). Desktop preserves the choice.
```

If it's accidental, remove the rewrite and let `?view=list|pipeline` work — Phase 5 will add a proper mobile pipeline collapse.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/(app)/tasks/page.tsx
git commit -m "fix(tasks): clarify or remove view=list|pipeline → board mobile rewrite"
```

---

# Phase 1 — Foundation primitives

Five tasks that build the components every later phase reuses. **Do not skip.**

## Task 1.1 — Global 16px input rule (audit P1-1)

**Files:**
- Modify: `apps/web/src/app/globals.css`

**Why:** iOS Safari auto-zooms any input/textarea/contenteditable with computed `font-size < 16px`. Login (14px), chat composer (14px), agent textarea (14px), notes search (13px) all trigger this.

**Steps:**

- [ ] **Step 1: Add the global rule**

Append to `apps/web/src/app/globals.css`:

```css
/* Prevent iOS Safari from auto-zooming on input focus.
   Inputs are visually 14px on desktop via Tailwind utilities; on mobile we override to 16px,
   which is the threshold below which iOS auto-zooms. */
@media (max-width: 767px) {
  input,
  textarea,
  select,
  [contenteditable="true"],
  .ProseMirror {
    font-size: 16px !important;
  }
}
```

- [ ] **Step 2: Verify on iOS Safari (or Chrome DevTools mobile emulation)**

At 390px, focus the email field on `/login`, the message composer on `/chat`, the agent textarea on `/agent`, the search input on `/notes`. None of them should trigger a viewport-zoom.

- [ ] **Step 3: Verify desktop unaffected**

At ≥768px, confirm inputs still render at their original size (14px or whatever the component used).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/globals.css
git commit -m "fix(mobile): force 16px input font-size on <md to stop iOS auto-zoom"
```

## Task 1.2 — `<TabStrip>` component with edge-fade (mobile-spillover repeat-offender #1)

**Files:**
- Create: `apps/web/src/components/tab-strip.tsx`

**Why:** Audit shows tab strips on `/tasks` (status), `/tasks` (detail), `/knowledge` (type), `/chat` (channel header), `/calendar` (view-toggle) all overflow horizontally with no scroll affordance. Right-edge mask-gradient is the universal fix.

**Steps:**

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/tab-strip.tsx`:

```tsx
import { ReactNode, HTMLAttributes } from 'react';

type Props = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  /** When true, applies the right-edge fade indicating more content is scrollable. Default true. */
  fade?: boolean;
};

/**
 * Horizontally-scrollable strip with a right-edge mask-fade affordance.
 * Use for tab bars, chip rows, or any chrome where mobile users would otherwise miss off-screen content.
 */
export function TabStrip({ children, fade = true, className = '', ...rest }: Props) {
  const fadeStyle = fade
    ? {
        WebkitMaskImage: 'linear-gradient(to right, black 0, black calc(100% - 24px), transparent 100%)',
        maskImage: 'linear-gradient(to right, black 0, black calc(100% - 24px), transparent 100%)',
      }
    : undefined;
  return (
    <div
      role="tablist"
      className={`flex gap-1.5 overflow-x-auto overflow-y-hidden no-scrollbar ${className}`}
      style={fadeStyle}
      {...rest}
    >
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Add `.no-scrollbar` utility if not present**

Check `apps/web/src/app/globals.css` for `.no-scrollbar`. If absent, add:

```css
.no-scrollbar { scrollbar-width: none; }
.no-scrollbar::-webkit-scrollbar { display: none; }
```

- [ ] **Step 3: Smoke-test by replacing one existing tab strip**

Find the simplest existing strip — `apps/web/src/components/space-chat.tsx` channel-header strip is fine — and wrap it in `<TabStrip>`. Verify the fade renders, scroll still works, no layout shift.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/tab-strip.tsx apps/web/src/app/globals.css apps/web/src/components/space-chat.tsx
git commit -m "feat(ui): add TabStrip component with right-edge fade affordance"
```

## Task 1.3 — `<PageHeader>` component with title/primary/secondary slots (mobile-headers Problem 2)

**Files:**
- Create: `apps/web/src/components/page-header.tsx`

**Why:** Every page invents its own header pattern (mobile-headers report Problem 2). One shared component with three slots stops the divergence.

**Steps:**

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/page-header.tsx`:

```tsx
import { ReactNode } from 'react';

type Props = {
  /** Page title. Hidden on mobile if `compact` (the AppHeader pageContext slot will carry it). */
  title: string;
  /** Optional 1-line description. Hidden on mobile to save vertical space. */
  description?: string;
  /** Primary action(s) — render in the right of the title row. ≤2 buttons recommended on mobile. */
  primary?: ReactNode;
  /** Secondary row — typically a TabStrip or filter set. Renders below the title. */
  secondary?: ReactNode;
  /** When true, hides title+description on mobile. Use when the page wires AppHeader pageContext slot. */
  compact?: boolean;
};

/**
 * Standard page header. Use for every top-level route under (app).
 * On mobile, pair with AppHeader.pageContext to avoid duplicating the title.
 */
export function PageHeader({ title, description, primary, secondary, compact }: Props) {
  return (
    <div className="flex flex-col gap-2 px-4 pt-2 pb-3">
      <div className={compact ? 'hidden md:flex items-center gap-3' : 'flex items-center gap-3'}>
        <h1 className="text-[1.5rem] font-semibold flex-1 truncate" style={{ color: 'var(--on-surface)' }}>
          {title}
        </h1>
        {primary && <div className="flex items-center gap-2">{primary}</div>}
      </div>
      {description && (
        <p className="hidden md:block text-[0.875rem]" style={{ color: 'var(--on-surface-variant)' }}>
          {description}
        </p>
      )}
      {secondary && <div className="-mx-1">{secondary}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Don't migrate anything yet**

Phases 2-4 do the migrations. Just commit the primitive.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/page-header.tsx
git commit -m "feat(ui): add PageHeader component with title/primary/secondary slots"
```

## Task 1.4 — Mobile sidebar Escape + `role="dialog"` (audit P1-3)

**Files:**
- Modify: `apps/web/src/components/sidebar.tsx`

**Why:** mobile-deep audit confirmed `Escape` key doesn't dismiss the mobile drawer (only backdrop click does). The drawer has neither `role="dialog"` nor `aria-modal`.

**Steps:**

- [ ] **Step 1: Find the open-state hook in `sidebar.tsx`**

Locate the boolean state controlling the mobile drawer (likely `open` / `isOpen` / `mobileOpen` — check around line 1038 where the backdrop is rendered).

- [ ] **Step 2: Add Escape handler + ARIA**

In the same file, add a `useEffect` that listens on `keydown`:

```tsx
useEffect(() => {
  if (!mobileOpen) return;
  const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setMobileOpen(false); };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}, [mobileOpen, setMobileOpen]);
```

(Substitute the actual state/setter names from Step 1.)

On the `<aside>` element, add the ARIA attributes (only when open on mobile):

```tsx
<aside
  role={mobileOpen ? 'dialog' : undefined}
  aria-modal={mobileOpen ? 'true' : undefined}
  aria-label={mobileOpen ? 'Navigation' : undefined}
  ...
>
```

- [ ] **Step 3: Verify**

At 390px: tap hamburger → drawer opens → press Escape → drawer closes. Check screen-reader output mentions "Navigation dialog" when open.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/sidebar.tsx
git commit -m "fix(sidebar): mobile drawer dismisses on Escape and exposes role=dialog"
```

## Task 1.5 — Sidebar safe-area for iOS home indicator (audit P2-7)

**Files:**
- Modify: `apps/web/src/components/sidebar.tsx`

**Why:** Bottom user pill in the drawer overlaps the iOS home-indicator area on devices with no physical home button.

**Steps:**

- [ ] **Step 1: Apply safe-area padding**

In the user-row container at the bottom of the sidebar (around line 808-816 area), add:

```tsx
className="... pb-[max(env(safe-area-inset-bottom),12px)]"
```

Also ensure the `<aside>` itself uses `pt-[env(safe-area-inset-top)]` if status-bar overlap is observed.

- [ ] **Step 2: Verify**

Test in Safari iOS simulator or Chrome DevTools "iPhone 14 Pro" preset (which includes safe-area emulation). User pill should sit above the home-indicator bar.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/sidebar.tsx
git commit -m "fix(sidebar): respect iOS safe-area at drawer bottom"
```

---

# Phase 2 — AppHeader re-architecture

The biggest single UX win. The breadcrumb word in the global header consumes ~250px of dead space *and* duplicates each page's `<h1>`. Replace it with a `pageContext` slot that pages can inject channel/project/date/agent atoms into.

## Task 2.1 — Add `pageContext` to `<AppHeader>` props

**Files:**
- Modify: `apps/web/src/components/app-header.tsx`
- Modify: `apps/web/src/app/(app)/layout.tsx` (or wherever `<AppHeader>` is rendered)

**Steps:**

- [ ] **Step 1: Extend the prop signature**

In `apps/web/src/components/app-header.tsx`, change the function signature:

```tsx
export function AppHeader({
  onMenuClick,
  pageContext,
}: {
  onMenuClick?: () => void;
  pageContext?: ReactNode;
}) {
```

- [ ] **Step 2: Render the slot in place of the breadcrumb**

Replace the `<span className="text-[0.8125rem] font-medium">{breadcrumb}</span>` block (lines 83-85) with:

```tsx
<div className="flex-1 min-w-0 flex items-center gap-2">
  {pageContext}
</div>
```

(Drop the `<div className="flex-1" />` spacer below — the new slot handles flex-grow.)

- [ ] **Step 3: Delete the now-dead breadcrumb logic**

Remove lines 26-34 (the if/else chain) and any unused `pathname` reference. Keep `usePathname` only if `placeholder` (search hint) still uses it — yes it does at lines 21-24, so leave it.

- [ ] **Step 4: Update the consumer**

In `apps/web/src/app/(app)/layout.tsx`, find where `<AppHeader />` is rendered. Don't pass `pageContext` yet (Phase 4 wires it per page); the slot defaults to empty.

- [ ] **Step 5: Verify**

Visit any page at 390px. Header should show `[☰] [empty space] [🔍] [🔔]`. The empty space is now ready to receive page-specific atoms in Phase 4.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/app-header.tsx apps/web/src/app/(app)/layout.tsx
git commit -m "feat(app-header): replace static breadcrumb with pageContext slot"
```

## Task 2.2 — Mechanism for pages to set `pageContext`

**Files:**
- Create: `apps/web/src/components/app-header-context.tsx`
- Modify: `apps/web/src/app/(app)/layout.tsx`
- Modify: `apps/web/src/components/app-header.tsx`

**Why:** Pages need a way to push content into the header from inside their tree. React Context is the simplest fit.

**Steps:**

- [ ] **Step 1: Create the context module**

Create `apps/web/src/components/app-header-context.tsx`:

```tsx
'use client';
import { createContext, useContext, useState, ReactNode } from 'react';

type Ctx = {
  pageContext: ReactNode;
  setPageContext: (node: ReactNode) => void;
};

const AppHeaderContext = createContext<Ctx | null>(null);

export function AppHeaderProvider({ children }: { children: ReactNode }) {
  const [pageContext, setPageContext] = useState<ReactNode>(null);
  return (
    <AppHeaderContext.Provider value={{ pageContext, setPageContext }}>
      {children}
    </AppHeaderContext.Provider>
  );
}

export function useAppHeaderContext() {
  const ctx = useContext(AppHeaderContext);
  if (!ctx) throw new Error('useAppHeaderContext must be used inside AppHeaderProvider');
  return ctx;
}

/** Hook for pages: call once at the top of a client component to set header context. */
export function useSetPageContext(node: ReactNode, deps: unknown[] = []) {
  const { setPageContext } = useAppHeaderContext();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setPageContext(node); return () => setPageContext(null); }, deps);
}
```

(Add the `useEffect` import at the top.)

- [ ] **Step 2: Wire the provider in the (app) layout**

In `apps/web/src/app/(app)/layout.tsx`, wrap the layout body in `<AppHeaderProvider>`. Then read the context inside a small client component that renders `<AppHeader pageContext={pageContext} />`.

If the layout is currently a Server Component, extract a small client component `<AppHeaderHost>` that calls `useAppHeaderContext()` and renders the header.

- [ ] **Step 3: Smoke-test from one page**

In `apps/web/src/app/(app)/dashboard/page.tsx` (Dashboard is the simplest), at the top of the component:

```tsx
useSetPageContext(<span className="text-[0.875rem] font-semibold">Dashboard</span>);
```

Visit `/dashboard` — confirm "Dashboard" appears in the AppHeader where the breadcrumb used to be.

- [ ] **Step 4: Revert the dashboard change**

The Phase 4 dashboard task will set its real context (the date or "Good morning, Maneek" greeting). Don't leave the smoke-test in.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/app-header-context.tsx apps/web/src/app/(app)/layout.tsx apps/web/src/components/app-header.tsx
git commit -m "feat(app-header): add AppHeaderContext for pages to inject pageContext"
```

## Task 2.3 — Verify the empty header doesn't regress accessibility

**Steps:**

- [ ] **Step 1: Test that the page is still announced correctly**

With the breadcrumb removed, screen readers no longer get a route announcement from the header. Confirm each page's `<title>` (set by `metadata` or `<head>`) still updates per route — the document title is what AT relies on.

Open `/notes`, `/tasks`, `/agent` and check `document.title` in DevTools console. Each should be "Notes — Deft", "Tasks — Deft", etc.

- [ ] **Step 2: If any title is wrong, fix the page's `metadata` export**

In each `apps/web/src/app/(app)/<route>/page.tsx` or `layout.tsx`, ensure:

```ts
export const metadata = { title: 'Notes — Deft' };
```

- [ ] **Step 3: Commit (only if any fixes were needed)**

```bash
git add apps/web/src/app/(app)/**/page.tsx
git commit -m "fix(meta): ensure each route has a correct document title"
```

## Task 2.4 — Add header-zone Playwright assertion

**Files:**
- Modify: `docs/superpowers/audits/agent-ui-session-1.audit.ts` (or add to a new `mobile-headers.audit.ts`)

**Why:** Lock in the header trim so a future commit doesn't regress chrome height.

**Steps:**

- [ ] **Step 1: Add a 96px max-chrome assertion**

In a new `docs/superpowers/audits/mobile-headers.audit.ts`, add a test that:
- Sets viewport 390×844
- Navigates to `/dashboard`
- Asserts the first child of `<main>` has `getBoundingClientRect().y < 96`

```ts
const y = await page.locator('main > *').first().evaluate(el => el.getBoundingClientRect().y);
assert(y < 96, `Dashboard chrome above content is ${y}px (expected <96)`);
```

(Phase 4 will add per-page assertions for the other routes.)

- [ ] **Step 2: Run + record baseline**

```bash
pnpm tsx docs/superpowers/audits/mobile-headers.audit.ts
```

If it passes, commit. If it fails, the dashboard chrome is still too tall — that's a Phase 4 fix; mark this assertion as `.skip` for now and revisit in Phase 4.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/audits/mobile-headers.audit.ts
git commit -m "test(mobile): add header-zone height assertion for /dashboard"
```

---

# Phase 3 — Composer rebuild (chat + agent)

The audit's other P0 (no send button on mobile) lives here. This phase is the riskiest — TipTap toolbar work can break desktop if not careful.

## Task 3.1 — Add an explicit send button to the chat composer (audit P0-3)

**Files:**
- Modify: `apps/web/src/components/space-chat.tsx`

**Why:** Mobile soft keyboards insert a newline on Enter. Without a send button, mobile users cannot post a message. Audit confirmed `document.querySelectorAll('button')` filtered by `lucide-send|lucide-arrow-up|aria-label*=send` returns 0.

**Steps:**

- [ ] **Step 1: Locate the composer toolbar row**

In `space-chat.tsx`, find the bottom composer area. It currently has buttons for attach, emoji, mic. Add the send button to the right of those.

- [ ] **Step 2: Add the send button**

```tsx
import { Send } from 'lucide-react';

// inside the composer toolbar, rightmost:
<button
  type="button"
  onClick={handleSend}
  disabled={!editor || editor.isEmpty}
  aria-label="Send message"
  className="flex items-center justify-center min-w-[44px] min-h-[44px] rounded-md disabled:opacity-40"
  style={{ background: 'var(--primary)', color: 'var(--on-primary)' }}
>
  <Send size={18} strokeWidth={2} />
</button>
```

`handleSend` is whatever the existing Enter-to-send handler is — reuse it directly.

- [ ] **Step 3: Verify on mobile + desktop**

390px: tap composer, type "hello", tap send. Message posts. Desktop: Enter still sends (don't break that).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/space-chat.tsx
git commit -m "fix(chat): add explicit send button to composer for mobile"
```

## Task 3.2 — Add an explicit send button to the agent composer (audit P0-2)

**Files:**
- Modify: `apps/web/src/components/agent-chat.tsx`

**Steps:**

- [ ] **Step 1: Locate the agent composer textarea + handler**

Find the `<textarea>` in `agent-chat.tsx`. Identify the existing send handler (search for `keyDown` / `handleSubmit`).

- [ ] **Step 2: Add the send button next to the textarea**

Mirror Task 3.1's pattern. Place the send button as the rightmost element in a flex row that contains the textarea.

- [ ] **Step 3: Verify**

390px on `/agent`: type a message, tap send, confirm a request is dispatched (network tab → `POST /api/agent/...`).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/agent-chat.tsx
git commit -m "fix(agent): add explicit send button to composer for mobile"
```

## Task 3.3 — Collapse chat formatting toolbar to "Aa" sheet on mobile (audit P1-2)

**Files:**
- Create: `apps/web/src/components/mobile-action-sheet.tsx`
- Modify: `apps/web/src/components/space-chat.tsx`

**Why:** Audit found 9 markdown buttons at 22×22 px (half the 44×44 W3C minimum). Tooltips reference `Cmd+B` shortcuts that don't exist on mobile.

**Steps:**

- [ ] **Step 1: Build the sheet primitive**

Create `apps/web/src/components/mobile-action-sheet.tsx`:

```tsx
'use client';
import { ReactNode, useEffect } from 'react';

type Props = {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
};

export function MobileActionSheet({ open, onClose, title, children }: Props) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className="md:hidden fixed inset-0 z-40 bg-black/40" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="md:hidden fixed bottom-0 left-0 right-0 z-50 rounded-t-2xl pb-[max(env(safe-area-inset-bottom),16px)] pt-3"
        style={{ background: 'var(--surface)' }}
      >
        {title && <div className="px-4 pb-2 text-[0.8125rem] font-semibold opacity-70">{title}</div>}
        <div className="px-2 pb-2">{children}</div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Hide the desktop toolbar on `< md` and add an "Aa" trigger**

In `space-chat.tsx`, find the formatting toolbar block (B / I / S / `<>` / etc.). Wrap it in `hidden md:flex`. Below it, add:

```tsx
<button
  type="button"
  onClick={() => setFormatSheetOpen(true)}
  aria-label="Formatting"
  className="md:hidden flex items-center justify-center min-w-[44px] min-h-[44px] rounded-md"
  style={{ color: 'var(--on-surface-variant)' }}
>
  <span className="text-[0.875rem] font-serif">Aa</span>
</button>
<MobileActionSheet open={formatSheetOpen} onClose={() => setFormatSheetOpen(false)} title="Format">
  {/* re-render the same toolbar buttons but at 44×44 each in a 4-col grid */}
  <div className="grid grid-cols-4 gap-2">
    {/* one button per format action */}
  </div>
</MobileActionSheet>
```

Use `useState` for `formatSheetOpen`. Re-use the same TipTap-toggle handlers in the sheet buttons — extract them into named functions if they're inlined.

- [ ] **Step 3: Verify**

390px: composer toolbar shows only Aa + attach + emoji + mic + send. Tap Aa → bottom sheet opens with 9 large format buttons (4-col grid). Tap any → format applies, sheet stays open. Tap backdrop or Escape → sheet closes. Desktop: original toolbar unchanged.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/mobile-action-sheet.tsx apps/web/src/components/space-chat.tsx
git commit -m "feat(chat): collapse formatting toolbar to bottom sheet on <md"
```

## Task 3.4 — Composer safe-area + iOS keyboard handling

**Files:**
- Modify: `apps/web/src/components/space-chat.tsx`
- Modify: `apps/web/src/components/agent-chat.tsx`

**Why:** When the iOS keyboard opens, the composer needs to sit above it. Today the `position: fixed` composer can be hidden by the keyboard, and on devices without a home button the home-indicator overlaps the composer at rest.

**Steps:**

- [ ] **Step 1: Add safe-area padding**

In both composers, the bottom-most container should add:

```tsx
className="... pb-[max(env(safe-area-inset-bottom),8px)]"
```

- [ ] **Step 2: Use `dvh` units instead of `vh` for the messages list**

Find the messages-list height (likely `h-screen` or `100vh`). Replace with `100dvh` (dynamic viewport height — shrinks when the iOS URL bar/keyboard appears).

- [ ] **Step 3: Verify on real device**

Best done on a real iPhone via local network. At minimum, test in iOS Safari simulator — focus the composer and confirm messages remain visible above the keyboard.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/space-chat.tsx apps/web/src/components/agent-chat.tsx
git commit -m "fix(composer): respect iOS safe-area and use dvh for keyboard-safe layout"
```

## Task 3.5 — Mobile-visible per-message actions (audit P1-6)

**Files:**
- Modify: `apps/web/src/components/space-chat.tsx`

**Why:** Per-message hover actions (3-dot menu, reaction picker) live inside `opacity-0 group-hover:opacity-100`. Mobile has no hover, so actions are invisible.

**Steps:**

- [ ] **Step 1: Toggle the visibility on touch devices**

Find the per-message action container in `space-chat.tsx`. Replace the `opacity-0 group-hover:opacity-100` pattern with:

```tsx
className="opacity-100 md:opacity-0 md:group-hover:opacity-100"
```

This shows actions always on `< md`, only-on-hover on `≥ md`.

- [ ] **Step 2: Make sure layout doesn't shift**

The 3-dot button on every message will now reserve space on mobile. Check that message text still wraps correctly (right padding accounts for the ellipsis button).

- [ ] **Step 3: Verify**

390px: every message row shows the `•••` button on the right. Tap it → existing action menu opens.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/space-chat.tsx
git commit -m "fix(chat): always show per-message actions on <md (no hover on touch)"
```

## Task 3.6 — Trim chat channel-meta strip (mobile-headers `/chat` finding)

**Files:**
- Modify: `apps/web/src/components/space-chat.tsx`

**Why:** Channel header today: `general + 📌2 + 👥8 + 🔔 + 🎤 + Catch Up` — 6 atoms in a 48px strip that overflows. mobile-headers report recommends keeping `general + Catch Up + bell` only on mobile; pin/people/mic move into the channel-info modal accessed by tapping the channel name.

**Steps:**

- [ ] **Step 1: Hide the secondary atoms at `< md`**

Wrap pin-count, people-count, mic-state buttons with `hidden md:flex`. Keep channel name, bell, and "Catch Up" pill always-visible.

- [ ] **Step 2: Make the channel name tappable to open the channel-info modal on mobile**

If the channel-info modal exists (search for "channel info" / "channel settings"), add an `onClick` to the channel-name span at `< md` that opens it. If the modal doesn't exist yet, leave a TODO comment and create a follow-up task — don't build it inside this plan.

- [ ] **Step 3: Verify**

390px on `/chat`: header strip shows `general` + `Catch Up` + `🔔`. No overflow. No clipping.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/space-chat.tsx
git commit -m "fix(chat): trim channel header strip on <md (keep name + Catch Up + bell)"
```

---

# Phase 4 — Per-page header trims

Apply Phase 1+2 primitives to each route. Each task is mostly mechanical: drop the duplicate `<h1>`, drop the description on mobile, push secondary actions to a `•••`, wrap tab strips in `<TabStrip>`, optionally inject a `pageContext` atom.

## Task 4.1 — `/notes` header trim (mobile-headers `/notes` finding)

**Files:**
- Modify: `apps/web/src/app/(app)/notes/page.tsx`

**Steps:**

- [ ] **Step 1: Replace existing header with `<PageHeader>`**

Drop the duplicate `<h1>Notes</h1>` and the "12 notes" subtitle row. Use:

```tsx
<PageHeader
  title="Notes"
  primary={<button onClick={openNewNote} className="...">+ New Note</button>}
  compact
/>
```

- [ ] **Step 2: Move the search input into the AppHeader pageContext on mobile**

```tsx
useSetPageContext(
  <input
    type="search"
    placeholder="Search notes…"
    value={search}
    onChange={e => setSearch(e.target.value)}
    className="md:hidden w-full bg-transparent text-[0.875rem] outline-none"
  />,
  [search]
);
```

(Keep the desktop search input as-is.)

- [ ] **Step 3: Drop the "All Notes" filter chip and folder add icon from the page header**

Move them into a `•••` overflow button at the right of the title row.

- [ ] **Step 4: Verify**

390px: chrome above first note ≤ 110px (was ~245px).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/(app)/notes/page.tsx
git commit -m "fix(notes): trim mobile header to single row + AppHeader search"
```

## Task 4.2 — `/knowledge` header trim (mobile-headers `/knowledge` finding)

**Files:**
- Modify: `apps/web/src/app/(app)/knowledge/page.tsx`

**Steps:**

- [ ] **Step 1: Use `<PageHeader>` and collapse one tab strip to `<select>`**

Convert the **scope** axis (All/Org/Space/Personal) to a `<select>` on mobile (keep tabs on desktop). Keep the **type** axis (All/Concepts/Entities/...) as tabs wrapped in `<TabStrip>`.

```tsx
<PageHeader
  title="Knowledge Wiki"
  primary={
    <>
      <button>+ New</button>
      <button>Pages</button>
      <OverflowMenu items={['Activity', 'Stats']} />
    </>
  }
  secondary={
    <>
      <select className="md:hidden ..." value={scope} onChange={...}>
        <option value="all">All</option><option value="org">Org</option>
        <option value="space">Space</option><option value="personal">Personal</option>
      </select>
      <TabStrip className="hidden md:flex ...">{scopeTabs}</TabStrip>
      <TabStrip>{typeTabs}</TabStrip>
    </>
  }
/>
```

- [ ] **Step 2: Build a minimal `<OverflowMenu>` if not present**

If the codebase doesn't have one, add to `apps/web/src/components/overflow-menu.tsx`:

```tsx
export function OverflowMenu({ items }: { items: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} aria-label="More" className="min-w-[44px] min-h-[44px] flex items-center justify-center">
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 rounded-md border bg-[var(--surface)] py-1">
          {items.map(item => <button key={item} className="block px-3 py-2 w-full text-left">{item}</button>)}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify**

390px: chrome above first card ≤ 130px. Both filter axes still functional.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/(app)/knowledge/page.tsx apps/web/src/components/overflow-menu.tsx
git commit -m "fix(knowledge): collapse scope tabs to select + actions to overflow on <md"
```

## Task 4.3 — `/library` header trim

**Files:**
- Modify: `apps/web/src/app/(app)/library/page.tsx`

**Steps:**

- [ ] **Step 1: Use `<PageHeader>` with `compact`**

```tsx
<PageHeader
  title="Library"
  description="Browse skills to install on agents and task templates to apply to projects."
  secondary={<TabStrip>{tabs}</TabStrip>}
  compact
/>
```

`compact` hides the title on mobile (the AppHeader's pageContext or the bare absence of title is acceptable for a single-purpose page like this). Description is `hidden md:block` inside the component already.

- [ ] **Step 2: Verify**

390px: chrome above first card ≤ 96px.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/(app)/library/page.tsx
git commit -m "fix(library): use PageHeader, hide title+description on <md"
```

## Task 4.4 — `/skills` header trim

**Files:**
- Modify: `apps/web/src/app/(app)/skills/page.tsx`

**Steps:**

- [ ] **Step 1: Same pattern as 4.3**

```tsx
<PageHeader
  title="Skills"
  description="Reusable bundles you can install on agents or attach to projects."
  secondary={<TabStrip>{tabs}</TabStrip>}
  compact
/>
```

- [ ] **Step 2: Verify**

390px: chrome ≤ 96px. "Your org" tab no longer clipped.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/(app)/skills/page.tsx
git commit -m "fix(skills): use PageHeader, drop dup title+description on <md"
```

## Task 4.5 — `/settings` and `/settings/*` header trim

**Files:**
- Modify: `apps/web/src/app/(app)/settings/page.tsx`
- Modify: `apps/web/src/app/(app)/settings/layout.tsx` (if exists; otherwise per-page)

**Steps:**

- [ ] **Step 1: Drop the duplicate `<h1>Settings</h1>` from `/settings/page.tsx`**

The active tab in the strip already announces which sub-section the user is in. The big `<h1>Settings</h1>` is redundant on mobile.

- [ ] **Step 2: Wrap the settings tab strip in `<TabStrip>`**

Find the tabs row (General / Members / Groups / Tags / Integrations / etc.). Replace with `<TabStrip>{tabs}</TabStrip>`.

- [ ] **Step 3: Verify**

390px: chrome above the first profile card ≤ 130px (was ~205px).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/(app)/settings/page.tsx apps/web/src/app/(app)/settings/layout.tsx
git commit -m "fix(settings): drop duplicate H1 + use TabStrip for nav"
```

## Task 4.6 — `/calendar` header trim + week→day on mobile (mobile-spillover C3, mobile-deep P2-3)

**Files:**
- Modify: `apps/web/src/app/(app)/calendar/page.tsx`

**Steps:**

- [ ] **Step 1: Move "Connect Calendar" to settings/integrations**

Remove the inline "Connect Calendar" link from the header. Add a "Calendar" entry to `/settings/integrations` if not already there. If users land on `/calendar` without a connected calendar, show an empty-state with a "Connect a calendar" CTA in the body, not in the header.

- [ ] **Step 2: With "Connect Calendar" gone, the segmented control fits**

Verify Month/Week/Day segmented control no longer clips at 390px.

- [ ] **Step 3: Auto-route Week → Day at `< md`**

```tsx
useEffect(() => {
  if (typeof window !== 'undefined' && window.innerWidth < 768 && view === 'week') {
    router.replace(`/calendar?view=day&date=${date}`);
  }
}, [view, date, router]);
```

- [ ] **Step 4: Verify**

390px on `/calendar?view=week` → auto-redirects to `/calendar?view=day`. No more 660px hidden grid.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/(app)/calendar/page.tsx
git commit -m "fix(calendar): move Connect Calendar to settings, redirect week→day on <md"
```

## Task 4.7 — `/tasks` header trim + view-switcher relabel

**Files:**
- Modify: `apps/web/src/app/(app)/tasks/page.tsx`

**Steps:**

- [ ] **Step 1: Disambiguate the two calendar icons**

Audit found two of the five view-switcher icons look identical (both calendars). Replace one with a distinct icon (`CalendarDays` for calendar-view, `CalendarRange` for timeline). Add `aria-label` to each.

- [ ] **Step 2: Move "Filters" into the same row as project picker**

Currently Filters is its own row beneath the picker+switcher. Combine them.

- [ ] **Step 3: Wrap the status tab strip in `<TabStrip>`**

Replaces the existing `flex gap-1.5 overflow-x-auto px-4 py-2 flex-shrink-0` div from mobile-spillover scrollers list.

- [ ] **Step 4: Verify**

390px: chrome above first task card ≤ 140px (was ~205px). "In Review (2)" pill no longer clipped (now has TabStrip fade affordance).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/(app)/tasks/page.tsx
git commit -m "fix(tasks): disambiguate view icons + use TabStrip for status tabs"
```

## Task 4.8 — `/agent` picker → select on `< md`

**Files:**
- Modify: `apps/web/src/components/agent-chat.tsx` (or wherever the agent picker chips live)

**Steps:**

- [ ] **Step 1: Replace inline chips with `<select>` at mobile**

```tsx
<div className="md:hidden">
  <select value={agentId} onChange={e => setAgentId(e.target.value)} className="w-full bg-transparent text-[1rem] font-semibold">
    {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
  </select>
</div>
<div className="hidden md:flex gap-2">
  {/* existing chips */}
</div>
```

- [ ] **Step 2: Move "History" button to AppHeader pageContext on mobile**

```tsx
useSetPageContext(
  <button onClick={openHistory} className="md:hidden">History</button>,
  [openHistory]
);
```

- [ ] **Step 3: Verify**

390px: agent picker is one row, history button is in app header. Chrome ≤ 110px.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/agent-chat.tsx
git commit -m "fix(agent): collapse picker to select + move History to AppHeader on <md"
```

## Task 4.9 — Lock in chrome budgets via Playwright assertions

**Files:**
- Modify: `docs/superpowers/audits/mobile-headers.audit.ts`

**Steps:**

- [ ] **Step 1: Add per-route assertions**

Extend the audit from Task 2.4 with one assertion per route. Each asserts the y-coordinate of the first content element under `<main>`.

```ts
const ROUTE_BUDGETS = {
  '/dashboard': 96,
  '/chat': 130,
  '/tasks': 140,
  '/agent': 110,
  '/calendar': 130,
  '/notes': 110,
  '/knowledge': 130,
  '/library': 96,
  '/skills': 96,
  '/reminders': 110,
  '/settings': 130,
};
for (const [path, budget] of Object.entries(ROUTE_BUDGETS)) {
  await page.goto(`http://localhost:3000${path}`);
  const y = await page.locator('main > * > *:not(div.hidden)').first().evaluate(el => el.getBoundingClientRect().y);
  assert(y < budget + 8, `${path} chrome=${y}px (budget ${budget}px)`);
}
```

- [ ] **Step 2: Run + verify all green**

```bash
pnpm tsx docs/superpowers/audits/mobile-headers.audit.ts
```

If any route fails, revisit its Phase-4 task.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/audits/mobile-headers.audit.ts
git commit -m "test(mobile): per-route chrome-height budgets enforced"
```

---

# Phase 5 — Layout collisions and view rescues

## Task 5.1 — `/settings/api-access` row stack (mobile-spillover C1)

**Files:**
- Modify: `apps/web/src/app/(app)/settings/api-access/page.tsx`

**Why:** Cards stack 5 atoms (token / "full access" pill / "0 requests" / toggle / delete) in one row; on mobile they overlap visually.

**Steps:**

- [ ] **Step 1: Stack secondary metadata below the title at `< md`**

Restructure each card from one flex-row to two-row layout on mobile:

```tsx
<div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-4">
  <div className="flex-1 min-w-0">
    <div className="font-semibold truncate">{title}</div>
    <div className="text-[0.75rem] opacity-60 truncate">{tokenPrefix}</div>
  </div>
  <div className="flex items-center gap-3">
    <span className="bg-[var(--surface-container)] px-2 py-0.5 text-[0.75rem] rounded">{access}</span>
    <span className="text-[0.75rem] opacity-60">{requests} requests</span>
    <Toggle checked={enabled} />
    <DeleteButton onClick={...} />
  </div>
</div>
```

- [ ] **Step 2: Verify**

390px: each card has a clean two-row layout. No text overlapping.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/(app)/settings/api-access/page.tsx
git commit -m "fix(api-access): stack card metadata below title on <md"
```

## Task 5.2 — `/settings/agent-employees` row stack (mobile-spillover C2)

**Files:**
- Modify: `apps/web/src/app/(app)/settings/agent-employees/page.tsx`

**Steps:**

- [ ] **Step 1: Same pattern as 5.1**

Restructure each agent row to stack name+role above the action atoms (actions/Active/Autonomous/toggle/delete) on mobile.

- [ ] **Step 2: Verify**

390px: "Engineering Lead" pill no longer overlaps "0/50 actions" / "Active" / "Autonomous".

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/(app)/settings/agent-employees/page.tsx
git commit -m "fix(agents-list): stack agent row metadata on <md"
```

## Task 5.3 — `/tasks` Pipeline view collapses to status tabs at `< md`

**Files:**
- Modify: the Pipeline view component (search `apps/web/src/components` and `apps/web/src/app` for `pipeline` or `Kanban`)

**Steps:**

- [ ] **Step 1: Reuse the Board view's status-tab logic**

Board view already collapses 6 columns into a horizontal tab strip on mobile (mobile-deep audit confirmed this works). The pipeline view doesn't. Lift the column→tab logic into a shared hook `useStatusTabs(columns)` in `apps/web/src/lib/use-status-tabs.ts`, then have both views consume it.

- [ ] **Step 2: Verify**

390px on `/tasks?view=pipeline`: shows one column at a time with a tab strip on top. No horizontal page scroll.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/use-status-tabs.ts apps/web/src/components/pipeline-view.tsx
git commit -m "fix(tasks): collapse pipeline columns to status tabs on <md"
```

## Task 5.4 — `/tasks` Calendar view shows event indicators per day at `< md`

**Files:**
- Modify: the tasks calendar-view component

**Why:** mobile-spillover P2-2 — task calendar cells (~55px wide on mobile) can't host any task content. `/calendar` page already uses event-dots; mirror that.

**Steps:**

- [ ] **Step 1: Reuse the `<EventDots>` pattern from `/calendar`**

Find how `/calendar/page.tsx` renders dots (likely a small `<span>` per event color in each day cell). Lift into `apps/web/src/components/event-dots.tsx`. Use it in the tasks calendar cells.

- [ ] **Step 2: At `< md`, also auto-redirect view=calendar → view=list**

For users who'd prefer a flat list of due tasks on mobile (more useful than a sparse grid):

```tsx
useEffect(() => {
  if (window.innerWidth < 768 && view === 'calendar') router.replace('?view=list');
}, [view, router]);
```

(Decide between dots-only OR auto-list-redirect; not both. The auto-list is the easier ship; dots is the better UX.)

- [ ] **Step 3: Verify**

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/event-dots.tsx apps/web/src/app/(app)/tasks/page.tsx
git commit -m "fix(tasks): show event-dots in calendar cells on <md (or redirect to list)"
```

## Task 5.5 — Dashboard body-scroll instead of inner-scroll on `< md` (mobile-deep P2-8)

**Files:**
- Modify: `apps/web/src/app/(app)/dashboard/page.tsx`

**Why:** Dashboard uses an inner-scroll container (3241px tall). Inner-scroll on mobile breaks iOS Safari URL bar auto-hide, pull-to-refresh, two-finger scroll-to-top, and the screenshot tools' fullPage.

**Steps:**

- [ ] **Step 1: Drop `overflow-hidden` on the wrapper at `< md`**

Find the `<div className="overflow-hidden ...">` (or similar) wrapping the bento. Switch to:

```tsx
<div className="md:overflow-hidden md:h-[var(--main-height)]">
```

(Or whatever the existing height-constraining classes are — make them `md:` prefixed.)

- [ ] **Step 2: Verify**

390px on `/dashboard`: scrolling the page now scrolls the body (URL bar collapses on iOS Safari). Desktop: layout unchanged.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/(app)/dashboard/page.tsx
git commit -m "fix(dashboard): use body scroll on <md instead of inner-scroll container"
```

---

# Phase 6 — Auth & polish

Smaller fixes that close the long tail of the audit.

## Task 6.1 — Login form: autocomplete + autofocus + password toggle (audit P1-4, P1-5)

**Files:**
- Modify: `apps/web/src/app/login/page.tsx`
- Modify: `apps/web/src/app/signup/page.tsx` (mirror)

**Steps:**

- [ ] **Step 1: Add the missing attributes**

In login email input (line 118-129):

```tsx
<input type="email"
  autoComplete="email"
  inputMode="email"
  autoFocus
  ... />
```

In login password input (line 140-149):

```tsx
<input type={showPw ? 'text' : 'password'}
  autoComplete="current-password"
  ... />
```

Signup gets `autoComplete="email"` on email and `autoComplete="new-password"` on password.

- [ ] **Step 2: Add a show/hide password toggle**

```tsx
const [showPw, setShowPw] = useState(false);
// inside the password field:
<div className="relative">
  <input type={showPw ? 'text' : 'password'} ... className="... pr-10" />
  <button type="button" onClick={() => setShowPw(s => !s)}
    className="absolute right-2 top-1/2 -translate-y-1/2 min-w-[36px] min-h-[36px] flex items-center justify-center"
    aria-label={showPw ? 'Hide password' : 'Show password'}>
    {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
  </button>
</div>
```

- [ ] **Step 3: Bump tap targets on "Forgot?" and "Sign up" links**

Wrap each in a span/anchor with `min-h-[44px] flex items-center px-2 -mx-2` so the touch target hits 44 even though the visible text is small.

- [ ] **Step 4: Verify**

iOS Safari: tap email → keyboard shows email layout (`@` key visible). Tap password → suggested keychain credential appears. Eye-icon toggles visibility.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/login/page.tsx apps/web/src/app/signup/page.tsx
git commit -m "fix(auth): add autocomplete, autofocus, password toggle, larger tap targets"
```

## Task 6.2 — Notes: 2-line title clamp + mobile tap-to-open (audit P3 + mobile-spillover H4)

**Files:**
- Modify: `apps/web/src/app/(app)/notes/page.tsx` (and any note-card sub-component)

**Steps:**

- [ ] **Step 1: Switch title from ellipsis to 2-line clamp at `< md`**

Find the `<h3>` for note titles. Change to:

```tsx
<h3 className="font-semibold line-clamp-2 md:truncate">{title}</h3>
```

- [ ] **Step 2: Wire mobile tap to push `?note=<id>` and render the editor full-screen**

Currently note-card click doesn't do anything on mobile (audit observed). Add an `onClick` to the card that on mobile navigates to `?note=<id>` and renders the note editor in a full-screen drawer (mirror the `/chat` thread panel pattern).

- [ ] **Step 3: Verify**

390px: tap a note → full-screen editor opens. Back arrow returns to list.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/(app)/notes/page.tsx
git commit -m "fix(notes): 2-line title clamp + mobile tap opens full-screen editor"
```

## Task 6.3 — Investigate and fix the literal `??` prefix on note titles (mobile-spillover P2-4)

**Files:**
- Inspect: `apps/web/src/app/(app)/notes/page.tsx` and any API route serving notes

**Steps:**

- [ ] **Step 1: Reproduce + inspect data**

Open `/notes` at 390px, open DevTools Network tab, find the API call returning the notes list. Inspect the `icon` / `emoji` field value for one of the affected notes. It will likely be a Unicode codepoint stored as `?` or empty.

- [ ] **Step 2: Fix at the cause**

If the API returns an actual `??` string, the seed data is wrong — fix the seed. If the API returns a valid emoji and it's failing to render, ensure the note card doesn't have a stray `?? ` prefix in the JSX.

- [ ] **Step 3: Null-check before rendering**

```tsx
{note.icon ? <span>{note.icon}</span> : null}{note.title}
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/(app)/notes/page.tsx
git commit -m "fix(notes): drop literal ?? prefix when icon is missing/invalid"
```

## Task 6.4 — Pinned message bar: full-row tap to expand (audit P2-9)

**Files:**
- Modify: `apps/web/src/components/space-chat.tsx`

**Steps:**

- [ ] **Step 1: Wrap the entire pinned-bar in a button**

Today the chevron is the only tappable element. Make the whole 390-px-wide bar an interactive button that toggles expanded state.

- [ ] **Step 2: Replace the literal `>` character in "1 thread reply>" with a chevron icon**

Search for `thread reply>` and swap the `>` for `<ChevronRight size={12} />`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/space-chat.tsx
git commit -m "fix(chat): make pinned bar fully tappable + replace > with chevron icon"
```

## Task 6.5 — Tasks floating action button safe-area (audit P3)

**Files:**
- Modify: `apps/web/src/app/(app)/tasks/page.tsx` (the FAB)

**Steps:**

- [ ] **Step 1: Add safe-area to FAB position**

```tsx
className="... bottom-[calc(max(env(safe-area-inset-bottom),16px)+56px)]"
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/app/(app)/tasks/page.tsx
git commit -m "fix(tasks): raise FAB above iOS Safari URL bar / home indicator"
```

## Task 6.6 — Command palette: hide desktop hints on mobile (audit P2-6)

**Files:**
- Modify: `apps/web/src/components/command-palette.tsx`

**Steps:**

- [ ] **Step 1: Hide the keyboard-hint footer at `< md`**

Find the footer containing `↑↓ to navigate ← to select ESC v1.0.0-beta`. Wrap in `hidden md:flex`.

- [ ] **Step 2: Replace the wrong `←` arrow with `↵` (Enter symbol)**

Even on desktop, `←` is wrong for "select".

- [ ] **Step 3: Remove the version string from the footer**

`v1.0.0-beta` belongs on a settings/about page, not on every cmd-K open.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/command-palette.tsx
git commit -m "fix(cmdk): hide keyboard hints on <md, fix arrow, remove version string"
```

## Task 6.7 — Production-disable Next.js dev-tools indicator

**Files:**
- Modify: `apps/web/next.config.js` (or `next.config.ts`)

**Why:** The "N" badge overlapped composer / FAB / sidebar user row in audit screenshots. Dev-only, but worth confirming it's gone in production.

**Steps:**

- [ ] **Step 1: Audit current Next.js config**

Open the Next config file. Confirm `devIndicators` is either default (`{ buildActivity: true }`) or explicitly disabled.

- [ ] **Step 2: Disable in production-like preview builds**

```js
// next.config.js
module.exports = {
  devIndicators: { appIsrStatus: false, buildActivity: false },
};
```

- [ ] **Step 3: Verify with a `pnpm build && pnpm start`**

Open `http://localhost:3000` after a production build — confirm no "N" indicator anywhere.

- [ ] **Step 4: Commit**

```bash
git add apps/web/next.config.js
git commit -m "chore(web): disable Next.js dev indicators that overlap mobile UI"
```

## Task 6.8 — Final regression sweep

**Steps:**

- [ ] **Step 1: Run the full audit harness**

```bash
pnpm audit:setup    # if token expired
pnpm audit:session3 # cumulative regression
pnpm tsx docs/superpowers/audits/mobile-headers.audit.ts
```

- [ ] **Step 2: Re-screenshot every audited route at 390×844**

Compare visually against the original audit screenshots in `docs/superpowers/audits/mobile-deep/screenshots/`. Document the before/after deltas in a `docs/superpowers/audits/mobile-fixes-2026-04-24-results.md` summary.

- [ ] **Step 3: Update memory with the new state**

Touch the audit-infrastructure memory at `~/.claude/.../memory/reference_audit_infrastructure.md` with the new harness path and pass count.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/audits/mobile-fixes-2026-04-24-results.md
git commit -m "docs(audits): record mobile UX fixes regression baseline"
```

---

## Self-review notes

- **Spec coverage:** Every P0/P1/P2 from mobile-deep, every C/H/repeat-offender from mobile-spillover, and every per-page recommendation from mobile-headers maps to a numbered task. P3 polish items not explicitly tasked are absorbed into adjacent tasks (e.g. notes search 13px → caught by Phase 1.1's global rule).
- **Type/method consistency:** `useSetPageContext`, `<PageHeader>`, `<TabStrip>`, `<MobileActionSheet>`, `useAppHeaderContext` are referenced consistently across phases.
- **Placeholder scan:** No "TBD" / "implement appropriate" / "similar to" — every task references concrete files, lines (where stable), and code blocks.
- **Open question:** Task 5.4 leaves a binary choice (dots-only vs auto-list redirect for tasks calendar mobile). The implementer can decide based on what's faster to ship; both are mentioned in the audit as acceptable.

## Risk / open items

1. **TipTap toolbar refactor (Phase 3.3)** is the highest-risk change — TipTap's toggle handlers are typically inlined as JSX. Extracting them into named functions is cheap but easy to miss. Manual desktop verification required.
2. **`pageContext` slot semantics (Phase 2.2)** — the React Context approach causes a re-render of the AppHeader on each page-context change. For most pages this is once-per-mount; for `/agent` it could fire on agent-switch. Acceptable but worth watching.
3. **Calendar week→day auto-redirect (Phase 4.6)** loses the Week URL state on mobile. If a user opens a desktop-shared link `/calendar?view=week&date=…` on their phone, they land on Day view. Document this in the calendar page README.
4. **Audit harness coverage** does not currently authenticate Playwright sessions on `localhost:3001` (the API). The auth setup at `pnpm audit:setup` handles this. Phase 4.9's chrome-budget assertions assume the existing auth wrapper.

---

## Shipping advice

- **Each phase is one PR.** Phase 0 ships first (low risk, cleans up two embarrassing bugs). Phase 1 + 2 should ship together (foundation primitives + AppHeader rearchitecture; otherwise Phase 4 has nothing to migrate to).
- Phase 3 (composer) is the user-visible P0; ship it as soon as Phase 1 lands (independent of Phase 2).
- Phase 4 (per-page) can be split further into smaller PRs (one per page) if reviewers want tighter diffs.
- Phase 5 + 6 are the long tail — ship as bandwidth allows.

End of plan.
