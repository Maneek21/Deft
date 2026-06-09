# Demo Walkthrough — Testers Tomatoes

When you run `pnpm db:seed:demo`, you get a fully lived-in workspace for a
fictional family tomato farm. Six people, a busy week, real conflicts. Spend
ten minutes inside and you'll see what makes Deft different from a pile of
separate chat, task, and wiki tools.

---

## How to seed

From the repo root, with the dev stack running (`docker compose up -d` or
`pnpm dev`):

```bash
# Without AI — workspace boots, agent stays disabled until a key is configured
pnpm db:seed:demo
```

The `db:seed:demo` proxy chains two scripts: this seed (wipes and re-creates
the workspace) and then `seed-platform-bundles.ts` (re-installs bundled
skills, task templates, employee templates).

Anthropic, OpenRouter, and self-hosted Ollama work too — open Settings → AI
in the workspace as Diego (owner) to switch providers per-org.

---

## Logins (password is **`tomato123`** for everyone)

| Email | Role | Title |
|---|---|---|
| `diego@testers-tomatoes.com` | **owner** | Founder & Farm Manager — start here, sees everything |
| `marigold@testers-tomatoes.com` | admin | Head Grower — runs the greenhouse |
| `lina@testers-tomatoes.com` | member | Sales & Wholesale Lead — buyer pipeline |
| `sage@testers-tomatoes.com` | member | QC & Food Safety — owns the GAP audit |
| `cesar@testers-tomatoes.com` | member | Field Supervisor — outdoor crops + weather |
| `tomas@testers-tomatoes.com` | member | Logistics & Distribution — trucks + cold storage |

The fastest way to feel the product: log in as Diego in one browser, open an
incognito window as Lina or Sage. You'll see how the same workspace looks
completely different depending on who you are — and how the agent's answers
shift to match. That contrast is the demo.

---

## The week you're walking into

It's the third week of May, 2026. The farm is in the thick of spring
harvest. Five things are on Diego's mind:

1. **A storm's coming.** Cesar flagged hail risk for Tuesday–Wednesday. The Roma block in the south field is fruiting — losing it would cost ~$22k. Decision needed today.
2. **Sunbelt wants a contract.** 1,200 lbs/week of slicers, six weeks, $1.85/lb. Diego has to confirm supply before Friday.
3. **The greenhouse is too humid.** Marigold's overnight log shows 84% humidity in GH-2. If they don't fix it, the Cherokee Purples will catch early blight.
4. **A new buyer is visiting Friday.** Asha Mehta from Field Co-op — second wholesale contract of the season, heritage varieties at a premium.
5. **The food safety audit is in 4 weeks.** Sage just told Diego (in DM) that handwashing compliance is at 60%. That's audit-failing.

Everything you'll see in chat, tasks, notes, and the wiki traces back to one
of those five threads. In a standalone chat app the conversation floats away. In a standalone task tool the tasks have no context. In a standalone wiki the notes live in a different universe. In
Deft, they're one substrate.

---

## What's in the seeded workspace

- **10 spaces** — `#general`, `#greenhouse`, `#field-ops`, `#sales-and-buyers`, `#logistics`, `#harvest-room`, `#random`, plus 3 DMs from Diego (Marigold / Lina / Sage), plus 6 1:1 DMs between Defty and each human.
- **79 chat messages** with reactions, 5 pinned messages, threaded replies.
- **3 projects** — `HARV` (Spring 2026 Harvest), `WHL` (Wholesale Expansion), `GH3` (Greenhouse 3 Build-out).
- **30 tasks** across every status (backlog → todo → in_progress → in_review → done), p0–p3 priorities, with overdue + this-week + next-week due dates. 14 task comments, 14 activity log entries, 7 labels.
- **8 wiki pages** forming a knowledge graph (varieties, pest playbook, irrigation, cold chain, buyer directory, market pricing, climate setpoints, GAP audit checklist). Linked to each other internally.
- **9 notes** — a mix of private strategy and shared org notes.
- **12 cross-references** linking chat messages → tasks and tasks → tasks.
- **29 entity-tags** weaving messages / tasks / notes through 8 tag families (`heritage`, `weather`, `audit`, `buyer`, `gh-3`, `cold-chain`, `pricing`, `urgent`).
- **Defty** — built-in agent. His DM is pinned at the top of each user's DM list, with a personalized welcome message keyed off their role.

---

## Five things to do, in order

### 1. Be Diego for two minutes
Log in as Diego. The dashboard shows what's on his plate today: overdue
tasks, unread mentions, today's priorities. Click into `#general` — the
morning standup vibe gives you the feel of a real team. Skim `#field-ops`
to see Cesar's hail warning (pinned).

> **What to notice:** every channel has *stakes*. These are real decisions
> getting made in chat that turn into work.

### 2. Follow a real decision from chat into action

Open `#field-ops` and find Cesar's hail warning. Diego replied *"Do it.
Better insurance than insurance."* Now click over to **Tasks → HARV**. The
first task — **HARV-1, "Install hail netting on south field"** — is in
progress, p0, due tomorrow.

Open the task. You'll see:
- The conversation it came from (linked back to Cesar's chat message)
- Comments from Cesar, Tomás, and Diego planning the install
- Watchers (Diego is watching — he wants to know when it's done)
- An activity log

> **What to notice:** the task didn't appear by magic. A chat message
> became a task without anyone copy-pasting. Six months from now, you'll
> still know why this task exists.

### 3. Ask the agent something hard *(needs a configured AI provider)*

Anywhere in chat, type `@deft` followed by:

- `what's the status on the Sunbelt contract, and is there anything I should worry about?`
- `what tasks are overdue or due this week?`
- `summarize the GH-3 build status`
- `why did we issue a credit memo to Green Leaf?`
- `what's blocking us from committing to Whole Foods?`

The agent pulls from chat, tasks, wiki pages, AND Diego's DMs (only the ones
Diego can see). It synthesizes — with citations.

> **What to notice:** the agent isn't just searching. It's reading the
> *structured* state of the workspace and forming an answer. This is the
> direct-SQL-access advantage. A chatbot plugged into a chat export cannot
> do this.

### 4. See how the same workspace looks to different people

Open an incognito window. Log in as **Lina**.
- Her dashboard shows *her* work. The Sunbelt contract is front and center.
- She has a pinned private note: "Asha Mehta visit prep — Friday."
- She has a DM with Diego about a *confidential* Whole Foods conversation. Members can't see that conversation. Even the agent respects it.

Now log in as **Sage** in another incognito tab.
- Her world is the food safety audit.
- Her DM with Diego is *only* between them. As Sage, ask the agent `@deft what's our handwashing compliance rate?` — she gets a candid 60% answer. As Cesar, the agent doesn't have that information.

> **What to notice:** Deft is multi-tenant by design AND permission-scoped
> per user. The agent works for *you*, not the org — so it tells you what
> you're allowed to know.

### 5. Wander the knowledge graph

Open the wiki. Eight pages, all linked to each other:

- **Tomato Variety Guide** — the team's living reference for every variety
- **Pest Management Playbook** — protocol, organic vs conventional
- **Irrigation Schedules** — including the citric-acid emitter-flush trick
- **Cold-Chain Protocol** — including the May 14 Green Leaf incident write-up
- **Wholesale Buyer Directory** — Sunbelt, Green Leaf, Field Co-op, confidential Whole Foods exploration
- **Farmers Market Pricing Strategy** — heat-day display adjustments
- **Greenhouse Climate Setpoints** — the BTU/sqft rule for GH-3
- **Food Safety Audit Checklist (USDA GAP)** — pre-audit checklist

Each page links to the related pages. The wiki isn't a documentation
graveyard — it's where the team puts the lessons that *should* outlive the
chat thread that produced them.

> **What to notice:** notes are personal. Wiki pages are institutional. The
> agent reads both. The team gets smarter over time because nothing falls
> into a chat scrollback.

---

## What's intentionally NOT in the seed

A few things you'll notice are bare. None of them are bugs — they're the
choices we made to keep the seed self-contained:

- **No integrations connected.** Calendar feeds and MCP connections are available in Settings, but nothing is linked. Add an ICS feed to see external calendar events pull live data.
- **Email/password auth only.** Self-hosted Deft uses the first signup plus invite flow; managed OAuth sign-in is not part of this build.
- **No file uploads or images in chat.** Same reason — would have needed real binary fixtures.
- **AI is opt-in.** Without a configured provider key or local Ollama route, the agent is dormant. The workspace works fully without it: chat + tasks + notes + wiki + reactions + threads all functional.

---

## Re-seeding

The script is destructive — it `DELETE`s every row from every table before
re-inserting. Re-running gives you the same workspace fresh. If you've added
your own users or content while testing, back them up first.

```bash
pnpm db:seed:demo  # wipes everything, re-creates Testers Tomatoes
```

The seed script lives at `packages/db/seed-demo.ts` — open it if you want to
add scenarios, change the cast, or fork the workspace for your own demo.
