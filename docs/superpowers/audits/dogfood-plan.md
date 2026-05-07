# Dogfood validation plan

**Goal:** find the second wave of UX issues that automated smoke + narrow walkthroughs miss — the ones that only show up when a human actually *uses* the product.

**Approach:** one long Playwright run with a headed Chrome window + deliberate slow-mo, walking ten realistic journeys end to end. The script moves, hovers, pauses, types at human-ish speed, and watches for friction.

**Output:** severity-tagged findings report at `docs/superpowers/audits/dogfood-findings.md` plus annotated screenshots.

## Journeys

| # | User goal | What we look for |
|---|---|---|
| J1 | **Morning check-in.** Open dashboard, scan Agent Activity, skim pending approvals. | Scroll behavior, bento layout on 1440×900, which cards are below the fold, empty-state copy, load perf. |
| J2 | **Tune an agent's personality.** Settings → Agent → kebab → Personality → edit SOUL.md → try Save (gateway unreachable). | Kebab click target size, menu hover states, Save-disabled tooltip, empty-file state, back-nav. |
| J3 | **Set up a structured heartbeat.** Kebab → Personality → HEARTBEAT.md → Add check × 2 → fill rows → try Save. | Number-input usability, Add-check feedback, Raw-markdown round-trip, deleting rows. |
| J4 | **Pull credentials for SDK work.** Kebab → Developer → Reveal → copy wscat. | Reveal-gate behavior, copy buttons feedback, docs-link visibility, masked display truncation. |
| J5 | **Wire an external webhook.** Kebab → Webhooks → create → copy secret/URL → revoke. | Create-only-once secret UX, copy affordance, confirm() revoke flow, empty-state copy. |
| J6 | **Browse ClawHub.** Library → ClawHub tab → Import a skill → click Attach-to-agent CTA. | Tab transition, Source external-link behavior, import success banner, CTA switch to Skills tab. |
| J7 | **Have an agent conversation.** `/chat` → send message → wait for tool_calls → expand "Show trace" → Export trace. | Streaming render, tool-call badges, trace expander clarity, download filename, Export-trace placement. |
| J8 | **Clone + save-as-template.** Kebab → Clone agent → verify new row → kebab → Save as template → fill modal. | Clone confirmation, slug-collision handling, modal focus trap, validation copy. |
| J9 | **Responsive — tablet viewport.** Resize to 1024×768 and 768×1024, revisit the above surfaces. | Sidebar collapse, grid reflow, hit-target sizing, overflow. |
| J10 | **Keyboard-only nav.** Tab through sidebar → Settings → Agent row → kebab → open menu → arrow through. | Focus outlines, skip links, ESC closes menus, aria-labels. |

## Severity scale

- 🛑 **Blocker** — feature is unusable or data-corrupting.
- ⚠️ **Major** — real friction; a new user would churn or file a complaint.
- 🟡 **Minor** — noticeable but workable; polish backlog.
- • **Nit** — copy, alignment, small visual.
- ℹ **Note** — environmental or future observation.

## Success criteria

- Zero blockers.
- All majors triaged with either a fix plan or an explicit "accepted risk" note.
- Minors + nits captured for a later polish sweep; not merge-blocking.
