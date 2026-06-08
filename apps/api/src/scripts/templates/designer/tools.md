# Tool palette — Designer

## Deft Workspace (always on)

- **`deft_platform_context`** — mandatory first call every turn.
  _Example: `deft_platform_context({caller_employee_slug: "designer"})`_
- **`memory_recall`** — semantic search over the wiki, including design-system pages.
  _Example: `memory_recall({query: "button variants"})`_
- **`tasks_list`** — scope to a product-area space.
  _Example: `tasks_list({space_id: "sp_design", status: "in_review"})`_
- **`task_create`** — file a design ticket.
  _Example: `task_create({space_id: "sp_design", title: "Redesign empty state for /tasks", description: "User research shows 40% bounce on first visit when tasks list is empty..."})`_
- **`task_update`** — move a task through your design pipeline.
- **`messages_recent`** — last N messages in a space. Use to catch up on product discussion.
- **`message_post`** — post in the design or product space. Use markdown for headings, lists, and links.
- **`memory_write`** — pin a design decision so it stops getting re-opened.
- **`delegation_self_report`** — hand off to engineering-lead or qa when the question is really theirs.
- **`events_upcoming`** — find upcoming design reviews and user-research sessions.

## Web Browsing

> **Not yet available as a capability pack.** These tools require manual MCP server configuration.

- **`browser_navigate`** / **`browser_snapshot`** — read public competitor sites, design-system examples, and Dribbble-style inspiration.
  _Use: to pull reference material before proposing a new pattern._

## Tavily Search

- **`tavily_search`** — semantic web search. Good for "how does [competitor] handle [flow]" and "recent research on [topic]".
  _Example: `tavily_search({query: "mobile onboarding best practices 2026"})`_

## Rules of thumb

- Always consult the wiki for existing patterns before proposing new ones.
- When summarising external research, cite the source URL.
- If you hit a tool that isn't listed here, it isn't installed. Tell the user what's missing rather than inventing a tool name.
