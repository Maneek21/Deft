# Knowledge Deep Audit

**Date**: 2026-04-20
**Branch**: feat/phase2-4-mcp-agents-plans
**Duration**: 49s
**Findings**: P0=0 P1=1 P2=2 Nit=3
**Screenshots**: 19
**Console errors**: 0
**Page errors**: 0
**Network errors (4xx/5xx)**: 0

---

## Surfaces Observed

- `/knowledge` — wiki hub (list, type filter, scope filter, search, create, edit, delete)
- `/knowledge?slug=<slug>` — wiki page detail (content, confidence bar, linked pages, backlinks, citations, version history, edit/save, delete confirm)
- Graph view — inline D3 force-directed SVG toggle on /knowledge
- Activity view — wiki_ops_log entries feed
- Stats view — by-type bar chart, confidence distribution, needs-review section
- API: `/api/wiki`, `/api/wiki/:slug`, `/api/wiki/graph`, `/api/wiki/stats`, `/api/wiki/log`

---

## Surfaces Confirmed Working

| Feature | Status | Notes |
|---|---|---|
| Page list (41 pages) | PASS | Seed re-run confirmed — 41 pages present |
| Type filter (7 types) | PASS | Concepts, Entities, Decisions, Resources, Procedures, Preferences, Facts all functional |
| Scope filter | PASS | Org/Space/Personal buttons visible and clickable |
| View mode toggles | PASS | Pages / Activity / Stats / Graph all visible in header bar |
| Full-text search | PASS | PostgreSQL, deployment, Docker all return relevant results |
| Page detail view | PASS | Type badge, scope, version, confidence bar, summary, updated-at all present |
| Linked pages + backlinks | PASS | Screenshot 09 shows "Linked Pages (2)" + "Referenced By (1)" sections populated |
| Create page modal | PASS | Opens on "+ New", all fields present, saves successfully, DB row confirmed via API |
| Edit page | PASS | Textarea editor loads, saves, API confirms updated content |
| Decision reverse/re-activate | PASS | "Reverse" buttons visible on 9 decision cards |
| D3 graph rendering | PASS | 42 nodes, 33 edges, type legend, "42 pages · 33 connections" overlay visible |
| Activity log endpoint | PASS | `/api/wiki/log` returns entries |
| Stats endpoint | PASS | `/api/wiki/stats` returns total, by_type, by_confidence, needs_review |
| Zero console/page/network errors | PASS | Clean run throughout |

---

## P0 — Blocks Release

_None found._

---

## P1 — Must Fix

- **[Knowledge/Search]** Active type-filter is not cleared when the search input is used. During the audit, "Decisions" was left selected from a previous type-filter interaction, then the search for "PostgreSQL" returned only 2 Decision-type pages rather than the full result set (which includes the "PostgreSQL Database" entity node). Screenshot `06-search-postgresql.png` shows the `Decisions` tab highlighted while search is active — this is a confusing combined state with no indicator that both constraints are simultaneously active.
  > Fix: reset type filter when a search query is entered, or show a combined "Filtering: Decisions + PostgreSQL" indicator.

---

## P2 — Should Fix

- **[Knowledge/View]** Content body renders as `whitespace-pre-wrap` plain text — markdown syntax (`#` headings, `- ` bullets, `**bold**`, code blocks) displays raw rather than parsed into HTML. Screenshot `09-detail-view-initial.png` shows `- Haiku is 10x cheaper` rendered as a raw dash, not a list item. The create/edit forms accept freeform markdown but the detail view has no markdown renderer.
  > Fix: pass `detail.content` through `react-markdown` or `remark` in the detail view content block (`apps/web/src/app/(app)/knowledge/page.tsx` line ~620, the `whitespace-pre-wrap` div).

- **[Knowledge/Create]** Tags field is stored in `wiki_pages.tags` (string array in DB) but absent from the Create Wiki Page modal and Edit form. Users cannot assign tags to new pages; tags can only be set programmatically. Screenshot `11-create-modal-open.png` confirms: Title, Type, Scope, Summary, Content, Confidence — no Tags input.
  > Fix: add optional multi-tag input (comma-separated or chip-style) to the create and edit forms.

---

## Nits

- **[Knowledge/Graph]** Initial graph zoom does not auto-fit: with 42 nodes, several nodes at the bottom-right are clipped at the viewport edge on first render (`19-graph-view-final.png`). The `zoomIdentity.translate(width/2, height/2).scale(0.9)` in `graph.tsx` is a fixed guess rather than a bounds-computed fit-to-view.

- **[Knowledge/View]** Detail view shows linked_pages and backlinks only when they exist — no empty-state message for pages with zero links. For newly created pages the links sections are simply absent with no "No linked pages yet" hint.

- **[Knowledge/Graph]** "Fact" type label appears cut off or absent in the graph type legend at 1440px width (`18-graph-view-initial.png`). Fact nodes render correctly; it is a legend wrapping nit.

---

## Coverage Gaps

- **TipTap rich editor**: The audit brief mentioned TipTap for wiki editing. The current implementation uses a plain `<textarea>`. TipTap is present in the Notes surface but not wired to the Knowledge/Wiki edit flow.
- **[[wiki-link]] autocomplete**: Not present on this surface. Only exists (if at all) in the Notes TipTap editor.
- **Promote-note-to-wiki flow**: Originates from the Notes surface (covered in notes-deep audit) — not triggered from within the knowledge surface.
- **Cross-reference inline editing**: Citations render correctly in detail view but cannot be authored via the UI.
- **Export content**: Download icon (`/api/wiki/export?format=md`) present but file content not verified.
- **Version history UI**: Code exists (page.tsx lines 715-757) but only appears when `detail.version > 1`. All seeded pages are v1; section was not exercised.
- **Space-scoped pages**: No pages in `scope=space` in seed data — Space filter returns 0. Filter UI works but content path untested.
- **Mobile viewport**: Not tested in this audit.

---

## Raw Logs

See `run.log` in this directory.

Console errors captured: 0


Network errors (4xx/5xx): 0


Page errors (uncaught JS): 0


---

## Screenshots Index

| File | Description |
|---|---|
| `01-knowledge-hub-initial-load.png` | /knowledge initial load — full list with all controls visible |
| `02-knowledge-list-view.png` | List view with all 41 pages |
| `03-filter-concepts.png` | Type filter: Concepts (6 cards) |
| `04-filter-decisions.png` | Type filter: Decisions (9 cards with Reverse buttons) |
| `05-filter-scope-org.png` | Scope filter: Org |
| `06-search-postgresql.png` | Search "PostgreSQL" with Decisions type filter still active — P1 finding |
| `07-search-deployment.png` | Search "deployment" — 1 result |
| `08-search-docker.png` | Search "Docker" — 2 results |
| `09-detail-view-initial.png` | Detail: "Sonnet for Reasoning" — linked pages + backlinks visible; content as raw text (P2) |
| `10-detail-view-links-section.png` | Detail: linked pages section scrolled |
| `11-create-modal-open.png` | Create Wiki Page modal — blank; no Tags field (P2) |
| `12-create-modal-filled.png` | Create Wiki Page modal — filled |
| `13-after-create-list.png` | List after create — new page present |
| `14-edit-page-detail.png` | Audit test page detail view |
| `15-edit-mode-active.png` | Edit mode with original content in textarea |
| `16-edit-mode-content-typed.png` | Edit mode — updated content typed |
| `17-save-btn-missing.png` | Edit in progress — Cancel + Save buttons clearly visible top-right (edit succeeded) |
| `18-graph-view-initial.png` | Graph: 42 nodes, 33 edges, type legend, "42 pages · 33 connections" overlay |
| `19-graph-view-final.png` | Graph: fully rendered — some nodes near viewport bottom edge (Nit) |
