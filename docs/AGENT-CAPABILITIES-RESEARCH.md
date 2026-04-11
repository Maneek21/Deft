# Agent Capabilities Research — What Makes the Best Agents Tick

> Research compiled April 11, 2026. Covers: Claude Managed Agents, OpenAI Codex, Devin, Cursor, Manus, CrewAI, LangGraph, and patterns from production agent systems.

---

## 1. Architecture Patterns That Work

### The Agent Loop

Every top agent follows the same core loop: **Reason → Act → Observe → Repeat**. The difference between good and great agents is what happens inside each phase.

**Claude Code / Managed Agents:** Three phases blend together — gather context, take action, verify results. Tools are used throughout. The loop runs until the agent determines the task is complete or it runs out of budget.

**Devin:** Compound AI system with three specialized models — Planner (strategy), Coder (execution), Critic (adversarial review). Each step is verified before proceeding.

**Manus:** Iterative loop (analyze → plan → execute → observe) with CodeAct approach — uses executable Python as its action mechanism, not just tool calls. This gives it arbitrary computation ability.

**Key insight for Deft:** Our `agent-runner.ts` runs a simple loop (call API → execute tools → repeat, max 8 iterations). The best agents have **verification built into the loop** — they don't just execute, they check their own work before proceeding.

### Multi-Agent Coordination

Four patterns from LangGraph's research, applicable to Deft's agent employees:

| Pattern | How It Works | Deft Equivalent |
|---------|-------------|-----------------|
| **Subagents** | Supervisor delegates to stateless workers | Defty dispatching work to employees |
| **Skills** | Single agent loads specialized prompts on-demand | Employee role templates + system prompts |
| **Handoffs** | Active agent changes based on context | Agent-to-agent @mentions (Phase 6) |
| **Router** | Classify input → dispatch to specialists in parallel | Defty routing questions to the right employee |

**Cursor 3** runs up to 8 agents in parallel using git worktrees for isolation. Each agent has its own codebase copy. This is the "subagent" pattern at its most aggressive.

**OpenAI Codex** uses a manager agent that decomposes tasks and spawns worker agents in isolated cloud sandboxes. The manager maintains the plan; workers are stateless.

**Claude Managed Agents** has two modes: Agent Teams (teammates self-coordinate via shared task list) and Subagents (orchestrator spawns workers, all coordination flows through orchestrator).

**Key insight for Deft:** Our Phase 6 (Multi-Agent Orchestration) should use the **subagent pattern** — Defty as orchestrator, employees as stateless workers that receive focused instructions and return results. No direct agent-to-agent communication initially.

---

## 2. Memory Systems — The Biggest Gap

This is where Deft's agents are weakest. Every production agent platform has moved beyond stateless invocations.

### Memory Types (from production systems)

| Type | What It Stores | Duration | How Retrieved | Deft Status |
|------|---------------|----------|---------------|-------------|
| **Short-term (Working)** | Current conversation + tool results | Session | In context window | Have it (conversation history) |
| **Episodic** | Past interactions as time-series events | Long-term | Temporal queries | Partially (agentMemory with conversation scope) |
| **Semantic** | Distilled facts and knowledge | Permanent | Vector similarity search | Partially (agentMemory with user/org scope) |
| **Entity** | Structured knowledge about people, projects, concepts | Permanent | Graph traversal | Missing (have people tables but agents don't use them) |
| **Procedural** | Learned workflows and skills | Permanent | Exact lookup | Missing |

### How Top Systems Implement Memory

**CrewAI:** Four memory types — short-term (conversation buffer), long-term (persistent across sessions), entity (structured info about entities mentioned), contextual (relevant context from past interactions). All agents in a crew share memory.

**Mem0:** Vector database + knowledge graph hybrid. Stores memories as graph nodes with entity relationships. Sub-50ms retrieval. Auto-consolidation merges contradictory memories.

**Zep:** Temporal knowledge graph built asynchronously from conversation episodes. Background engine extracts entities and relationships without blocking the agent.

**Key pattern — Memory Consolidation Pipeline:**
1. **Hot path (active session):** Agent reads from long-term storage into working memory
2. **Warm storage:** Background process extracts structured facts asynchronously after session
3. **Cold archive:** Compressed logs for compliance

**Key insight for Deft:** Our `agentMemory` table is a flat key-value store. It needs to become a **tiered system**:
- **Session memory:** What happened in this conversation (already have this)
- **Employee memory:** What this specific employee has learned across all conversations (partially have — user scope)
- **Entity memory:** Structured facts about people, projects, tasks that agents auto-update (need to build — can leverage existing people analytics tables)
- **Procedural memory:** "Last time I generated a standup, the user asked me to include PRs" → agent learns preferences (need to build)

---

## 3. Self-Correction and Verification

The single biggest performance differentiator. LangChain's research showed that adding a self-verification loop jumped their coding agent from 52.8% to 66.5% accuracy — **just by changing the harness, not the model**.

### Patterns That Work

**Reflection Loop (Generate → Reflect → Refine):**
1. Agent produces output
2. Agent evaluates its own output against criteria
3. Agent revises based on self-critique
4. Repeat until quality threshold met or budget exhausted

**Chain of Verification:**
1. Agent generates answer
2. Generates verification questions about its own answer
3. Answers those questions independently
4. Compares — if inconsistencies found, regenerates

**Devin's Critic Model:**
- Separate adversarial model reviews code for security vulnerabilities and logic errors
- Output is not committed until the critic approves

**Key insight for Deft:** Our agents currently do single-pass generation. Adding a reflection step after tool execution — "Did this result make sense? Did I answer the user's question?" — would significantly improve quality. Cost: 1 extra API call per response. Benefit: 25-40% improvement in task completion.

Implementation approach: After the agent's final text response, add a verification call:
```
"You just responded to the user. Review your response:
1. Did you answer their actual question?
2. Are your citations accurate?
3. Did any tool calls fail that you should mention?
4. Is there anything you should have checked but didn't?
If issues found, provide a corrected response. If not, say VERIFIED."
```

---

## 4. Tool Use and Environment Access

### What Top Agents Can Do

| Capability | Claude CU | Codex | Devin | Cursor | Manus | Deft Today |
|-----------|-----------|-------|-------|--------|-------|------------|
| Read/write files | Yes | Yes | Yes | Yes | Yes | No (wiki only) |
| Run terminal commands | Yes | Yes | Yes | Yes | Yes | No |
| Web browsing | Yes | No | Yes | Limited | Yes | No |
| Code execution (sandbox) | Yes | Yes | Yes | Yes | Yes | No |
| Computer use (GUI) | Yes | No | No | No | No | No |
| Database queries | No | No | No | No | No | Yes (direct SQL) |
| Team/org awareness | No | No | No | No | No | Yes (unique) |
| Calendar/email | No | No | No | No | Yes | Yes (partial) |
| Multi-app orchestration | Via MCP | Via tools | Built-in | Via MCP | Built-in | Via MCP (built) |

**Deft's unique advantage:** Direct SQL access to organizational data. No other agent platform has this. Claude Code can read files; Devin can browse the web; but only Deft agents can query "who's overloaded?" and get a real answer from actual task data.

**Deft's biggest gap:** No web browsing, no code execution, no file system access. These are table-stakes for agents that "do work" rather than "report on work."

### MCP Ecosystem (1,600+ servers as of March 2026)

Most relevant MCP servers for Deft agent employees:

| Server | What It Enables | Priority |
|--------|----------------|----------|
| **Zapier** | 7,000+ app actions (email, CRM, finance, marketing) | High — already planned |
| **GitHub** | Full API — repos, issues, PRs, code search, workflows | High — partially built |
| **Browserbase / Playwright** | Web browsing, research, form filling | High — unlocks research tasks |
| **Slack** | Read/send messages, channels, users | Medium — scaffolded |
| **Google Drive** | Read/create documents, sheets, presentations | Medium — unlocks doc generation |
| **Supabase / PostgreSQL** | Query external databases | Medium — extend SQL advantage |
| **Sentry** | Error monitoring, issue tracking | Medium — engineering agent use case |
| **Linear** | Issue tracking, project management | Medium — scaffolded |
| **Chroma / Qdrant** | Vector search for semantic memory | Low — can use pgvector instead |

---

## 5. Autonomy Levels and Self-Direction

### How Top Agents Initiate Work

**Cursor Automations:** Agents triggered by code changes, Slack messages, timers, or PagerDuty incidents. The agent runs autonomously in the cloud without human initiation.

**Devin:** User describes task in Slack or Teams. Devin works in a cloud sandbox, opening PRs and responding to code review comments autonomously.

**Manus:** User describes a task, then Manus works for hours/days with full browser, code, and shell access. Returns completed deliverables.

**Key insight for Deft:** Our agent employees are currently **reactive** — they respond to mentions, messages, and task assignments. The next level is **proactive** — agents that:
- Monitor workspace state and surface insights without being asked
- Notice patterns ("Task velocity has dropped 30% this week — should I investigate?")
- Self-initiate work based on triggers they define themselves
- Follow up on their own work ("I posted the standup report — any feedback?")

### Autonomy Spectrum

```
Level 0: Chatbot (answer questions)                    ← Deft Phase 1
Level 1: Tool user (search + report)                   ← Deft today
Level 2: Action taker (create/update with approval)    ← Deft today (with trust levels)
Level 3: Autonomous worker (complete tasks end-to-end) ← Deft target (employees + plans)
Level 4: Proactive teammate (self-initiate + follow up) ← Deft next
Level 5: Self-improving agent (learn from feedback)    ← Future
```

---

## 6. What Deft Should Adopt

### Tier 1 — Quick Wins (Days, Not Weeks)

**1a. Increase iteration budget for employees**
- `agent-runner.ts`: 8 → 25 iterations for `mode: 'background'`
- `agent.ts`: Keep 50 iterations for streaming (already sufficient)
- Cost: ~2x token usage per complex task. Worth it.

**1b. Add self-verification step**
- After final response, one verification call to check accuracy
- Cost: 1 extra API call. ~25-40% quality improvement.

**1c. Systematic memory usage**
- Employees auto-store key findings in `agentMemory` with `scope: 'org'` after each invocation
- Before each invocation, load relevant org-scope memories into system prompt
- Pattern: "Before starting, recall what you know about this topic"

### Tier 2 — High-Impact Features (Weeks)

**2a. Web browsing via MCP**
- Connect Playwright MCP or Browserbase MCP server
- Employees can research, verify, and gather external information
- Unlocks: competitive analysis, documentation lookup, vendor research

**2b. Entity memory layer**
- Auto-extract entities (people, projects, decisions) from agent interactions
- Store in structured format (leverage existing people analytics tables)
- Agents query entity memory before reasoning: "What do I know about Project Alpha?"

**2c. Proactive monitoring triggers**
- Employees periodically scan their domain (cron-triggered)
- PM agent: daily task health check, auto-post if issues found
- Engineering Lead: PR stale check, auto-notify reviewers
- EA: calendar conflict detection, auto-suggest reschedule

**2d. Reflection and self-correction loop**
- After tool execution, verify results make sense
- After task completion, review own work against original request
- If quality score < threshold, revise and resubmit

### Tier 3 — Differentiation (Months)

**3a. Code execution sandbox**
- Employees can write and run code (data analysis, report generation)
- Sandboxed environment with timeout and resource limits
- Unlocks: custom reports, data visualization, script automation

**3b. Procedural memory (learning from feedback)**
- Track user corrections and preferences
- Build per-employee preference models
- "User Maneek prefers standup reports with PR links included"
- Agents adapt behavior over time without prompt changes

**3c. Cross-agent delegation (Phase 6)**
- Defty can delegate sub-tasks to specific employees
- Employees can request help from other employees via Defty
- Shared task list with dependency management (Claude Agent Teams pattern)

**3d. Agent self-evaluation and improvement**
- Agents rate their own performance after each task
- Low-scoring responses flagged for human review
- High-scoring patterns reinforced in procedural memory

---

## 7. Competitive Positioning After Adoption

| Capability | After Tier 1 | After Tier 2 | After Tier 3 |
|-----------|-------------|-------------|-------------|
| Workspace intelligence | Best in class | Best in class | Best in class |
| Task completion quality | Good → Great | Great | Excellent |
| Autonomy level | Level 2-3 | Level 3-4 | Level 4-5 |
| External tool access | MCP foundation | MCP + web | MCP + web + code |
| Memory and learning | Basic | Entity-aware | Self-improving |
| Multi-agent coordination | Sequential | Trigger-based | Full delegation |

**Deft's enduring moat:** Direct SQL on organizational data + people analytics + multi-agent with shared workspace context. No other platform has all three. Web browsing and code execution are commodities (every agent has them). Team intelligence is not.

---

## 8. Deep Dive: OpenClaw's Heartbeat System

OpenClaw (100k+ GitHub stars) is the most relevant open-source agent architecture to study. It solves the exact problem Deft faces: making agents proactive, not just reactive.

### The Heartbeat — Cron-Triggered Agent Loop

The heartbeat is a scheduled trigger (default: every 30 minutes). On each beat:
1. Agent reads `HEARTBEAT.md` — a plain-English checklist of proactive tasks
2. Evaluates whether anything needs attention right now
3. If yes → takes action (sends messages, runs tools, updates files)
4. If no → responds `HEARTBEAT_OK` (suppressed, no notification, minimal token cost)

**Example HEARTBEAT.md:**
```markdown
# Heartbeat Tasks

### Every 30 minutes:
- Check Gmail via `gog` tool for emails marked "Urgent"
- If found, send summary to Telegram
- If nothing is urgent, reply with HEARTBEAT_OK

### Every morning at 9am:
- Generate daily standup from yesterday's activity
- Post in #engineering Slack channel

### Every Friday at 5pm:
- Generate weekly project summary
- Email to team leads
```

**Why it works:**
- Token-efficient: Isolated sessions cut usage by 60-80% vs continuous monitoring
- Self-modifiable: Agents can rewrite their own HEARTBEAT.md ("check emails every 15 minutes instead of 30")
- Context-aware: Unlike cron scripts, heartbeat tasks have access to agent memory and can reason about context
- Non-intrusive: HEARTBEAT_OK suppression means the agent stays silent when nothing needs attention

### OpenClaw Memory System

Plain markdown files — no external databases:

```
~/.openclaw/workspace/
├── AGENTS.md          # Agent configuration
├── SOUL.md            # Personality, preferences, tone
├── MEMORY.md          # Long-term learned facts
├── HEARTBEAT.md       # Proactive task checklist
└── memory/
    ├── 2026-02-15.md  # Daily ephemeral logs
    └── 2026-02-16.md  # Append-only daily events
```

**MEMORY.md** = long-term facts (user preferences, tech stack, scheduling constraints). Loaded on-demand, not injected every turn.

**SOUL.md** = personality and communication style. Shapes how the agent reasons and communicates.

**Daily logs** = append-only files capturing events. Agent retrieves via memory tools when relevant.

**Compaction**: When context exceeds window, older turns are summarized into compressed entries preserving semantic content.

### OpenClaw Skills

Same SKILL.md standard as Claude Code. Skills are directories with instructions, loaded on-demand:
- Context assembly includes only a compact list of available skills (name + description)
- Agent loads full skill content only when relevant
- Keeps base prompt lean regardless of skill count

### Key Design Principle: Serial Execution

OpenClaw processes messages **serially per session** via a Command Queue. No parallel execution within a session — prevents tool conflicts and state corruption. Multiple agents can run on different channels simultaneously, but each session is single-threaded.

---

## 9. Deep Dive: Claude Skills & MCP Integration

### Claude Code Skills Architecture

Skills are the "progressive disclosure" mechanism — the agent loads specialized knowledge on-demand rather than carrying everything in context.

**How it works:**
1. Skills stored as `SKILL.md` files with YAML frontmatter + markdown instructions
2. At session start, Claude sees a compact list of available skills (name + when to use)
3. When a task matches a skill, Claude invokes it via the `Skill` meta-tool
4. The skill's full content is injected as user messages into conversation context
5. Claude follows the instructions, then the skill's effect fades as conversation continues

**Invocation control:**
- Default: both user and Claude can invoke any skill
- `disable-model-invocation: true` — only user can invoke (for workflows with side effects)
- `/skill-name` — user types directly to invoke

**The meta-tool pattern:** The `Skill` tool doesn't execute actions — it injects instructions. It's a context modifier, not a function. This is elegant because skills can contain workflows, checklists, decision trees — anything expressible in natural language.

### Claude MCP Integration

Three MCP primitives that Claude uses:

| Primitive | What It Does | How Claude Accesses It |
|-----------|-------------|----------------------|
| **Tools** | Functions the agent can execute | Listed in tool menu, called via tool_use blocks |
| **Resources** | Structured data to read/write | User types `@` to see MCP resources alongside files |
| **Prompts** | Predefined templates for common tasks | User types `/` → `mcp__servername__promptname` |

**Dynamic updates:** MCP servers can send `list_changed` notifications. Claude auto-refreshes available capabilities without reconnection. This is important for Deft — when an org adds/removes MCP tools, agents should see changes immediately.

**Claude Managed Agents + MCP:** Managed Agents run in isolated containers with MCP connections pre-configured. The agent has full browser, shell, code execution, and MCP tool access in its sandbox. This is the "maximally capable" agent — it can do anything a human can do on a computer.

---

## 10. Deep Dive: Deft's Wiki as Agent Brain

Deft has something none of the agents above have: a **self-maintaining knowledge graph** that auto-populates from team conversations.

### The Wiki Pipeline (Karpathy's LLM Wiki Pattern)

```
Chat message
    ↓
Haiku classifier → extracts facts[] + decision
    ↓
memory-extract worker
    ├→ LLM decides: CREATE new page or UPDATE existing
    ├→ Executes ingest (insert/append + links + citations)
    └→ CASCADE: Updates related pages for consistency
    ↓
wiki_pages + wiki_links + wiki_citations
    ↓
Daily wiki-lint worker:
    ├→ Orphan detection (pages with no links or citations)
    ├→ Stale page decay (confidence reduces over time)
    ├→ Confidence threshold deletion (<0.3 auto-deleted)
    └→ LLM-powered contradiction detection between linked pages
    ↓
Agent context injection:
    → Top 3 relevant pages (FTS + confidence ranking) auto-loaded
    → Agent can wiki_search, wiki_read, wiki_write, wiki_suggest_update
```

### What Makes It a Brain (Not Just a Wiki)

| Feature | Traditional Wiki | Deft Wiki Brain |
|---------|-----------------|-----------------|
| Population | Manual | Auto-extracted from chat via LLM |
| Updates | Manual | Cascade updates propagate automatically |
| Quality control | None | Daily linter: orphans, staleness, contradictions |
| Confidence | None | 0.0-1.0 score, decays over time, auto-deletes below 0.3 |
| Agent integration | Read-only | Full CRUD + auto-context injection |
| Graph structure | None | Typed links with backlinks |
| Source attribution | None | Citations trace every fact to source message |
| Versioning | Basic | Full version history with previous_content snapshots |

### Seven Wiki Page Types (Agent Knowledge Categories)

| Type | Purpose | Example |
|------|---------|---------|
| **concept** | Abstract ideas and patterns | "Microservices Architecture" |
| **entity** | Named things (people, projects, tools) | "Project Alpha", "React v19" |
| **decision** | Choices made with context | "Use PostgreSQL over MongoDB" |
| **resource** | Links, docs, references | "API Documentation Links" |
| **procedure** | How-to workflows | "Deploy to Production Checklist" |
| **preference** | Team/user preferences | "Standup format: bullet points, include PRs" |
| **fact** | Standalone data points | "Sprint velocity: 42 points/week" |

### How Agents Use the Wiki Today

1. **Auto-context:** Before every response, top 3 relevant pages injected into system prompt (FTS weighted: title=A, summary=B, content=C, multiplied by confidence)
2. **wiki_search:** Full-text search with type/scope filtering
3. **wiki_read:** Full page + linked pages + backlinks + citations (graph traversal)
4. **wiki_write:** Create or update pages with link management
5. **wiki_suggest_update:** Propose changes without overwriting (logged for human review)

### What's Missing for Full Brain Capability

1. **Agent employees don't write to wiki systematically** — They can, but nothing prompts them to. Needs: "After completing a task, update relevant wiki pages with findings"
2. **No semantic search** — Only PostgreSQL FTS (keyword matching). Needs: pgvector for "find pages about topics similar to X"
3. **No per-employee wiki scoping** — All employees see the full wiki. Needs: employee can have preferred wiki pages or specialized sections
4. **Wiki not used for procedural memory** — Agent preferences and learned patterns aren't stored as wiki pages. Needs: "preference" type pages auto-created from user feedback
5. **No wiki-driven task decomposition** — Agent can't look at procedure pages to figure out how to do a task. Needs: When assigned a task, search for relevant procedure pages first

---

## 11. Synthesis: What Deft Should Adopt from Each

### From OpenClaw: The Heartbeat

**Adapt for Deft agent employees:**
- Each employee gets a `heartbeat` field (jsonb) on `agent_employees` table — their proactive task checklist
- Configurable interval (default 30 min) via `heartbeat_interval_minutes`
- On each heartbeat: employee runs `agent-runner.ts` with heartbeat instructions
- If nothing to do → `HEARTBEAT_OK` (no action, minimal tokens)
- If action needed → execute tools, post in channels, DM users
- Employees can self-modify their heartbeat via wiki_write to a special procedure page

**Token efficiency:** OpenClaw's isolated session pattern cuts 60-80% of monitoring costs. Deft can do the same — heartbeat sessions use minimal context (just the checklist + recent wiki pages), not full conversation history.

### From Claude: Skills as Employee DNA

**Adapt for Deft agent employees:**
- Employee `system_prompt` already works like a skill — loaded on invocation
- Add: Employee-specific "knowledge pages" (wiki pages tagged to that employee)
- Before each invocation, auto-load the employee's tagged wiki pages alongside the top 3 FTS results
- This gives each employee a growing, self-maintaining knowledge base
- Employees learn by writing to their own knowledge pages after completing tasks

### From Claude MCP: Dynamic Tool Discovery

**Already built** — Deft's MCP client discovers tools with 5-min cache. But missing:
- `list_changed` notification handling (tools update without manual refresh)
- Resource primitive support (MCP resources as contextual data, not just tools)
- Prompt primitive support (MCP prompts as reusable workflows)

### From Manus/Devin: CodeAct and Verification

**Adapt for Deft:**
- Code execution sandbox for agent employees (generate + run reports, data analysis)
- Critic step after every write action (self-verification before committing)
- Task decomposition using wiki procedure pages as templates

### From CrewAI: Shared Memory Across Agents

**Already partially built** — Deft wiki is shared across all agents. But missing:
- Entity memory: auto-extract people/project/tool mentions into structured entity pages
- Short-term shared context: When PM agent discovers a blocker, Engineering Lead agent should know immediately (not wait for next wiki sync)
- Event-driven memory updates: Real-time wiki updates from agent actions, not just chat messages

---

## Sources

- [Claude Managed Agents Overview](https://platform.claude.com/docs/en/managed-agents/overview)
- [Anthropic Multi-Agent Research System](https://www.anthropic.com/engineering/multi-agent-research-system)
- [OpenAI Codex](https://openai.com/codex/)
- [OpenAI Codex Subagents](https://www.aimagicx.com/blog/openai-codex-subagents-autonomous-coding-team-2026)
- [Devin AI Complete Guide](https://www.digitalapplied.com/blog/devin-ai-autonomous-coding-complete-guide)
- [Cursor Agent Mode](https://cursor.com/agents)
- [Cursor 3 Agents Window](https://devtoolpicks.com/blog/cursor-3-agents-window-review-2026)
- [Manus AI Architecture (GitHub Gist)](https://gist.github.com/renschni/4fbc70b31bad8dd57f3370239dccd58f)
- [Manus AI arxiv Paper](https://arxiv.org/html/2505.02024v1)
- [LangGraph Multi-Agent Architecture](https://blog.langchain.com/choosing-the-right-multi-agent-architecture/)
- [CrewAI Framework](https://crewai.com/open-source)
- [Agent Memory Systems Architecture](https://www.analyticsvidhya.com/blog/2026/04/memory-systems-in-ai-agents/)
- [Mem0 Paper](https://arxiv.org/pdf/2504.19413)
- [AI Agent Memory (IBM)](https://www.ibm.com/think/topics/ai-agent-memory)
- [Agent Memory with Redis](https://redis.io/blog/ai-agent-memory-stateful-systems/)
- [Self-Correcting Multi-Agent Systems](https://medium.com/@sohamghosh_23912/self-correcting-multi-agent-ai-systems-building-pipelines-that-fix-themselves-010786bae2db)
- [AI Agent Reflection Patterns](https://zylos.ai/research/2026-03-06-ai-agent-reflection-self-evaluation-patterns)
- [MCP Servers Repository](https://github.com/modelcontextprotocol/servers)
- [MCP Ecosystem 2026](https://www.contextstudios.ai/blog/mcp-ecosystem-in-2026-what-the-v127-release-actually-tells-us)
- [Anthropic Trustworthy Agents](https://www.anthropic.com/research/trustworthy-agents)
- [Claude Code Agent Skills](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
