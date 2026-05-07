# Connect Playwright MCP Server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the Playwright MCP server so agent employees can browse the web, research information, fill forms, and verify external content.

**Architecture:** Playwright MCP server runs locally via stdio (`npx -y @playwright/mcp@latest`). Deft's MCP client already supports stdio transport. We need: guided setup on the integrations page, a pre-configured connection template, and testing with an agent employee.

**Tech Stack:** `@playwright/mcp` (npm), Deft MCP client (`packages/mcp/`), existing integrations UI

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `apps/web/src/app/(app)/settings/integrations/page.tsx` | Modify | Add "Connect Playwright" guided setup button |
| `apps/web/src/components/mcp-connection-form.tsx` | Modify | Pre-fill template for Playwright |
| `apps/api/src/routes/agent-employees.ts` | Modify | Add web browsing tools to role templates |

---

### Task 1: Add Playwright Guided Setup to Integrations Page

**Files:**
- Modify: `apps/web/src/app/(app)/settings/integrations/page.tsx`

- [ ] **Step 1: Add "Connect Playwright" quick-connect button**

Find the section with "Connect Zapier" and "Connect n8n" buttons. Add a third button:

```typescript
<button
  onClick={() => openFormWithTemplate({
    name: 'Playwright Browser',
    transport: 'stdio',
    stdio_command: 'npx',
    stdio_args: ['-y', '@playwright/mcp@latest', '--headless'],
    auth_type: 'none',
    default_trust_tier: 'auto',  // browser tools are read-only by default
  })}
  style={{ /* same style as other quick-connect buttons */ }}
>
  Connect Playwright
</button>
```

The `--headless` flag runs the browser without a visible window. For self-hosted deployments where users want to see the browser, they can remove this flag.

- [ ] **Step 2: Verify the form pre-fills correctly**

When the user clicks "Connect Playwright", the `mcp-connection-form.tsx` modal should open with:
- Name: "Playwright Browser"
- Transport: stdio (selected)
- Command: `npx`
- Args: `-y @playwright/mcp@latest --headless`
- Auth: None
- Default trust tier: Auto (read-only browsing is safe)

Check that `mcp-connection-form.tsx` accepts a template/prefill prop. If not, add one.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/(app)/settings/integrations/page.tsx apps/web/src/components/mcp-connection-form.tsx
git commit -m "feat(ui): add Playwright MCP guided setup on integrations page"
```

---

### Task 2: Install Playwright MCP and Test Connection

**Files:** None (manual testing)

- [ ] **Step 1: Ensure npx and Node.js are available**

Run: `node --version` (should be 18+)
Run: `npx --version` (should work)

- [ ] **Step 2: Test Playwright MCP server manually**

Run: `npx -y @playwright/mcp@latest --headless`

This should start the MCP server. It will wait for stdio input. Kill it with Ctrl+C.

- [ ] **Step 3: Create the connection via the API**

```bash
curl -X POST http://localhost:3001/api/mcp-connections \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Playwright Browser",
    "transport": "stdio",
    "stdio_command": "npx",
    "stdio_args": ["-y", "@playwright/mcp@latest", "--headless"],
    "auth_type": "none",
    "default_trust_tier": "auto"
  }'
```

- [ ] **Step 4: Test the connection**

```bash
curl -X POST http://localhost:3001/api/mcp-connections/:id/test \
  -H "Authorization: Bearer $TOKEN"
```

Expected: `{ "success": true, "toolCount": N }` where N is the number of Playwright tools discovered.

- [ ] **Step 5: Refresh tools to see what's available**

```bash
curl -X POST http://localhost:3001/api/mcp-connections/:id/refresh-tools \
  -H "Authorization: Bearer $TOKEN"
```

- [ ] **Step 6: Verify tools merged into agent**

Send a message to Alex PM or Defty: "What tools do you have for browsing the web?"

The agent should see Playwright tools like `mcp__playwright-browser__browser_navigate`, `mcp__playwright-browser__browser_snapshot`, etc. in its tool list.

---

### Task 3: Add Web Browsing to Agent Employee Templates

**Files:**
- Modify: `apps/api/src/routes/agent-employees.ts`

- [ ] **Step 1: Update role templates with browsing guidance**

In the role templates, add browsing instructions to each system prompt. Find the `ROLE_TEMPLATES` object and append to each template's system prompt:

For **project_manager**:
```
## Web Browsing
- You may have web browsing tools available (Playwright). Use them when you need to:
  - Research external information relevant to tasks or projects
  - Verify links or resources shared by team members
  - Check project documentation on external sites
- Always summarize what you find — don't dump raw page content.
```

For **engineering_lead**:
```
## Web Browsing
- You may have web browsing tools available (Playwright). Use them when you need to:
  - Check npm package versions, security advisories, or documentation
  - Review PR descriptions or CI status on GitHub (if not connected natively)
  - Research technical solutions or library comparisons
- Always summarize findings concisely with links.
```

For **executive_assistant**:
```
## Web Browsing
- You may have web browsing tools available (Playwright). Use them when you need to:
  - Research meeting attendees or their companies
  - Check travel or venue information for upcoming meetings
  - Verify links shared in conversations
- Always provide actionable summaries.
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/routes/agent-employees.ts
git commit -m "feat(templates): add web browsing guidance to role templates"
```

---

### Task 4: End-to-End Test — Agent Browsing the Web

**Files:** None (Playwright test)

- [ ] **Step 1: Connect Playwright MCP via the UI**

Navigate to Settings > Integrations. Click "Connect Playwright". Save. Test connection.

- [ ] **Step 2: Assign Playwright to Alex PM**

Update Alex PM's MCP connections:

```bash
curl -X PUT http://localhost:3001/api/agent-employees/:id \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mcp_connection_ids": ["PLAYWRIGHT_CONNECTION_ID"]}'
```

- [ ] **Step 3: Ask Alex PM to browse**

On the agent page, Alex PM tab, send: "Go to https://news.ycombinator.com and tell me what the top 3 stories are right now."

Expected: Alex PM uses Playwright tools to navigate to the page, read the content, and summarize the top stories.

- [ ] **Step 4: Verify tool calls in response**

The response should show tool usage (if tool indicators are visible) and cite the MCP connection as a source.

- [ ] **Step 5: Screenshot the result**

Take a screenshot showing Alex PM's web browsing response.

---

## Verification

After all tasks:

1. Playwright MCP connection visible in Settings > Integrations with green status dot
2. Tool count > 0 after refresh
3. Alex PM can browse web pages and summarize content
4. Playwright tools appear in agent's tool list with `mcp__playwright-browser__` prefix
5. Trust tier is "auto" (browsing is read-only, no approval needed)

## Notes

- Playwright MCP uses **stdio transport** — only works on self-hosted or dev environments. For SaaS production, use SSE transport with `--port 3100` flag and connect via server URL.
- The `--headless` flag is important for background agent use. Without it, a browser window opens on the server.
- Each Playwright session consumes ~114k tokens. Keep this in mind for daily action budgets.
- Playwright MCP tools are read-only (navigate, snapshot, click, fill) — they don't create permanent state, so `auto` trust tier is appropriate.

Sources:
- [@playwright/mcp on npm](https://www.npmjs.com/package/@playwright/mcp)
- [Playwright MCP GitHub](https://github.com/microsoft/playwright-mcp)
