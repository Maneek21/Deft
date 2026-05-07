# Sidebar UI Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 5 concrete sidebar deficiencies — missing nav items, misleading presence display, empty sidebar states, silent conversation truncation, and no keyboard shortcut for collapse — making the sidebar complete and honest.

**Architecture:** All changes are confined to `apps/web/src/components/sidebar.tsx` (1115 lines). No new files needed. Each task is an independent, self-contained edit to that file.

**Tech Stack:** React, Next.js App Router, Tailwind CSS, Lucide React icons, existing CSS variables from globals.css.

---

## File Map

| File | What changes |
|---|---|
| `apps/web/src/components/sidebar.tsx` | All 5 tasks — nav items, presence, notes content, conversations pagination, keyboard shortcut |

No other files need touching. The sidebar is self-contained.

---

## Context for every task

`apps/web/src/components/sidebar.tsx` is 1115 lines. Key sections:

- **Lines 12–37** — lucide-react icon imports
- **Lines 71–80** — `navItems` array (8 items: Dashboard, Notes, Calendar, Chat, Tasks, Knowledge, Agent, Settings)
- **Lines 538** — `conversations.slice(0, 10)` in `AgentSidebarContent`
- **Lines 623–671** — `SettingsSidebarContent` with a `sections` array of 8 links
- **Lines 718–729** — `toggleCollapsed` + localStorage persistence
- **Lines 744–766** — `renderContent()` switch on `pathname`
- **Lines 860–896** — Bottom user bar with hardcoded `"Online"` at line 894
- **Lines 868–878** — Presence dot, always green, hardcoded

The file already imports `usePathname`, `useRouter`, `useAuth`, `useChatContext`, `useEffect`, `useState`, `useRef`, `useCallback`, and all Lucide icons listed above.

The `presence` prop is typed as `Map<string, 'online' | 'idle' | 'offline'>` and is passed into the `Sidebar` component at line 685.

---

## Task 1: Add Skills to nav + Workflows to Settings sidebar

**Why:** The `/skills` page exists and has a breadcrumb, but there's no nav item — users can't find it from the sidebar. `/settings/workflows` exists as a page but is absent from `SettingsSidebarContent`. Both are invisible features.

**Files:**
- Modify: `apps/web/src/components/sidebar.tsx:12-37` (add Puzzle import)
- Modify: `apps/web/src/components/sidebar.tsx:71-80` (add Skills to navItems)
- Modify: `apps/web/src/components/sidebar.tsx:627-636` (add Workflows to settings sections)

- [ ] **Step 1: Add Puzzle icon to imports**

At line 12, the import from `lucide-react` currently ends with `Smile`. Add `Puzzle` to the list:

```typescript
import {
  LayoutDashboard,
  MessageSquare,
  CheckSquare,
  Bot,
  Settings,
  Sun,
  Moon,
  X,
  LogOut,
  Plus,
  Hash,
  User,
  Clock,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  BellOff,
  Bell,
  Bookmark,
  FileText,
  CalendarDays,
  Headphones,
  BookOpen,
  Smile,
  Puzzle,
} from 'lucide-react';
```

- [ ] **Step 2: Add Skills to navItems**

At line 71, `navItems` is:
```typescript
const navItems = [
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { name: 'Notes', href: '/notes', icon: FileText },
  { name: 'Calendar', href: '/calendar', icon: CalendarDays },
  { name: 'Chat', href: '/chat', icon: MessageSquare },
  { name: 'Tasks', href: '/tasks', icon: CheckSquare },
  { name: 'Knowledge', href: '/knowledge', icon: BookOpen },
  { name: 'Agent', href: '/agent', icon: Bot },
  { name: 'Settings', href: '/settings', icon: Settings },
];
```

Add Skills before Settings:
```typescript
const navItems = [
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { name: 'Notes', href: '/notes', icon: FileText },
  { name: 'Calendar', href: '/calendar', icon: CalendarDays },
  { name: 'Chat', href: '/chat', icon: MessageSquare },
  { name: 'Tasks', href: '/tasks', icon: CheckSquare },
  { name: 'Knowledge', href: '/knowledge', icon: BookOpen },
  { name: 'Agent', href: '/agent', icon: Bot },
  { name: 'Skills', href: '/skills', icon: Puzzle },
  { name: 'Settings', href: '/settings', icon: Settings },
];
```

- [ ] **Step 3: Add Workflows to Settings sidebar sections**

At line 627, `sections` inside `SettingsSidebarContent` is:
```typescript
const sections = [
  { name: 'General', href: '/settings' },
  { name: 'Members', href: '/settings/members' },
  { name: 'Groups', href: '/settings/groups' },
  { name: 'Tags', href: '/settings/tags' },
  { name: 'Integrations', href: '/settings/integrations' },
  { name: 'Agent', href: '/settings/agent' },
  { name: 'Agent Employees', href: '/settings/agent-employees' },
  { name: 'API Access', href: '/settings/api-access' },
];
```

Add Workflows after Tags:
```typescript
const sections = [
  { name: 'General', href: '/settings' },
  { name: 'Members', href: '/settings/members' },
  { name: 'Groups', href: '/settings/groups' },
  { name: 'Tags', href: '/settings/tags' },
  { name: 'Workflows', href: '/settings/workflows' },
  { name: 'Integrations', href: '/settings/integrations' },
  { name: 'Agent', href: '/settings/agent' },
  { name: 'Agent Employees', href: '/settings/agent-employees' },
  { name: 'API Access', href: '/settings/api-access' },
];
```

- [ ] **Step 4: Verify active state for /skills**

The nav active check at line 824 is `pathname.startsWith(item.href)`. Since Skills href is `/skills` and the app-header already handles the `/skills` breadcrumb, this will work automatically. No additional change needed.

However, `renderContent()` at line 744 has no branch for `/skills` — it falls through to `ChatSidebarContent`. That's fine for now (Chat sidebar as default is better than empty). No change needed here.

- [ ] **Step 5: Commit**

```bash
cd /c/Users/Osheen\ Pradhan/cairn && git add apps/web/src/components/sidebar.tsx && git commit -m "feat(sidebar): add Skills nav item and Workflows to settings sidebar

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Wire real presence into user profile bottom bar

**Why:** The bottom user bar at lines 875–895 always shows a green dot and hardcoded "Online" text regardless of actual presence. When a user is idle or offline in another tab, this is misleading.

**Files:**
- Modify: `apps/web/src/components/sidebar.tsx:860-896`

The `presence` prop is already available — it's passed into `Sidebar` at line 685 as `Map<string, 'online' | 'idle' | 'offline'>`. The user ID comes from `user?.id` (already available via `useAuth()` at line 689).

- [ ] **Step 1: Derive presence values for current user**

At line 718 (just after the `toggleCollapsed` function), add these two derived values:

```typescript
const myPresence = user?.id ? (presence.get(user.id) ?? 'online') : 'online';
const presenceDotColor = myPresence === 'online'
  ? 'var(--status-green)'
  : myPresence === 'idle'
    ? 'var(--status-amber)'
    : 'var(--outline)';
const presenceLabel = myPresence === 'online' ? 'Online' : myPresence === 'idle' ? 'Idle' : 'Away';
const presenceLabelColor = myPresence === 'online'
  ? 'var(--status-green)'
  : myPresence === 'idle'
    ? 'var(--status-amber)'
    : 'var(--outline)';
```

- [ ] **Step 2: Replace hardcoded dot color (line 877)**

Find this block (lines 875–878):
```typescript
          <div
            className="absolute -bottom-0.5 -right-0.5 w-[10px] h-[10px] rounded-full"
            style={{ background: 'var(--status-green)', border: '2px solid var(--surface-container-low)' }}
          />
```

Replace with:
```typescript
          <div
            className="absolute -bottom-0.5 -right-0.5 w-[10px] h-[10px] rounded-full"
            style={{ background: presenceDotColor, border: '2px solid var(--surface-container-low)' }}
          />
```

- [ ] **Step 3: Replace hardcoded "Online" text (lines 891–895)**

Find:
```typescript
          <span
            className="text-[0.6875rem] block"
            style={{ color: 'var(--status-green)' }}
          >
            Online
          </span>
```

Replace with:
```typescript
          <span
            className="text-[0.6875rem] block"
            style={{ color: presenceLabelColor }}
          >
            {presenceLabel}
          </span>
```

- [ ] **Step 4: Commit**

```bash
cd /c/Users/Osheen\ Pradhan/cairn && git add apps/web/src/components/sidebar.tsx && git commit -m "fix(sidebar): wire real presence state into user profile bottom bar

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Notes + Dashboard sidebar content (replace empty state)

**Why:** When on `/notes` or `/dashboard`, `renderContent()` returns `null` — the sidebar content area is completely blank. This looks broken and wastes the space. Replace with a simple contextual panel: a "New note" button + recent daily notes for `/notes`, and a minimal "Quick links" panel for `/dashboard`.

**Files:**
- Modify: `apps/web/src/components/sidebar.tsx` — add `NotesSidebarContent` component before the `SettingsSidebarContent` function, and wire it in `renderContent()`

The notes API endpoint is `/api/daily-notes` which returns an array sorted by date descending. Each item has `{ id, date, title, content, updated_at }`.

- [ ] **Step 1: Add NotesSidebarContent component**

Add this new component just before `SettingsSidebarContent` (line 623):

```typescript
// ── Notes sidebar content ─────────────────────────────────────────
function NotesSidebarContent({ onNav }: { onNav?: () => void }) {
  const [notes, setNotes] = useState<{ id: string; date: string; title: string | null; updated_at: string }[]>([]);
  const pathname = usePathname();

  useEffect(() => {
    api.get('/api/daily-notes?limit=8').then(async (res) => {
      if (res.ok) {
        const data = await res.json();
        setNotes(Array.isArray(data) ? data.slice(0, 8) : (data.notes ?? []).slice(0, 8));
      }
    });
  }, []);

  function fmtNoteDate(dateStr: string): string {
    const d = new Date(dateStr);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  return (
    <div className="px-3 pt-3 pb-1">
      <Link
        href="/notes"
        onClick={onNav}
        className="w-full flex items-center gap-2 px-2 font-medium mb-3"
        style={{
          height: '36px',
          background: 'var(--primary-container)',
          color: 'white',
          borderRadius: 'var(--radius-lg)',
          fontSize: '0.8125rem',
        }}
      >
        <Plus size={14} /> New note
      </Link>
      <div className="flex items-center px-2 mb-2">
        <span
          className="text-[0.6875rem] font-semibold uppercase tracking-[0.05em]"
          style={{ color: 'var(--outline)' }}
        >
          Recent
        </span>
      </div>
      {notes.map((note) => {
        const active = pathname === `/notes/${note.id}` || (pathname === '/notes' && notes[0]?.id === note.id);
        return (
          <Link
            key={note.id}
            href={`/notes?date=${note.date}`}
            onClick={onNav}
            className="w-full text-left px-2 flex items-center gap-2"
            style={{
              height: '32px',
              background: active ? 'var(--bg-active)' : 'transparent',
              color: active ? 'var(--on-surface)' : 'var(--on-surface-variant)',
              fontWeight: 500,
              fontSize: '0.8125rem',
              borderRadius: 'var(--radius-lg)',
            }}
          >
            <FileText size={13} strokeWidth={1.5} className="flex-shrink-0" style={{ color: 'var(--outline)' }} />
            <span className="truncate flex-1">{note.title || fmtNoteDate(note.date)}</span>
            <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--outline)' }}>
              {fmtNoteDate(note.date)}
            </span>
          </Link>
        );
      })}
      {notes.length === 0 && (
        <p className="text-[12px] text-center py-6 px-2" style={{ color: 'var(--outline)' }}>
          No notes yet
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire NotesSidebarContent into renderContent()**

At line 749, the current code is:
```typescript
    if (pathname.startsWith('/notes') || pathname.startsWith('/dashboard')) {
      return null;
    }
```

Change to:
```typescript
    if (pathname.startsWith('/notes')) {
      return <NotesSidebarContent onNav={handleNav} />;
    }
    if (pathname.startsWith('/dashboard')) {
      return null;
    }
```

Dashboard stays `null` — no data to show there that isn't already on the page itself.

- [ ] **Step 3: Commit**

```bash
cd /c/Users/Osheen\ Pradhan/cairn && git add apps/web/src/components/sidebar.tsx && git commit -m "feat(sidebar): add recent notes list to Notes sidebar content area

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Agent conversations — show more / less (remove silent truncation)

**Why:** At line 538, `conversations.slice(0, 10)` silently hides all conversations after the 10th. A user with 15 conversations sees 10 with no indication that more exist.

**Files:**
- Modify: `apps/web/src/components/sidebar.tsx` — in `AgentSidebarContent`

The `AgentSidebarContent` function has these state variables already: `conversations`, `agentEmployees`, `editingConvo`, `editTitle`. Add one more: `showAllConvos`.

- [ ] **Step 1: Add showAllConvos state to AgentSidebarContent**

Find the state declarations inside `AgentSidebarContent` (they start around line 460). After the last `useState`, add:

```typescript
const [showAllConvos, setShowAllConvos] = useState(false);
```

- [ ] **Step 2: Replace slice(0, 10) with conditional slice**

At line 538, find:
```typescript
        {conversations.slice(0, 10).map(conv => {
```

Change to:
```typescript
        {(showAllConvos ? conversations : conversations.slice(0, 10)).map(conv => {
```

- [ ] **Step 3: Add show more / show less button after conversation list**

Find the closing `</div>` after the `conversations.length === 0` empty state (around line 618, just before `</>` at line 620). Insert the show-more button before that closing `</div>`:

```typescript
        {conversations.length > 10 && (
          <button
            onClick={() => setShowAllConvos(prev => !prev)}
            className="w-full text-left px-4 py-1.5 text-[11px] font-medium"
            style={{ color: 'var(--outline)' }}
          >
            {showAllConvos
              ? `Show less`
              : `Show ${conversations.length - 10} more`}
          </button>
        )}
```

- [ ] **Step 4: Commit**

```bash
cd /c/Users/Osheen\ Pradhan/cairn && git add apps/web/src/components/sidebar.tsx && git commit -m "feat(sidebar): show more/less for agent conversations beyond first 10

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Keyboard shortcut for sidebar collapse (Ctrl+B / Cmd+B)

**Why:** Collapsing the sidebar requires a mouse click on a small icon. Industry standard (Slack, Linear, Notion) is `Ctrl+B` / `Cmd+B`. Takes 10 lines.

**Files:**
- Modify: `apps/web/src/components/sidebar.tsx:718-729`

The `toggleCollapsed` function already exists at line 723. Just add a `useEffect` listener.

- [ ] **Step 1: Add keyboard listener useEffect**

After the `toggleCollapsed` function definition (line 729), add:

```typescript
  // Keyboard shortcut: Ctrl+B / Cmd+B toggles sidebar collapse
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        e.preventDefault();
        toggleCollapsed();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [toggleCollapsed]);
```

Note: `toggleCollapsed` is defined with a plain function (not `useCallback`), so it needs to be wrapped in `useCallback` to avoid the effect re-running on every render. Wrap the existing `toggleCollapsed`:

Replace the current `toggleCollapsed` definition (lines 723–729):
```typescript
  const toggleCollapsed = () => {
    setCollapsed(prev => {
      const next = !prev;
      localStorage.setItem('deft-sidebar-collapsed', String(next));
      return next;
    });
  };
```

With:
```typescript
  const toggleCollapsed = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      localStorage.setItem('deft-sidebar-collapsed', String(next));
      return next;
    });
  }, []);
```

(`useCallback` is already imported at line 3.)

- [ ] **Step 2: Update collapse button title to show shortcut**

Find the collapse button title at line 807:
```typescript
            title="Collapse sidebar"
```

Change to:
```typescript
            title="Collapse sidebar (Ctrl+B)"
```

- [ ] **Step 3: Commit**

```bash
cd /c/Users/Osheen\ Pradhan/cairn && git add apps/web/src/components/sidebar.tsx && git commit -m "feat(sidebar): add Ctrl+B/Cmd+B keyboard shortcut to toggle collapse

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Parallelization

All 5 tasks modify only `apps/web/src/components/sidebar.tsx`. They must be executed **serially** — each task edits the same file and the line numbers shift after each change.

Execute in order: Task 1 → Task 2 → Task 3 → Task 4 → Task 5.

---

## Self-Review

**Spec coverage check:**
- ✅ Skills nav item missing → Task 1
- ✅ Workflows missing from Settings sidebar → Task 1  
- ✅ Hardcoded "Online" presence → Task 2
- ✅ Empty Notes sidebar → Task 3
- ✅ Dashboard sidebar still null → intentional, nothing meaningful to show
- ✅ Conversations silently truncated at 10 → Task 4
- ✅ No keyboard shortcut for collapse → Task 5

**Placeholder scan:** No TBDs, no "handle edge cases", all code blocks are complete and compilable.

**Type consistency:** `notes` state in `NotesSidebarContent` typed as `{ id: string; date: string; title: string | null; updated_at: string }[]` — matches the `/api/daily-notes` response shape. `showAllConvos` is `boolean` — used only as a boolean. `myPresence` typed as `'online' | 'idle' | 'offline'` via the `presence` prop type already declared at line 685.

**One gap found and fixed:** The `/api/daily-notes?limit=8` response shape may vary — `data` might be an array directly or `data.notes`. The `NotesSidebarContent` handler covers both: `Array.isArray(data) ? data.slice(0, 8) : (data.notes ?? []).slice(0, 8)`.
