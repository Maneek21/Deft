# Notes — Competitive Analysis & Improvement Plan

## Current State

Deft's Notes is a minimalist personal note-taker: TipTap editor with emoji icons, pinning, search, auto-save. 6 formatting options (bold, italic, strike, code, lists, quotes). No folders, no sharing, no media, no templates, no AI.

---

## Competitive Landscape

### What Each Competitor Does Best

| App | Strength | What Deft Can Learn |
|-----|----------|-------------------|
| **Notion** | Block-based everything, databases, templates, sharing | Block variety matters, but Notion's complexity is a weakness |
| **Obsidian** | Backlinks, graph view, local-first, plugins | Backlinks + graph = knowledge discovery. Deft already has a wiki graph |
| **Apple Notes** | Zero friction, instant capture, scan documents | Speed and simplicity win for daily use |
| **Craft** | Beautiful typography, nested blocks, sharing | Visual polish creates perception of quality |
| **Reflect** | AI-native, backlinks, daily notes, networked thought | AI integration with notes is the future — Deft has the agent for this |
| **Mem** | AI organization, auto-tagging, smart search | Let AI handle organization, not the user |
| **Linear** | Docs inside project management, cross-linking | Notes integrated with tasks/projects — Deft already has both |

### Key Insight

Every competitor is either:
1. **A note-taker trying to add AI** (Notion AI, Obsidian Copilot) — bolted on
2. **An AI tool trying to add notes** (Mem, Reflect) — limited workspace features
3. **A standalone note app** (Apple Notes, Bear) — no team/project context

**Deft is neither.** Deft has chat, tasks, an AI agent, a wiki knowledge graph, and team context — all in one workspace. Notes that understand your team's conversations, tasks, and decisions is something no competitor has.

---

## Deft's Unique Advantage

**The agent already knows everything.** It reads chat, manages tasks, maintains the wiki. Notes should be the personal thinking layer that feeds into — and draws from — this organizational brain.

Concrete advantages no competitor can match:

1. **Agent-assisted notes** — "Summarize today's #engineering discussion as a note." No other tool can do this because no other tool has the chat + agent + notes in one app.

2. **Note-to-wiki pipeline** — Write messy thoughts in notes, then promote refined content to the wiki with one click. Personal drafts become organizational knowledge.

3. **Task-linked notes** — Meeting notes that automatically reference the tasks discussed. Sprint retrospective notes that link to completed tasks.

4. **Context injection** — When you create a note, the agent can pre-fill relevant context: "You have 3 tasks due today, the team discussed auth in #engineering, and the sprint ends Friday."

5. **Cross-reference everything** — A note can reference a chat message, a task, a wiki page, and a calendar event. No other tool connects all these.

---

## What to Build (Priority Order)

### Tier 1: Table Stakes (Must Have)

These are features users expect from any modern note-taker. Without them, Notes feels like a prototype.

| Feature | What | Why | Effort |
|---------|------|-----|--------|
| **Folders/Notebooks** | Hierarchical organization with nested folders | Apple Notes, Notion, Bear all have this. Without it, 50+ notes becomes unusable | Medium |
| **Image support** | Paste/upload images inline | Every note-taker supports this. Upload infra already exists (R2/local) | Medium |
| **Tables** | TipTap table extension | Meeting notes, comparisons, data — tables are essential | Small (TipTap has a table extension) |
| **Markdown export** | Download as .md | Users need to get their data out | Small |
| **Word count** | Character/word count in editor footer | Writers expect this | Tiny |
| **Templates** | Pre-built note structures (meeting notes, standup, retro, 1:1) | Reduces friction for common use cases | Small |

### Tier 2: Differentiators (Deft's Edge)

These leverage Deft's unique position as an AI-native workspace.

| Feature | What | Why | Effort |
|---------|------|-----|--------|
| **Agent in notes** | Inline `/ask` command or sidebar agent that can read/write the current note | "Summarize this", "Fix grammar", "Expand this bullet point". Uses existing agent infra | Medium |
| **Note-to-wiki promotion** | "Promote to Wiki" button that creates a wiki page from a note | Personal draft → organizational knowledge. No other tool has this pipeline | Small |
| **@mentions** | Reference @people, #tasks, [[wiki pages]] inline | TipTap mention extension exists. Creates cross-references. Obsidian's killer feature, but connected to real workspace data | Medium |
| **Backlinks** | "X notes reference this note" section | Obsidian's core innovation, but with team context | Medium |
| **Meeting notes mode** | Template that auto-fills attendees from calendar, links tasks discussed, records action items | Leverages calendar + tasks integration. No competitor connects all three | Medium |

### Tier 3: Polish (Nice to Have)

| Feature | What | Effort |
|---------|------|--------|
| **Version history** | See previous versions of a note | Small (same pattern as wiki version history) |
| **Tags** | Tag notes with colored labels | Small (tags system already exists in DB) |
| **Focus mode** | Distraction-free writing with hidden sidebar | Tiny |
| **Sharing** | Share a note with a teammate (read-only or edit) | Medium |
| **Slash commands** | `/heading`, `/bullet`, `/table`, `/task`, `/divider` | Medium (TipTap supports this) |
| **Code blocks with syntax highlighting** | Language-specific highlighting | Small (TipTap extension exists) |

---

## What NOT to Build

- **Full Notion clone** — block databases, kanban in notes, etc. Tasks and wiki already handle this.
- **Real-time collaboration** — Not needed for personal notes. Chat handles real-time team communication.
- **Plugin system** — Adds complexity. Deft's value is integration, not extensibility.
- **Offline support** — Nice but not critical for v1. Server-based auto-save works.
- **Graph view for notes** — Wiki already has this. Notes are personal, wiki is organizational.

---

## The Pitch

> "Notes in Deft aren't just notes. They're the personal thinking layer of your workspace — connected to your team's chat, tasks, wiki, and AI agent. Write messy thoughts, then promote them to organizational knowledge. Reference a task with @DEFT-7, link to a wiki page with [[Architecture]], or ask the agent to summarize today's discussion. No other tool connects your personal notes to your team's brain."

---

## Implementation Recommendation

**Phase 1 (immediate):** Tables, images, word count, markdown export. These remove the "prototype" feeling.

**Phase 2 (next sprint):** Agent integration, note-to-wiki promotion, @mentions. These create the differentiator.

**Phase 3 (later):** Templates, folders, meeting notes mode, backlinks, tags, version history.
