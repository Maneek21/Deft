# Deft Customer Website

Standalone customer-facing marketing site for Deft, built with Astro.

This folder is intentionally separate from the product app under `apps/web`,
but its design system is **deliberately coupled** to the product. The CSS
tokens in `src/styles/global.css` are a verbatim port of
`apps/web/src/app/globals.css` so the marketing surfaces and the in-app
surfaces look identical.

## Direction

Mirrors the product's "obsidian" design system:

- Tonal layering instead of borders (the "no-line rule")
- Muted-violet primary (`#C8BFFF` dark / `#6A59E0` light)
- Inter for body, JetBrains Mono for code and task IDs
- 8px card radius, soft shadows, glass surfaces for floating chrome
- Dark by default, light mode via class on `<html>` (no `prefers-color-scheme`)

Messaging leads with Deft's real differentiator: agents query the workspace
database directly across chat, tasks, decisions, notes, and connected events
— rather than reverse-engineering the team through APIs and pasted summaries.
Defty is the built-in agent; external agents (Claude Code, Claude Desktop,
Codex, Cursor, any MCP runtime) connect with one API key. The workspace
still works without AI in the loop.

## Stack

- [Astro 4](https://astro.build) — static output, no SSR
- [Tailwind CSS 3](https://tailwindcss.com) via `@astrojs/tailwind`
- Pure HTML/CSS — no React, no client-side routing

## Pages

- `/` — homepage
- `/product` — how it works (native data + approval rails + operating model)
- `/agents` — Defty + BYOA story (Claude Code, Desktop, Codex, Cursor, MCP)
- `/use-cases` — six concrete coordination loops
- `/security` — tenant isolation, approval rails, audit, spend caps
- `/open-source` — BSL 1.1, self-host, attribution
- `/pricing` — beta tiers + waitlist form

## Components

Layout:
- `src/layouts/Layout.astro`, `Nav.astro`, `Footer.astro`, `ThemeToggle.astro`, `brand/Logo.astro`

Marketing primitives:
- `Hero`, `SectionHeader`, `Card`, `BentoGrid` + `BentoItem`, `CTABand`

Product-faithful mockups (recreations of real product surfaces):
- `mock/SidebarMock`, `mock/DashboardMock`, `mock/ApprovalCardMock`,
  `mock/PlanProposalMock`, `mock/TaskKanbanMock`, `mock/ChatMessageMock`,
  `mock/SQLDiffMock`

## Local development

This folder is **not** part of the pnpm workspace. Install with the
`--ignore-workspace` flag (already pinned in `.npmrc` for this directory):

```bash
cd customer-website
pnpm install --ignore-workspace
pnpm dev      # http://localhost:4321
pnpm build    # static output to dist/
pnpm preview  # serve dist/ locally
```

## Deployment

Any static host. The `dist/` directory after `pnpm build` is fully
self-contained.

## TODO

- [ ] Wire the waitlist form on `/pricing#waitlist` to a real backend
      (Resend, Substack, Typeform, or a hosted API route).
- [ ] Add a real OG image at `/og.png` (currently falls back to the icon).
- [ ] Set the canonical site URL in `astro.config.mjs` once a domain is live.
