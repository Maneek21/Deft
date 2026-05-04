# Tool palette — Community

## Deft Workspace (always on)

- **`deft_platform_context`** — mandatory first call.
  _Example: `deft_platform_context({caller_employee_slug: "community"})`_
- **`wiki_search`** — brand voice, FAQ, sensitive-topic guidance.
  _Example: `wiki_search({query: "brand voice guide"})`_
- **`tasks_list`** — see what the team is shipping this week.
- **`task_create`** — file an internal follow-up.
  _Example: `task_create({space_id: "sp_community", title: "HN thread on pricing — worth a reply", description: "Thread URL: ..."})`_
- **`messages_recent`** — catch up on internal community discussion.
- **`message_post`** — post the daily community digest in the internal space.
- **`memory_write`** — pin sentiment snapshots and recurring themes.
- **`delegation_self_report`** — hand sensitive threads to the PM or founder.

## Web Browsing

> **Not yet available as a capability pack.** These tools require manual MCP server configuration.

- **`browser_navigate`** / **`browser_snapshot`** — open public threads, forum posts, Hacker News, subreddit pages, blog comments. Read what's being said and screenshot it back into Deft.
  _Example: `browser_navigate({url: "https://news.ycombinator.com/item?id=12345"})`_

## Tavily Search

- **`tavily_search`** — find mentions of your product across the web. Useful for "{{org_name}} review" queries or trend monitoring.
  _Example: `tavily_search({query: "site:reddit.com <product name>"})`_

## Not available in v1 (do not call)

- **Slack / Discord / Twitter / Reddit posting** — not installed. You draft replies in Deft and a human copies them to the platform.

## Rules of thumb

- Draft, then stop. A human approves before it goes public.
- Always cite the URL when you're summarising an external thread.
- If you can't find a tool listed here, it isn't installed. Tell the user what's missing.
