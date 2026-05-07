# Marketing site review — http://localhost:4321/

**Reviewed:** homepage + Workspace, Agents, Use cases, Security, Open source, Pricing.
**Tested:** dark/light theme toggle, in-page links, console errors, scroll layout at desktop width.
**Lens:** does it convey "a unified workspace where humans and agents work side by side" — and walk through every feature, clearly and impressively?

## Verdict

**Mostly yes, but not on the most important screen.** The site looks polished. Typography, layout, and the surface-card grid all read like a serious product. The feature coverage is thorough — every major surface (Chat, Tasks, Notes, Knowledge, Calendar, Dashboard) and every governance concept (trust tiers, approval rails, spend caps, audit log) gets a section. The "How it connects" cross-surface diagram and the "Notion + Linear + chatbot can't do this" SQL diff are both strong, memorable proof points.

What it does **not** do well: the **homepage hero buries the humans-and-agents-side-by-side story.** The headline is a generic "the workspace your team will actually use," and AI is a clause at the end of the subtitle. The hero visual shows an Agent Activity panel and a Defty plan card — but a first-time visitor who hasn't read the deck won't read it as "your team and the agents in one room." They'll read it as "another workspace tool with an AI sidecar."

There are also a handful of credibility-damaging bugs (most importantly, the same agent mock duplicated 6 times on the Use Cases page) and a missing mobile menu.

## Top issues, prioritized

### P0 — fix before showing to anyone

**1. Use Cases page repeats the exact same `PlanProposalMock` 6 times.**

`src/pages/use-cases.astro` renders six "loops" (L01–L06: launch triage → customer follow-up → PR-merged → standup → onboarding → decision capture) but the right column on every loop is the *same* hardcoded mock — same Defty avatar, same `#launch-q2` thread, same `ENG-142/143/156` query results. The text describes six different scenarios; the visual says they're all the same scenario. This is the single biggest credibility hit on the site.

*Fix:* either parameterize `PlanProposalMock.astro` to take `{ avatar, space, ago, steps[], primaryActionLabel }` and pass distinct content for each loop, or build five new mocks (`CustomerReplyMock`, `PRMergedMock`, `StandupMock`, `OnboardingMock`, `DecisionMock`) and import them per-loop. Parameterizing is faster; bespoke mocks land harder.

**2. Hero doesn't state the side-by-side narrative.**

Headline: *"The workspace your team will actually use."* Subtitle leads with surfaces and ends with "*With AI that already understands the work…*" The phrase the user wants visitors to feel ("**humans and agents working side by side, in one workspace**") never appears.

*Fix — proposed copy:*

```
Eyebrow:  Open source · Self-hostable · Humans + agents
Title:    The workspace where your team and the agents
          do the work — together.
Subtitle: Chat, tasks, notes, calendar, knowledge, and a dashboard
          built for both people and agents. Same rooms. Same data.
          Same approval trail. No copy-paste between AI and the work.
```

Or, lighter-touch version that keeps the existing voice:

```
Title:    The workspace your team — and the agents — will actually use.
Subtitle: Six surfaces, one source of truth. Humans and agents working
          on the same data, with one approval trail and one bill at the
          end of the month.
```

**3. Mobile nav is broken.**

`src/components/Nav.astro` shows the link list only at `md:flex` and there is no hamburger / off-canvas replacement. On a phone the visitor sees the logo, theme toggle, and "Join waitlist" — and **no way to get to /workspace, /agents, /use-cases, /security, /open-source, or /pricing.** Confirmed by grep: no `MobileMenu`, no `md:hidden` nav fallback anywhere in the repo.

*Fix:* add a hamburger button (`md:hidden`) that toggles a slide-down panel containing the same links plus the GitHub link. Astro has no JS by default — you'll need a small `<script>` block with a class-toggle, or wrap the nav in a `details/summary` for a no-JS solution.

### P1 — credibility & polish

**4. `https://github.com/anthropics/deft` everywhere.**

Hard-coded in `Nav.astro:44`, `Footer.astro:31`, `open-source.astro:136` (the `git clone` command), and `open-source.astro:249` ("View on GitHub →"). That's not the real repo URL and `git clone` will 404. Either centralize it as a constant (e.g. `src/config.ts` exporting `GITHUB_URL`) and point it at the actual repo, or keep a placeholder but make it obvious during dev (`href="#repo-tbd"`).

**5. Mock dashboards stay dark in light mode.**

When the user toggles to light, the page goes light but the `DashboardMock`, `ApprovalCardMock`, `PlanProposalMock`, etc. keep their dark backgrounds. Result: dark "panels" floating on a white page. It looks unintentional, not stylistic.

*Fix options:* (a) make the mocks `dark:` only and swap to a light variant at light-mode (most work), (b) wrap each mock in a "device frame" — rounded-corner outer card with a subtle bezel — so the dark interior reads as "a screen showing a UI" rather than "a stale dark widget" (lowest effort, most visual upside), or (c) accept the mismatch and remove the theme toggle from the marketing site entirely. (b) is what I'd ship.

**6. The "Six surfaces" cards don't reinforce the side-by-side frame.**

Each card answers "what is this surface?" and most mention AI in passing, but only 2 of 6 (Chat, Dashboard) actually call out the human + agent dynamic. The user wants this site to *feel* like both parties live here.

*Fix — rewrite the example line on each card to show the humans+agents loop:*

| Surface | Today's example line | Suggested |
|---|---|---|
| Chat | `@deft summarize what we promised acme` | `@maneek raised a blocker → @deft proposed a plan → team approved` |
| Tasks | `ENG-142 · in progress · @maneek` | `Created by @defty from #eng mention · assigned to @maneek` |
| Notes | `2026-04-21 · Auth migration sync` | `Promoted by @defty · co-edited with @maneek` |
| Knowledge | `Search "session token storage"` | (keep — it's good) |
| Calendar | `9:00 standup · 2:00 demo · 4:00 review` | `Standup auto-drafted by @defty · sent by @maneek` |
| Dashboard | `My Work · Briefing · Agent Activity · Focus` | (keep — Agent Activity already says it) |

**7. Hero visual under-uses the story.**

The right side of the hero shows a Kanban board (My Work) + an Agent Activity feed. It's a static dashboard. The most visceral thing this product does — a chat thread where a person says "blocker," an agent proposes a 3-step plan, and a person clicks Approve — only appears as a small floating card under the dashboard. It should be the center of the hero.

*Fix:* invert the visual hierarchy. Lead with the chat-thread-with-agent-plan as the primary mock (large, centered or right) and demote the Kanban to a smaller secondary mock. The chat thread is the moment that says "humans and agents in the same room" in one screenshot.

### P2 — nice to have

**8. Use Cases right column should *show* the result, not (only) the plan.**

Each loop has a clear "Result" line in copy ("Blockers assigned, commented, and tracked," "Tasks marked done, team DM'd," etc.) but the visual is always the *plan being proposed*, not the *outcome*. For L03 (PR-merged → done), show a task card actually transitioning to `done` with a PR attribution comment. For L04 (standup), show the posted standup. For L01 (triage), the plan-proposal mock is appropriate — keep it there.

**9. AI multiplier section misses an obvious bullet.**

It lists three trust levels, three approval tiers, and budget guards. It should explicitly call out the human-in-the-loop role:

> Humans approve. Agents act. Always linked. Every external write is a row in `agent_actions` with the approver's name on it.

Add as a fourth bullet, or replace the current "Daily budgets" bullet with this and merge budgets into the surrounding paragraph.

**10. No social proof on the homepage.**

Pricing has FAQ, but the homepage closes with "Join the waitlist" without a single number. Even a simple line — *"X teams in private beta"* or *"Y agent actions logged across the cohort this week"* — would land harder. If you don't have numbers yet, a one-line quote from a beta team is fine.

**11. Hero secondary CTA `See how it works →` is vague.**

Points at `/workspace` (a sub-landing page). Consider a more concrete label: *"Watch a real loop run →"* (point at /use-cases) or *"See the architecture →"* depending on the audience you want clicking it.

**12. Eyebrow `Open source · Self-hostable` doesn't match the hero's job.**

The hero's job is to land the side-by-side narrative. "Open source · Self-hostable" is true and matters, but it's a *trust* signal that already gets a full section lower on the page (Built on trust). Use the eyebrow for the positioning instead — e.g., `Humans + agents · One workspace` — and let the trust section carry the open-source story.

## What's working — keep these

- The "**Six surfaces. One tool.**" grid is a clean, scannable feature tour. Don't lose this layout.
- The **CrossRefMock** (chat → task → decision → wiki, all rows in the same Postgres) is the single best concrete proof that "the AI sees the whole thread." Keep it; consider promoting it higher up the page.
- The **SQLDiffMock** (other AI tools paste 2,847 chars of stale context, Deft runs `SELECT … 14 rows · 22ms`) is the strongest competitive differentiation moment on the site. Keep.
- **Security and Open source pages** are detailed enough to satisfy a buyer doing diligence. Both ground claims in concrete tables/columns/license clauses, not marketing fluff.
- **Pricing page** is honest — same product at every tier, FAQ is direct. Don't over-engineer it.
- **Voice** is consistent across the site: short sentences, concrete nouns, no enterprise jargon. Keep the writer.

## Recommended order of work

1. Fix the Use Cases mock duplication (P0 #1) — single biggest credibility leak.
2. Rewrite the hero copy + restructure the hero visual (P0 #2, P1 #7) — highest impact on whether visitors "get it" in 5 seconds.
3. Add a mobile menu (P0 #3) — anyone sharing this on a phone hits a dead end today.
4. Centralize / fix the GitHub URL (P1 #4) — quick win.
5. Add device frames around the dark mocks for light mode (P1 #5) — quick win.
6. Refresh the Six Surfaces example lines (P1 #6) — 30 min of copy work.
7. Add the human-in-the-loop bullet to the AI multiplier section (P2 #9).
8. Outcome-mock variants for the Use Cases right column (P2 #8).

The first four are roughly a half-day of work and would meaningfully lift the impression the site leaves.
