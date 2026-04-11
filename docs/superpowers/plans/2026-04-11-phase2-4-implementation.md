# Phase 2-4: MCP + Agent Employees + Plans + Deft MCP Server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform Deft from a single-agent workspace into an agentic employee platform with MCP tool integration, persistent role-based agent employees, multi-step plan execution, and an outbound MCP server for external agents.

**Architecture:** Four integrated layers — MCP Client (universal tool adapter), Agent Employees (full workspace citizens), Multi-Step Plans (conditional execution engine), Deft MCP Server (outbound API for BYOA). All layers share the same approval pipeline from Phase 1, the same schema patterns, and the same tool routing in agent.ts/agent-runner.ts.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, PostgreSQL, Next.js 14, React, Tailwind CSS, `@modelcontextprotocol/sdk`, Socket.io

**Spec:** `docs/superpowers/specs/2026-04-11-phase2-4-mcp-agents-plans.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `packages/db/src/schema.ts` | Modify | New enums, tables, column additions |
| `packages/mcp/src/client.ts` | Create | MCP client manager (connect, discover, execute) |
| `packages/mcp/src/transports.ts` | Create | Transport factory (stdio, SSE, streamable-http) |
| `packages/mcp/src/types.ts` | Create | MCPTool, MCPConnection, MCPResult types |
| `packages/mcp/src/cache.ts` | Create | Tool schema cache with 5-min TTL |
| `packages/mcp/src/index.ts` | Create | Package exports |
| `packages/mcp/package.json` | Create | Package config |
| `packages/mcp/tsconfig.json` | Create | TypeScript config |
| `apps/api/src/routes/mcp-connections.ts` | Create | MCP connection CRUD endpoints |
| `apps/api/src/routes/agent-employees.ts` | Create | Agent employee CRUD + templates |
| `apps/api/src/routes/agent-plans.ts` | Create | Plan CRUD + execution control |
| `apps/api/src/routes/api-keys.ts` | Create | API key management |
| `apps/api/src/routes/mcp-server.ts` | Create | Deft MCP server endpoint |
| `apps/api/src/lib/mcp-tools.ts` | Create | getMCPToolsForAgent, parseMCPToolName |
| `apps/api/src/lib/agent-plans.ts` | Create | Plan execution engine |
| `apps/api/src/lib/agent-tools.ts` | Modify | Add create_plan + SUPERINTENDENT_TOOLS |
| `apps/api/src/lib/agent-approval.ts` | Modify | Add superintendent + MCP tool tier resolution |
| `apps/api/src/lib/agent-context.ts` | Modify | MCP tool routing in executeToolCall |
| `apps/api/src/lib/agent-runner.ts` | Modify | Employee context, action counting, tool scoping |
| `apps/api/src/lib/agent-actions.ts` | Modify | Employee attribution, MCP source |
| `apps/api/src/routes/agent.ts` | Modify | MCP tool merging, employee context, plan SSE events |
| `apps/api/src/workers/index.ts` | Modify | Register new workers |
| `apps/api/src/workers/handlers/agent-employee-message.ts` | Create | DM + @mention handler |
| `apps/api/src/workers/handlers/agent-employee-task.ts` | Create | Task assignment handler |
| `apps/api/src/workers/handlers/agent-employee-trigger.ts` | Create | Trigger evaluation |
| `apps/api/src/workers/handlers/plan-executor.ts` | Create | Plan step execution |
| `apps/api/src/workers/handlers/agent-daily-reset.ts` | Create | Daily counter reset |
| `apps/api/src/index.ts` | Modify | Mount new route files |
| `apps/web/src/app/(app)/settings/integrations/page.tsx` | Create | MCP connections UI |
| `apps/web/src/app/(app)/settings/agent-employees/page.tsx` | Create | Employee list |
| `apps/web/src/app/(app)/settings/agent-employees/create/page.tsx` | Create | Agent builder wizard |
| `apps/web/src/app/(app)/settings/api-access/page.tsx` | Create | API key management |
| `apps/web/src/components/agent-employee-wizard.tsx` | Create | Wizard component |
| `apps/web/src/components/plan-approval.tsx` | Create | Plan approval/edit UI |
| `apps/web/src/components/plan-progress.tsx` | Create | Plan execution progress |
| `apps/web/src/components/mcp-connection-form.tsx` | Create | Add/edit MCP connection |
| `apps/web/src/components/sidebar.tsx` | Modify | Agent employee DM entries |
| `apps/web/src/components/space-chat.tsx` | Modify | @mention autocomplete for employees |
| `apps/web/src/components/task-detail.tsx` | Modify | Employees in assignee dropdown |
| `apps/web/src/app/(app)/settings/page.tsx` | Modify | New settings nav links |
| `apps/web/src/app/(app)/agent/page.tsx` | Modify | Defty/employee tabs |
| `apps/web/src/app/(app)/dashboard/page.tsx` | Modify | Employee filter on activity widget |

---

### Task 1: Schema Migration — New Enums, Tables, and Column Additions

**Files:**
- Modify: `packages/db/src/schema.ts`

This task adds all database changes needed by subsequent tasks. Everything else depends on this.

- [ ] **Step 1: Add new enums after existing enums (after line 25)**

After the existing `wikiPageScopeEnum` line, add:

```typescript
export const mcpTransportEnum = pgEnum('mcp_transport', ['stdio', 'sse', 'streamable-http']);
export const agentEmployeeRoleEnum = pgEnum('agent_employee_role', ['project_manager', 'engineering_lead', 'executive_assistant', 'custom']);
export const planStatusEnum = pgEnum('plan_status', ['draft', 'approved', 'executing', 'paused', 'completed', 'failed']);
export const planStepStatusEnum = pgEnum('plan_step_status', ['pending', 'running', 'completed', 'failed', 'skipped', 'waiting_approval']);
```

- [ ] **Step 2: Modify users table — add is_agent and agent_employee_id columns**

In the `users` table definition (line 41-57), make `email` nullable and add agent columns:

Change:
```typescript
email: text('email').notNull().unique(),
```
To:
```typescript
email: text('email').unique(),
is_agent: boolean('is_agent').default(false).notNull(),
agent_employee_id: text('agent_employee_id'),
```

Note: `agent_employee_id` FK is added after `agent_employees` table is defined (circular reference handled by Drizzle relations, not column-level FK).

- [ ] **Step 3: Modify messages table — add metadata column**

In the `messages` table definition (line 118-135), add after the `metadata` field if it exists, or add:

```typescript
metadata: jsonb('metadata'),  // agent tool calls, citations, tokens for agent employee messages
```

Check if `metadata` already exists on messages — if so, this step is a no-op. (The schema exploration showed it already has a `metadata` field at line 126.)

- [ ] **Step 4: Add mcp_connections table**

After the existing tables, add:

```typescript
export const mcpConnections = pgTable('mcp_connections', {
  ...id(),
  ...orgId(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  server_url: text('server_url'),
  transport: mcpTransportEnum('transport').notNull(),
  stdio_command: text('stdio_command'),
  stdio_args: jsonb('stdio_args'),
  auth_type: text('auth_type').notNull().default('none'),
  auth_config_encrypted: jsonb('auth_config_encrypted'),
  is_active: boolean('is_active').default(true).notNull(),
  last_connected_at: timestamp('last_connected_at'),
  connection_error: text('connection_error'),
  tools_cache: jsonb('tools_cache'),
  tools_cached_at: timestamp('tools_cached_at'),
  default_trust_tier: approvalTierEnum('default_trust_tier').default('full').notNull(),
  enabled_tools: text('enabled_tools').array(),
  created_by: text('created_by').notNull().references(() => users.id),
  ...timestamps(),
}, (t) => [
  index('mcp_conn_org_idx').on(t.org_id),
  uniqueIndex('mcp_conn_slug_unique').on(t.org_id, t.slug),
]);
```

- [ ] **Step 5: Add mcp_tool_overrides table**

```typescript
export const mcpToolOverrides = pgTable('mcp_tool_overrides', {
  ...id(),
  ...orgId(),
  mcp_connection_id: text('mcp_connection_id').notNull().references(() => mcpConnections.id, { onDelete: 'cascade' }),
  tool_name: text('tool_name').notNull(),
  trust_tier_override: approvalTierEnum('trust_tier_override'),
  is_disabled: boolean('is_disabled').default(false).notNull(),
  ...timestamps(),
}, (t) => [
  uniqueIndex('mcp_tool_override_unique').on(t.mcp_connection_id, t.tool_name),
]);
```

- [ ] **Step 6: Add agent_employees table**

```typescript
export const agentEmployees = pgTable('agent_employees', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  role: agentEmployeeRoleEnum('role').notNull(),
  avatar_url: text('avatar_url'),
  system_prompt: text('system_prompt').notNull(),
  expertise_description: text('expertise_description'),
  native_tools: text('native_tools').array(),
  mcp_connection_ids: text('mcp_connection_ids').array(),
  disabled_tools: text('disabled_tools').array(),
  space_ids: text('space_ids').array(),
  project_ids: text('project_ids').array(),
  trust_level: trustLevelEnum('trust_level').default('conservative').notNull(),
  max_daily_actions: integer('max_daily_actions').default(50).notNull(),
  daily_action_count: integer('daily_action_count').default(0).notNull(),
  daily_action_reset_at: timestamp('daily_action_reset_at'),
  is_active: boolean('is_active').default(true).notNull(),
  is_byoa: boolean('is_byoa').default(false).notNull(),
  byoa_model_info: text('byoa_model_info'),
  created_by: text('created_by').notNull().references(() => users.id),
  ...timestamps(),
}, (t) => [
  uniqueIndex('agent_employee_slug_unique').on(t.org_id, t.slug),
  index('agent_employee_org_idx').on(t.org_id),
]);
```

- [ ] **Step 7: Modify triggers table — add agent_employee_id column**

In the `triggers` table definition (line 405-417), add:

```typescript
agent_employee_id: text('agent_employee_id'),  // NULL = org-level trigger, set = employee-scoped
```

- [ ] **Step 8: Add agent_plans table**

```typescript
export const agentPlans = pgTable('agent_plans', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id),
  agent_employee_id: text('agent_employee_id'),
  conversation_id: text('conversation_id'),  // agentConversations.id (Defty) or spaces.id (employee DM)
  title: text('title').notNull(),
  description: text('description'),
  steps: jsonb('steps').notNull(),
  status: planStatusEnum('status').default('draft').notNull(),
  current_step: integer('current_step').default(0).notNull(),
  context: jsonb('context'),
  error: text('error'),
  ...timestamps(),
}, (t) => [
  index('agent_plan_org_idx').on(t.org_id),
  index('agent_plan_employee_idx').on(t.agent_employee_id),
]);
```

- [ ] **Step 9: Add api_keys table**

```typescript
export const apiKeys = pgTable('api_keys', {
  ...id(),
  ...orgId(),
  agent_employee_id: text('agent_employee_id'),
  name: text('name').notNull(),
  key_hash: text('key_hash').notNull(),
  key_prefix: text('key_prefix').notNull(),
  permissions: text('permissions').array().notNull(),
  rate_limit_per_minute: integer('rate_limit_per_minute').default(60).notNull(),
  rate_limit_per_day: integer('rate_limit_per_day').default(10000).notNull(),
  last_used_at: timestamp('last_used_at'),
  request_count: integer('request_count').default(0).notNull(),
  is_active: boolean('is_active').default(true).notNull(),
  expires_at: timestamp('expires_at'),
  created_by: text('created_by').notNull().references(() => users.id),
  ...timestamps(),
}, (t) => [
  index('api_key_org_idx').on(t.org_id),
  index('api_key_prefix_idx').on(t.key_prefix),
]);
```

- [ ] **Step 10: Modify agentActions table — add employee/MCP/plan attribution**

In the `agentActions` table definition (line 354-375), add these columns:

```typescript
agent_employee_id: text('agent_employee_id'),
source: text('source').default('native'),  // 'native' | 'mcp'
mcp_connection_id: text('mcp_connection_id'),
plan_id: text('plan_id'),
plan_step_id: text('plan_step_id'),
```

- [ ] **Step 11: Run migration**

Run: `cd apps/api && pnpm drizzle-kit generate`
Run: `cd apps/api && pnpm drizzle-kit migrate`

If Deft uses push instead of migrate:
Run: `cd apps/api && pnpm drizzle-kit push`

- [ ] **Step 12: Typecheck**

Run: `cd packages/db && pnpm typecheck`
Expected: No errors

- [ ] **Step 13: Commit**

```bash
git add packages/db/src/schema.ts
git commit -m "feat(schema): add MCP, agent employees, plans, and API keys tables

New tables: mcp_connections, mcp_tool_overrides, agent_employees,
agent_plans, api_keys. Modified: users (is_agent, email nullable),
agentActions (employee/MCP/plan attribution), triggers (agent_employee_id).
New enums: mcp_transport, agent_employee_role, plan_status, plan_step_status."
```

---

### Task 2: MCP Client Package

**Files:**
- Create: `packages/mcp/package.json`
- Create: `packages/mcp/tsconfig.json`
- Create: `packages/mcp/src/types.ts`
- Create: `packages/mcp/src/cache.ts`
- Create: `packages/mcp/src/transports.ts`
- Create: `packages/mcp/src/client.ts`
- Create: `packages/mcp/src/index.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@deft/mcp",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.1"
  },
  "devDependencies": {
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create types.ts**

```typescript
export interface MCPConnectionConfig {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  serverUrl?: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  stdioCommand?: string;
  stdioArgs?: string[];
  authType: 'api_key' | 'oauth' | 'none';
  authConfig?: Record<string, any>;
  defaultTrustTier: 'auto' | 'quick' | 'full';
  enabledTools?: string[] | null;  // null = all
}

export interface MCPTool {
  name: string;              // prefixed: mcp__{slug}__{toolName}
  originalName: string;      // original from server
  description: string;
  inputSchema: Record<string, any>;
  connectionId: string;
  connectionSlug: string;
  isWrite: boolean;          // determined by heuristic or override
  approvalTier: 'auto' | 'quick' | 'full';
}

export interface MCPResult {
  content: any;
  isError: boolean;
  error?: string;
}

export interface MCPToolOverride {
  toolName: string;
  trustTierOverride?: 'auto' | 'quick' | 'full';
  isDisabled: boolean;
}
```

- [ ] **Step 4: Create cache.ts**

```typescript
interface CacheEntry<T> {
  data: T;
  cachedAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class ToolCache {
  private cache = new Map<string, CacheEntry<any>>();
  private ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    return entry.data as T;
  }

  set<T>(key: string, data: T): void {
    this.cache.set(key, { data, cachedAt: Date.now() });
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }
}
```

- [ ] **Step 5: Create transports.ts**

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { MCPConnectionConfig } from './types.js';

export async function createTransport(config: MCPConnectionConfig) {
  switch (config.transport) {
    case 'stdio': {
      if (process.env.DEFT_SELF_HOSTED !== 'true') {
        throw new Error('Stdio transport only available in self-hosted mode');
      }
      if (!config.stdioCommand) throw new Error('stdio_command required for stdio transport');
      return new StdioClientTransport({
        command: config.stdioCommand,
        args: config.stdioArgs || [],
      });
    }
    case 'sse': {
      if (!config.serverUrl) throw new Error('server_url required for SSE transport');
      const headers: Record<string, string> = {};
      if (config.authType === 'api_key' && config.authConfig?.apiKey) {
        headers['Authorization'] = `Bearer ${config.authConfig.apiKey}`;
      }
      return new SSEClientTransport(new URL(config.serverUrl), { requestInit: { headers } });
    }
    case 'streamable-http': {
      if (!config.serverUrl) throw new Error('server_url required for streamable-http transport');
      const headers: Record<string, string> = {};
      if (config.authType === 'api_key' && config.authConfig?.apiKey) {
        headers['Authorization'] = `Bearer ${config.authConfig.apiKey}`;
      }
      return new StreamableHTTPClientTransport(new URL(config.serverUrl), { requestInit: { headers } });
    }
    default:
      throw new Error(`Unknown transport: ${config.transport}`);
  }
}
```

- [ ] **Step 6: Create client.ts**

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createTransport } from './transports.js';
import { ToolCache } from './cache.js';
import type { MCPConnectionConfig, MCPTool, MCPResult, MCPToolOverride } from './types.js';

interface PoolEntry {
  client: Client;
  lastUsedAt: number;
  connectionId: string;
  orgId: string;
}

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CONNECTIONS_PER_ORG = parseInt(process.env.MCP_MAX_CONNECTIONS_PER_ORG || '3', 10);
const CONNECT_TIMEOUT_MS = 10_000;
const EXECUTE_TIMEOUT_MS = 30_000;

export class MCPClientManager {
  private pool = new Map<string, PoolEntry>();
  private toolCache = new ToolCache();
  private failureCounts = new Map<string, { count: number; firstFailAt: number; backoffUntil?: number }>();
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor() {
    // Clean up idle connections every 60s
    this.cleanupInterval = setInterval(() => this.cleanupIdle(), 60_000);
  }

  async connect(config: MCPConnectionConfig): Promise<Client> {
    // Check if already pooled
    const existing = this.pool.get(config.id);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing.client;
    }

    // Check org connection limit
    const orgConnections = [...this.pool.values()].filter(e => e.orgId === config.orgId);
    if (orgConnections.length >= MAX_CONNECTIONS_PER_ORG) {
      // Evict least recently used connection for this org
      const lru = orgConnections.sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      await this.disconnect(lru.connectionId);
    }

    // Check backoff
    const failures = this.failureCounts.get(config.id);
    if (failures?.backoffUntil && Date.now() < failures.backoffUntil) {
      throw new Error(`MCP connection ${config.name} is in backoff until ${new Date(failures.backoffUntil).toISOString()}`);
    }

    const transport = await createTransport(config);
    const client = new Client({ name: 'deft-agent', version: '1.0.0' }, { capabilities: {} });

    const connectPromise = client.connect(transport);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Connection timeout')), CONNECT_TIMEOUT_MS)
    );
    await Promise.race([connectPromise, timeoutPromise]);

    this.pool.set(config.id, {
      client,
      lastUsedAt: Date.now(),
      connectionId: config.id,
      orgId: config.orgId,
    });

    // Reset failure count on successful connect
    this.failureCounts.delete(config.id);

    return client;
  }

  async disconnect(connectionId: string): Promise<void> {
    const entry = this.pool.get(connectionId);
    if (entry) {
      try { await entry.client.close(); } catch {}
      this.pool.delete(connectionId);
    }
  }

  async testConnection(config: MCPConnectionConfig): Promise<{ success: boolean; error?: string; toolCount?: number }> {
    try {
      const client = await this.connect(config);
      const tools = await client.listTools();
      await this.disconnect(config.id);
      return { success: true, toolCount: tools.tools.length };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async discoverTools(
    config: MCPConnectionConfig,
    overrides: MCPToolOverride[] = [],
  ): Promise<MCPTool[]> {
    const client = await this.connect(config);
    const response = await client.listTools();

    const overrideMap = new Map(overrides.map(o => [o.toolName, o]));

    const tools: MCPTool[] = [];
    for (const tool of response.tools) {
      // Check if tool is enabled
      if (config.enabledTools && !config.enabledTools.includes(tool.name)) continue;

      const override = overrideMap.get(tool.name);
      if (override?.isDisabled) continue;

      tools.push({
        name: `mcp__${config.slug}__${tool.name}`,
        originalName: tool.name,
        description: tool.description || '',
        inputSchema: tool.inputSchema as Record<string, any>,
        connectionId: config.id,
        connectionSlug: config.slug,
        isWrite: false,  // default to read-only; overridden by trust tier
        approvalTier: override?.trustTierOverride || config.defaultTrustTier,
      });
    }

    // Cache the discovered tools
    this.toolCache.set(`tools:${config.id}`, tools);

    return tools;
  }

  async getCachedTools(
    config: MCPConnectionConfig,
    overrides: MCPToolOverride[] = [],
  ): Promise<MCPTool[]> {
    const cached = this.toolCache.get<MCPTool[]>(`tools:${config.id}`);
    if (cached) return cached;
    return this.discoverTools(config, overrides);
  }

  async executeTool(
    config: MCPConnectionConfig,
    toolName: string,
    params: Record<string, any>,
  ): Promise<MCPResult> {
    const execute = async (): Promise<MCPResult> => {
      const client = await this.connect(config);
      const entry = this.pool.get(config.id);
      if (entry) entry.lastUsedAt = Date.now();

      const resultPromise = client.callTool({ name: toolName, arguments: params });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Tool execution timeout')), EXECUTE_TIMEOUT_MS)
      );
      const result = await Promise.race([resultPromise, timeoutPromise]);

      return {
        content: result.content,
        isError: !!result.isError,
        error: result.isError ? String(result.content) : undefined,
      };
    };

    // Try once, retry once on failure
    try {
      return await execute();
    } catch (err: any) {
      this.recordFailure(config.id);

      // Silent retry
      try {
        await this.disconnect(config.id);
        return await execute();
      } catch (retryErr: any) {
        this.recordFailure(config.id);
        return {
          content: null,
          isError: true,
          error: `MCP tool unavailable after retry: ${retryErr.message}`,
        };
      }
    }
  }

  private recordFailure(connectionId: string): void {
    const existing = this.failureCounts.get(connectionId) || { count: 0, firstFailAt: Date.now() };
    existing.count++;

    // 3 failures within 5 minutes → backoff for 10 minutes
    if (existing.count >= 3 && Date.now() - existing.firstFailAt < 5 * 60 * 1000) {
      existing.backoffUntil = Date.now() + 10 * 60 * 1000;
    }

    this.failureCounts.set(connectionId, existing);
  }

  private cleanupIdle(): void {
    const now = Date.now();
    for (const [id, entry] of this.pool.entries()) {
      if (now - entry.lastUsedAt > IDLE_TIMEOUT_MS) {
        this.disconnect(id).catch(() => {});
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
    for (const [id] of this.pool.entries()) {
      this.disconnect(id).catch(() => {});
    }
  }
}

// Singleton instance
export const mcpClientManager = new MCPClientManager();
```

- [ ] **Step 7: Create index.ts**

```typescript
export { MCPClientManager, mcpClientManager } from './client.js';
export { ToolCache } from './cache.js';
export type { MCPConnectionConfig, MCPTool, MCPResult, MCPToolOverride } from './types.js';
```

- [ ] **Step 8: Install dependencies**

Run: `cd packages/mcp && pnpm install`
Run: `cd /c/Users/Osheen\ Pradhan/cairn && pnpm install`

- [ ] **Step 9: Typecheck**

Run: `cd packages/mcp && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 10: Commit**

```bash
git add packages/mcp/
git commit -m "feat(mcp): add MCP client package with connection pooling

MCPClientManager with warm pool (5min TTL, max 3 per org),
transport factory (stdio/SSE/streamable-http), tool discovery
with 5-min cache, retry-once error handling, health tracking
with 10-min backoff after 3 failures."
```

---

### Task 3: MCP Tool Pipeline Integration

**Files:**
- Create: `apps/api/src/lib/mcp-tools.ts`
- Modify: `apps/api/src/lib/agent-approval.ts`
- Modify: `apps/api/src/lib/agent-context.ts`
- Modify: `apps/api/src/routes/agent.ts`
- Modify: `apps/api/src/lib/agent-runner.ts`

This task wires MCP tools into the existing agent tool pipeline so agents can use MCP tools alongside native ones.

- [ ] **Step 1: Create mcp-tools.ts**

```typescript
import { eq, and } from 'drizzle-orm';
import { db } from '@deft/db';
import { mcpConnections, mcpToolOverrides, agentEmployees } from '@deft/db/schema';
import { mcpClientManager, type MCPTool, type MCPConnectionConfig, type MCPToolOverride } from '@deft/mcp';

function toConnectionConfig(row: typeof mcpConnections.$inferSelect): MCPConnectionConfig {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    slug: row.slug,
    serverUrl: row.server_url || undefined,
    transport: row.transport,
    stdioCommand: row.stdio_command || undefined,
    stdioArgs: (row.stdio_args as string[]) || undefined,
    authType: row.auth_type as 'api_key' | 'oauth' | 'none',
    authConfig: row.auth_config_encrypted as Record<string, any> | undefined,
    defaultTrustTier: row.default_trust_tier,
    enabledTools: row.enabled_tools,
  };
}

export async function getMCPToolsForAgent(
  orgId: string,
  agentEmployeeId?: string,
): Promise<MCPTool[]> {
  // 1. Get active MCP connections for org
  let connections = await db
    .select()
    .from(mcpConnections)
    .where(and(eq(mcpConnections.org_id, orgId), eq(mcpConnections.is_active, true)));

  // 2. If employee, filter by employee's mcp_connection_ids
  if (agentEmployeeId) {
    const employee = await db
      .select()
      .from(agentEmployees)
      .where(eq(agentEmployees.id, agentEmployeeId))
      .limit(1);

    if (employee[0]?.mcp_connection_ids) {
      const allowedIds = new Set(employee[0].mcp_connection_ids);
      connections = connections.filter(c => allowedIds.has(c.id));
    }
  }

  // 3. Get all overrides for these connections
  const connectionIds = connections.map(c => c.id);
  const overrides = connectionIds.length > 0
    ? await db.select().from(mcpToolOverrides).where(
        and(eq(mcpToolOverrides.org_id, orgId))
      )
    : [];

  // 4. Discover/cache tools for each connection
  const allTools: MCPTool[] = [];
  for (const conn of connections) {
    const connOverrides: MCPToolOverride[] = overrides
      .filter(o => o.mcp_connection_id === conn.id)
      .map(o => ({
        toolName: o.tool_name,
        trustTierOverride: o.trust_tier_override || undefined,
        isDisabled: o.is_disabled,
      }));

    try {
      const config = toConnectionConfig(conn);
      const tools = await mcpClientManager.getCachedTools(config, connOverrides);

      // Apply employee disabled_tools filter
      if (agentEmployeeId) {
        const emp = await db.select().from(agentEmployees).where(eq(agentEmployees.id, agentEmployeeId)).limit(1);
        if (emp[0]?.disabled_tools) {
          const disabled = new Set(emp[0].disabled_tools);
          allTools.push(...tools.filter(t => !disabled.has(t.name) && !disabled.has(t.originalName)));
          continue;
        }
      }

      allTools.push(...tools);
    } catch (err) {
      // Connection failed — skip silently, tools won't be available
      console.error(`MCP tool discovery failed for ${conn.name}:`, err);
    }
  }

  return allTools;
}

export function parseMCPToolName(prefixedName: string): { connectionSlug: string; toolName: string } {
  // Format: mcp__{slug}__{toolName}
  const parts = prefixedName.split('__');
  if (parts.length < 3 || parts[0] !== 'mcp') {
    throw new Error(`Invalid MCP tool name: ${prefixedName}`);
  }
  return {
    connectionSlug: parts[1],
    toolName: parts.slice(2).join('__'),  // tool name might contain __
  };
}

export function mcpToolToAnthropicFormat(tool: MCPTool) {
  return {
    name: tool.name,
    description: `[MCP: ${tool.connectionSlug}] ${tool.description}`,
    input_schema: tool.inputSchema,
  };
}
```

- [ ] **Step 2: Modify agent-approval.ts — add MCP tool tier resolution**

In `apps/api/src/lib/agent-approval.ts`, add superintendent tool tiers to TOOL_APPROVAL_TIERS (after line 27):

```typescript
// Superintendent tools (Defty only)
manage_agent_employee: 'full',
list_agent_employees: 'auto',
get_agent_activity: 'auto',
manage_mcp_connection: 'full',
get_agent_economics: 'auto',
manage_triggers: 'quick',
// Plans
create_plan: 'auto',  // creating a plan is read-like — execution needs separate approval
```

Add a new function for MCP tool tier resolution:

```typescript
/** Returns the approval tier for an MCP tool, checking overrides. */
export function getMCPToolApprovalTier(
  toolApprovalTier: ApprovalTier,
): ApprovalTier {
  return toolApprovalTier;  // tier already resolved during discovery
}
```

- [ ] **Step 3: Modify agent-context.ts — add MCP tool routing**

At the top of `executeToolCall` function in `apps/api/src/lib/agent-context.ts`, before the existing switch statement, add:

```typescript
// MCP tool routing — handle before native tools
if (toolName.startsWith('mcp__')) {
  const { connectionSlug, toolName: actualToolName } = parseMCPToolName(toolName);

  // Find connection by slug and org
  const conn = await db
    .select()
    .from(mcpConnections)
    .where(and(eq(mcpConnections.org_id, orgId), eq(mcpConnections.slug, connectionSlug)))
    .limit(1);

  if (!conn[0]) {
    return { result: { error: `MCP connection '${connectionSlug}' not found` }, citations: [] };
  }

  const config = toConnectionConfig(conn[0]);
  const mcpResult = await mcpClientManager.executeTool(config, actualToolName, params);

  return {
    result: mcpResult.isError ? { error: mcpResult.error } : mcpResult.content,
    citations: [{ type: 'mcp', id: conn[0].id, title: `${conn[0].name}: ${actualToolName}` }],
  };
}
```

Add imports at the top:

```typescript
import { mcpConnections } from '@deft/db/schema';
import { mcpClientManager } from '@deft/mcp';
import { parseMCPToolName, toConnectionConfig } from './mcp-tools.js';
```

Note: `toConnectionConfig` needs to be exported from `mcp-tools.ts` — add `export` to its definition.

- [ ] **Step 4: Modify agent.ts — merge MCP tools into tool list**

In `apps/api/src/routes/agent.ts`, after the GitHub tools block (around line 190), add:

```typescript
// MCP tools
const mcpTools = await getMCPToolsForAgent(org.id);
const mcpAnthropicTools = mcpTools.map(mcpToolToAnthropicFormat);
tools = [...tools, ...mcpAnthropicTools];
// Add MCP action tools to the action set
mcpTools.forEach(t => {
  if (t.approvalTier !== 'auto') {
    allActionTools.add(t.name);
  }
});
```

Add imports:

```typescript
import { getMCPToolsForAgent, mcpToolToAnthropicFormat } from '../lib/mcp-tools.js';
```

- [ ] **Step 5: Modify agent-runner.ts — merge MCP tools**

In `apps/api/src/lib/agent-runner.ts`, after the GitHub tools block in `runAgentQuery` (around line 80), add the same MCP tool merging:

```typescript
// MCP tools
const mcpTools = await getMCPToolsForAgent(orgId);
const mcpAnthropicTools = mcpTools.map(mcpToolToAnthropicFormat);
tools = [...tools, ...mcpAnthropicTools];
mcpTools.forEach(t => {
  if (t.approvalTier !== 'auto') {
    allActionTools.add(t.name);
  }
});
```

Add imports:

```typescript
import { getMCPToolsForAgent, mcpToolToAnthropicFormat } from './mcp-tools.js';
```

- [ ] **Step 6: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/mcp-tools.ts apps/api/src/lib/agent-approval.ts apps/api/src/lib/agent-context.ts apps/api/src/routes/agent.ts apps/api/src/lib/agent-runner.ts
git commit -m "feat(agent): integrate MCP tools into agent tool pipeline

MCP tools discovered from active connections, cached 5min,
prefixed mcp__{slug}__{name}, merged into native tool list.
MCP tool execution routed through MCPClientManager.
Approval tiers resolved per-tool with override support."
```

---

### Task 4: MCP Connection CRUD API

**Files:**
- Create: `apps/api/src/routes/mcp-connections.ts`
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Create mcp-connections.ts**

```typescript
import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { db } from '@deft/db';
import { mcpConnections, mcpToolOverrides } from '@deft/db/schema';
import { mcpClientManager } from '@deft/mcp';
import { createId } from '@paralleldrive/cuid2';

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export const mcpConnectionRoutes = new Hono()

  // List org's connections
  .get('/', async (c) => {
    const orgId = c.get('orgId');
    const connections = await db
      .select()
      .from(mcpConnections)
      .where(eq(mcpConnections.org_id, orgId));
    return c.json(connections);
  })

  // Get single connection + tools
  .get('/:id', async (c) => {
    const orgId = c.get('orgId');
    const id = c.req.param('id');
    const conn = await db
      .select()
      .from(mcpConnections)
      .where(and(eq(mcpConnections.id, id), eq(mcpConnections.org_id, orgId)))
      .limit(1);
    if (!conn[0]) return c.json({ error: 'Not found' }, 404);
    return c.json(conn[0]);
  })

  // Create connection
  .post('/', async (c) => {
    const orgId = c.get('orgId');
    const userId = c.get('userId');
    const body = await c.req.json();
    const id = createId();
    const slug = slugify(body.name);

    const [created] = await db.insert(mcpConnections).values({
      id,
      org_id: orgId,
      name: body.name,
      slug,
      server_url: body.server_url,
      transport: body.transport,
      stdio_command: body.stdio_command,
      stdio_args: body.stdio_args,
      auth_type: body.auth_type || 'none',
      auth_config_encrypted: body.auth_config,
      default_trust_tier: body.default_trust_tier || 'full',
      enabled_tools: body.enabled_tools,
      created_by: userId,
    }).returning();

    return c.json(created, 201);
  })

  // Update connection
  .put('/:id', async (c) => {
    const orgId = c.get('orgId');
    const id = c.req.param('id');
    const body = await c.req.json();

    const [updated] = await db
      .update(mcpConnections)
      .set({
        name: body.name,
        slug: body.name ? slugify(body.name) : undefined,
        server_url: body.server_url,
        auth_type: body.auth_type,
        auth_config_encrypted: body.auth_config,
        default_trust_tier: body.default_trust_tier,
        enabled_tools: body.enabled_tools,
        is_active: body.is_active,
      })
      .where(and(eq(mcpConnections.id, id), eq(mcpConnections.org_id, orgId)))
      .returning();

    if (!updated) return c.json({ error: 'Not found' }, 404);
    return c.json(updated);
  })

  // Delete connection
  .delete('/:id', async (c) => {
    const orgId = c.get('orgId');
    const id = c.req.param('id');
    await mcpClientManager.disconnect(id);
    await db.delete(mcpConnections)
      .where(and(eq(mcpConnections.id, id), eq(mcpConnections.org_id, orgId)));
    return c.json({ success: true });
  })

  // Test connection
  .post('/:id/test', async (c) => {
    const orgId = c.get('orgId');
    const id = c.req.param('id');
    const conn = await db.select().from(mcpConnections)
      .where(and(eq(mcpConnections.id, id), eq(mcpConnections.org_id, orgId)))
      .limit(1);
    if (!conn[0]) return c.json({ error: 'Not found' }, 404);

    const { toConnectionConfig } = await import('../lib/mcp-tools.js');
    const config = toConnectionConfig(conn[0]);
    const result = await mcpClientManager.testConnection(config);

    // Update connection status
    await db.update(mcpConnections).set({
      last_connected_at: result.success ? new Date() : undefined,
      connection_error: result.error || null,
    }).where(eq(mcpConnections.id, id));

    return c.json(result);
  })

  // Refresh tools
  .post('/:id/refresh-tools', async (c) => {
    const orgId = c.get('orgId');
    const id = c.req.param('id');
    const conn = await db.select().from(mcpConnections)
      .where(and(eq(mcpConnections.id, id), eq(mcpConnections.org_id, orgId)))
      .limit(1);
    if (!conn[0]) return c.json({ error: 'Not found' }, 404);

    const { toConnectionConfig } = await import('../lib/mcp-tools.js');
    const config = toConnectionConfig(conn[0]);

    const overrides = await db.select().from(mcpToolOverrides)
      .where(eq(mcpToolOverrides.mcp_connection_id, id));

    const tools = await mcpClientManager.discoverTools(config, overrides.map(o => ({
      toolName: o.tool_name,
      trustTierOverride: o.trust_tier_override || undefined,
      isDisabled: o.is_disabled,
    })));

    // Update cache in DB
    await db.update(mcpConnections).set({
      tools_cache: tools as any,
      tools_cached_at: new Date(),
      last_connected_at: new Date(),
      connection_error: null,
    }).where(eq(mcpConnections.id, id));

    return c.json({ tools: tools.length });
  })

  // Override tool trust tier or disable
  .put('/:id/tools/:toolName', async (c) => {
    const orgId = c.get('orgId');
    const connectionId = c.req.param('id');
    const toolName = c.req.param('toolName');
    const body = await c.req.json();

    const existing = await db.select().from(mcpToolOverrides)
      .where(and(
        eq(mcpToolOverrides.mcp_connection_id, connectionId),
        eq(mcpToolOverrides.tool_name, toolName),
      ))
      .limit(1);

    if (existing[0]) {
      const [updated] = await db.update(mcpToolOverrides).set({
        trust_tier_override: body.trust_tier_override,
        is_disabled: body.is_disabled,
      }).where(eq(mcpToolOverrides.id, existing[0].id)).returning();
      return c.json(updated);
    }

    const [created] = await db.insert(mcpToolOverrides).values({
      id: createId(),
      org_id: orgId,
      mcp_connection_id: connectionId,
      tool_name: toolName,
      trust_tier_override: body.trust_tier_override,
      is_disabled: body.is_disabled ?? false,
    }).returning();

    return c.json(created, 201);
  });
```

- [ ] **Step 2: Mount routes in index.ts**

In `apps/api/src/index.ts`, add import and route:

```typescript
import { mcpConnectionRoutes } from './routes/mcp-connections.js';
```

After the existing route mounts (around line 89), add:

```typescript
app.route('/api/mcp-connections', mcpConnectionRoutes);
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/mcp-connections.ts apps/api/src/index.ts
git commit -m "feat(api): add MCP connection CRUD endpoints

List, create, update, delete connections. Test connection,
refresh tools, per-tool trust tier overrides."
```

---

### Task 5: Agent Employee CRUD API

**Files:**
- Create: `apps/api/src/routes/agent-employees.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/lib/agent-actions.ts`

- [ ] **Step 1: Create agent-employees.ts**

```typescript
import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '@deft/db';
import { agentEmployees, users, orgMembers, spaceMembers, spaces, agentActions, apiKeys } from '@deft/db/schema';
import { createId } from '@paralleldrive/cuid2';

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const ROLE_TEMPLATES: Record<string, { system_prompt: string; expertise: string; native_tools: string[] | null }> = {
  project_manager: {
    system_prompt: `You are a Project Manager agent. Your responsibilities:
- Track sprint progress and identify blockers
- Monitor task status across all projects you have access to
- Generate daily standups summarizing team activity
- Alert when tasks are overdue or stalled
- Coordinate task assignments based on team workload
- Keep stakeholders informed with status updates in relevant channels

When assigned a task: read it carefully, gather relevant context using search tools, complete the work, post results as comments, and move to review.
When asked questions: be data-driven, cite specific tasks and metrics.
When posting proactively: be concise, actionable, and post in the right channel.`,
    expertise: 'Sprint tracking, blocker detection, team coordination, status reporting',
    native_tools: null,  // all tools
  },
  engineering_lead: {
    system_prompt: `You are an Engineering Lead agent. Your responsibilities:
- Track PR status and code review progress
- Monitor engineering velocity and task completion
- Alert on stalled PRs or tasks blocked by code review
- Summarize technical decisions from chat discussions
- Track technical debt and architecture decisions in the wiki
- Coordinate engineering work across projects

When assigned a task: analyze the technical context, check related PRs and tasks, provide thorough analysis.
When reviewing: focus on technical accuracy, cite specific code and PR references.`,
    expertise: 'Code review coordination, PR management, technical decisions, velocity monitoring',
    native_tools: null,
  },
  executive_assistant: {
    system_prompt: `You are an Executive Assistant agent. Your responsibilities:
- Manage calendar and prepare meeting briefs
- Summarize email threads and highlight action items
- Generate daily morning briefings with key priorities
- Track action items from meetings and ensure follow-up
- Help schedule and reschedule meetings
- Draft communications based on context

When assigned a task: gather all relevant context (calendar, recent messages, tasks), provide a thorough brief.
When posting proactively: focus on what needs attention today, be concise.`,
    expertise: 'Calendar management, meeting prep, email triage, daily briefings',
    native_tools: null,
  },
};

export const agentEmployeeRoutes = new Hono()

  // Get role templates
  .get('/templates', async (c) => {
    if (process.env.DEFT_SELF_HOSTED === 'true') {
      return c.json([]);  // No templates for self-hosted
    }
    const templates = Object.entries(ROLE_TEMPLATES).map(([role, template]) => ({
      role,
      system_prompt: template.system_prompt,
      expertise: template.expertise,
      native_tools: template.native_tools,
    }));
    return c.json(templates);
  })

  // List org's employees
  .get('/', async (c) => {
    const orgId = c.get('orgId');
    const employees = await db
      .select()
      .from(agentEmployees)
      .where(eq(agentEmployees.org_id, orgId))
      .orderBy(desc(agentEmployees.created_at));
    return c.json(employees);
  })

  // Get single employee
  .get('/:id', async (c) => {
    const orgId = c.get('orgId');
    const id = c.req.param('id');
    const emp = await db.select().from(agentEmployees)
      .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, orgId)))
      .limit(1);
    if (!emp[0]) return c.json({ error: 'Not found' }, 404);
    return c.json(emp[0]);
  })

  // Create employee
  .post('/', async (c) => {
    const orgId = c.get('orgId');
    const userId = c.get('userId');
    const body = await c.req.json();

    if (process.env.DEFT_SELF_HOSTED === 'true' && !body.is_byoa) {
      return c.json({ error: 'Self-hosted only supports BYOA agents' }, 403);
    }

    const employeeId = createId();
    const agentUserId = createId();
    const slug = slugify(body.name);

    // 1. Create user account for the agent
    await db.insert(users).values({
      id: agentUserId,
      email: body.email || null,  // nullable for internal agents
      name: body.name,
      avatar_url: body.avatar_url,
      title: body.role === 'custom' ? 'AI Agent' : body.role.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
      is_agent: true,
      agent_employee_id: employeeId,
    });

    // 2. Add to org
    await db.insert(orgMembers).values({
      id: createId(),
      org_id: orgId,
      user_id: agentUserId,
      role: 'member',
    });

    // 3. Add to spaces (configured or all public)
    const spaceIds = body.space_ids;
    if (spaceIds && spaceIds.length > 0) {
      for (const spaceId of spaceIds) {
        await db.insert(spaceMembers).values({
          id: createId(),
          space_id: spaceId,
          user_id: agentUserId,
        });
      }
    } else {
      // Add to all public spaces
      const publicSpaces = await db.select().from(spaces)
        .where(and(eq(spaces.org_id, orgId), eq(spaces.type, 'public')));
      for (const space of publicSpaces) {
        await db.insert(spaceMembers).values({
          id: createId(),
          space_id: space.id,
          user_id: agentUserId,
        });
      }
    }

    // 4. Create agent employee record
    const template = ROLE_TEMPLATES[body.role];
    const [employee] = await db.insert(agentEmployees).values({
      id: employeeId,
      org_id: orgId,
      user_id: agentUserId,
      name: body.name,
      slug,
      role: body.role,
      avatar_url: body.avatar_url,
      system_prompt: body.system_prompt || template?.system_prompt || 'You are a helpful AI agent.',
      expertise_description: body.expertise_description || template?.expertise,
      native_tools: body.native_tools || template?.native_tools,
      mcp_connection_ids: body.mcp_connection_ids,
      disabled_tools: body.disabled_tools,
      space_ids: body.space_ids,
      project_ids: body.project_ids,
      trust_level: body.trust_level || 'conservative',
      max_daily_actions: body.max_daily_actions || 50,
      is_byoa: body.is_byoa || false,
      byoa_model_info: body.byoa_model_info,
      created_by: userId,
    }).returning();

    // 5. If BYOA, auto-generate API key
    let apiKey = null;
    if (body.is_byoa) {
      const rawKey = `deft_${createId()}`;
      const bcrypt = await import('bcryptjs');
      const keyHash = await bcrypt.hash(rawKey, 10);
      await db.insert(apiKeys).values({
        id: createId(),
        org_id: orgId,
        agent_employee_id: employeeId,
        name: `${body.name} API Key`,
        key_hash: keyHash,
        key_prefix: rawKey.substring(0, 12),
        permissions: ['deft_search_tasks', 'deft_get_task', 'deft_search_messages', 'deft_search_knowledge'],
        created_by: userId,
      });
      apiKey = rawKey;  // Return once, never stored in plaintext
    }

    return c.json({ employee, apiKey }, 201);
  })

  // Update employee
  .put('/:id', async (c) => {
    const orgId = c.get('orgId');
    const id = c.req.param('id');
    const body = await c.req.json();

    const [updated] = await db.update(agentEmployees).set({
      name: body.name,
      system_prompt: body.system_prompt,
      expertise_description: body.expertise_description,
      native_tools: body.native_tools,
      mcp_connection_ids: body.mcp_connection_ids,
      disabled_tools: body.disabled_tools,
      space_ids: body.space_ids,
      project_ids: body.project_ids,
      trust_level: body.trust_level,
      max_daily_actions: body.max_daily_actions,
      avatar_url: body.avatar_url,
    }).where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, orgId))).returning();

    if (!updated) return c.json({ error: 'Not found' }, 404);
    return c.json(updated);
  })

  // Delete employee (soft delete)
  .delete('/:id', async (c) => {
    const orgId = c.get('orgId');
    const id = c.req.param('id');

    const emp = await db.select().from(agentEmployees)
      .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, orgId)))
      .limit(1);
    if (!emp[0]) return c.json({ error: 'Not found' }, 404);

    // Deactivate employee
    await db.update(agentEmployees).set({ is_active: false }).where(eq(agentEmployees.id, id));

    // Deactivate user account
    await db.update(users).set({ is_agent: false }).where(eq(users.id, emp[0].user_id));

    // Expire pending actions
    await db.update(agentActions).set({
      approval_status: 'expired',
    }).where(and(
      eq(agentActions.agent_employee_id, id),
      eq(agentActions.approval_status, 'pending'),
    ));

    return c.json({ success: true });
  })

  // Pause employee
  .post('/:id/pause', async (c) => {
    const orgId = c.get('orgId');
    const id = c.req.param('id');
    await db.update(agentEmployees).set({ is_active: false })
      .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, orgId)));
    return c.json({ success: true });
  })

  // Resume employee
  .post('/:id/resume', async (c) => {
    const orgId = c.get('orgId');
    const id = c.req.param('id');
    await db.update(agentEmployees).set({ is_active: true })
      .where(and(eq(agentEmployees.id, id), eq(agentEmployees.org_id, orgId)));
    return c.json({ success: true });
  })

  // Get employee activity log
  .get('/:id/activity', async (c) => {
    const orgId = c.get('orgId');
    const id = c.req.param('id');
    const actions = await db.select().from(agentActions)
      .where(and(eq(agentActions.agent_employee_id, id), eq(agentActions.org_id, orgId)))
      .orderBy(desc(agentActions.created_at))
      .limit(50);
    return c.json(actions);
  });
```

- [ ] **Step 2: Modify agent-actions.ts — add employee attribution**

In `apps/api/src/lib/agent-actions.ts`, modify `executeActionDirect` to accept optional employee/MCP/plan fields:

Find the `executeActionDirect` function and update its signature and insert to include:

```typescript
export async function executeActionDirect(
  action: string,
  params: any,
  orgId: string,
  userId: string,
  conversationId: string | null,
  approvalTier: 'auto' | 'quick' | 'full',
  options?: {
    agentEmployeeId?: string;
    source?: 'native' | 'mcp';
    mcpConnectionId?: string;
    planId?: string;
    planStepId?: string;
  },
)
```

In the insert call, add the optional fields:

```typescript
agent_employee_id: options?.agentEmployeeId,
source: options?.source || 'native',
mcp_connection_id: options?.mcpConnectionId,
plan_id: options?.planId,
plan_step_id: options?.planStepId,
```

- [ ] **Step 3: Mount routes in index.ts**

```typescript
import { agentEmployeeRoutes } from './routes/agent-employees.js';
```

```typescript
app.route('/api/agent-employees', agentEmployeeRoutes);
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/agent-employees.ts apps/api/src/lib/agent-actions.ts apps/api/src/index.ts
git commit -m "feat(api): add agent employee CRUD with user account creation

Create/list/update/delete/pause/resume employees. Creation flow:
user account + org member + space members + employee record.
BYOA auto-generates scoped API key. Role templates for PM,
Engineering Lead, EA. Self-hosted gate blocks non-BYOA creation."
```

---

### Task 6: Agent Employee Workers

**Files:**
- Create: `apps/api/src/workers/handlers/agent-employee-message.ts`
- Create: `apps/api/src/workers/handlers/agent-employee-task.ts`
- Create: `apps/api/src/workers/handlers/agent-daily-reset.ts`
- Modify: `apps/api/src/workers/index.ts`

- [ ] **Step 1: Create agent-employee-message.ts**

```typescript
import { eq, and, desc } from 'drizzle-orm';
import { db } from '@deft/db';
import { agentEmployees, users, messages, spaces, spaceMembers, orgs } from '@deft/db/schema';
import { runAgentQuery } from '../../lib/agent-runner.js';
import { createId } from '@paralleldrive/cuid2';

export async function handleAgentEmployeeMessage(data: {
  messageId: string;
  spaceId: string;
  orgId: string;
  employeeId: string;
  isDM: boolean;
}) {
  const { messageId, spaceId, orgId, employeeId, isDM } = data;

  // 1. Load employee
  const emp = await db.select().from(agentEmployees)
    .where(and(eq(agentEmployees.id, employeeId), eq(agentEmployees.is_active, true)))
    .limit(1);
  if (!emp[0]) return;

  // 2. Check daily action limit (read is free, but check anyway for safety)
  // Action counting happens inside agent-runner during tool execution

  // 3. Load conversation history
  const historyLimit = isDM ? 20 : 10;
  const recentMessages = await db.select().from(messages)
    .where(eq(messages.space_id, spaceId))
    .orderBy(desc(messages.created_at))
    .limit(historyLimit);

  const history = recentMessages.reverse().map(m => ({
    role: m.user_id === emp[0].user_id ? 'assistant' as const : 'user' as const,
    content: m.content,
  }));

  // 4. Load org name
  const org = await db.select().from(orgs).where(eq(orgs.id, orgId)).limit(1);

  // 5. Build augmented system prompt with org chart context
  const orgMembers = await db.query.orgMembers.findMany({
    where: eq(db.query.orgMembers._.org_id, orgId),
    with: { user: true },
  });
  // Fallback if query builder not available — use raw org name
  const orgName = org[0]?.name || 'Unknown';

  const augmentedPrompt = `${emp[0].system_prompt}

## Your Identity
You are ${emp[0].name}, a ${emp[0].role.replace(/_/g, ' ')} at ${orgName}.
${emp[0].expertise_description ? `Your expertise: ${emp[0].expertise_description}` : ''}

## Communication Guidelines
- ${isDM ? 'In DMs: be thorough, provide detailed analysis.' : 'In channels: be concise, conversational. Respond in threads.'}
- When assigned tasks: act autonomously within your scope. Ask questions if unclear.
- Always identify yourself. Never impersonate humans.
- Daily action budget: ${emp[0].max_daily_actions - emp[0].daily_action_count}/${emp[0].max_daily_actions} remaining`;

  // 6. Run agent
  const result = await runAgentQuery({
    content: recentMessages[recentMessages.length - 1]?.content || '',
    orgId,
    userId: emp[0].user_id,
    orgName,
    conversationHistory: history.slice(0, -1),  // exclude the triggering message
    mode: 'background',
    systemPromptOverride: augmentedPrompt,
  });

  // 7. Post reply as message in the space
  if (result.text) {
    const replyId = createId();
    await db.insert(messages).values({
      id: replyId,
      org_id: orgId,
      space_id: spaceId,
      user_id: emp[0].user_id,
      content: result.text,
      metadata: {
        agent_employee_id: employeeId,
        citations: result.citations,
        tool_calls: [],  // simplified for now
        model: 'claude-sonnet-4-20250514',
      },
    });

    // Broadcast via socket.io
    const io = (globalThis as any).__socketIO;
    if (io) {
      io.to(`space:${spaceId}`).emit('message:new', {
        id: replyId,
        space_id: spaceId,
        user_id: emp[0].user_id,
        content: result.text,
        created_at: new Date().toISOString(),
        metadata: { agent_employee_id: employeeId },
      });
    }
  }
}
```

- [ ] **Step 2: Create agent-employee-task.ts**

```typescript
import { eq, and } from 'drizzle-orm';
import { db } from '@deft/db';
import { agentEmployees, tasks, taskActivity, orgs, users } from '@deft/db/schema';
import { runAgentQuery } from '../../lib/agent-runner.js';
import { createId } from '@paralleldrive/cuid2';

export async function handleAgentEmployeeTask(data: {
  taskId: string;
  orgId: string;
  employeeId: string;
  assignedBy: string;
}) {
  const { taskId, orgId, employeeId, assignedBy } = data;

  // 1. Load employee and task
  const emp = await db.select().from(agentEmployees)
    .where(and(eq(agentEmployees.id, employeeId), eq(agentEmployees.is_active, true)))
    .limit(1);
  if (!emp[0]) return;

  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task[0]) return;

  const org = await db.select().from(orgs).where(eq(orgs.id, orgId)).limit(1);
  const orgName = org[0]?.name || 'Unknown';

  // 2. Build task-focused prompt
  const taskPrompt = `You have been assigned a task. Act like a skilled human employee.

## Task Details
- ID: ${task[0].identifier || taskId}
- Title: ${task[0].title}
- Description: ${task[0].description || 'No description provided'}
- Priority: ${task[0].priority}
- Status: ${task[0].status}

## Instructions
1. Read and understand the task
2. If anything is unclear, post a comment asking the person who assigned you (${assignedBy}) for clarification
3. Use your tools to gather information and complete the work
4. Post your results and findings as task comments
5. When done, update the task status to 'in_review'
6. DM the assigner to let them know the task is complete`;

  const augmentedPrompt = `${emp[0].system_prompt}\n\n${taskPrompt}`;

  // 3. Run agent
  const result = await runAgentQuery({
    content: `Work on task: ${task[0].title}. ${task[0].description || ''}`,
    orgId,
    userId: emp[0].user_id,
    orgName,
    mode: 'background',
    systemPromptOverride: augmentedPrompt,
  });

  // 4. Post results as task comment
  if (result.text) {
    await db.insert(taskActivity).values({
      id: createId(),
      task_id: taskId,
      user_id: emp[0].user_id,
      type: 'comment',
      content: result.text,
    });
  }

  // 5. Update task status to in_review
  await db.update(tasks).set({ status: 'in_review' }).where(eq(tasks.id, taskId));

  // 6. Log activity
  await db.insert(taskActivity).values({
    id: createId(),
    task_id: taskId,
    user_id: emp[0].user_id,
    type: 'status_change',
    content: `Status changed from ${task[0].status} to in_review by ${emp[0].name}`,
  });
}
```

- [ ] **Step 3: Create agent-daily-reset.ts**

```typescript
import { db } from '@deft/db';
import { agentEmployees } from '@deft/db/schema';

export async function handleAgentDailyReset() {
  await db.update(agentEmployees).set({
    daily_action_count: 0,
    daily_action_reset_at: new Date(),
  });
}
```

- [ ] **Step 4: Register new workers in workers/index.ts**

In the `getAgentJobHandler` switch statement, add:

```typescript
case 'agent-employee-message': {
  const mod = await import('./handlers/agent-employee-message.js');
  return mod.handleAgentEmployeeMessage;
}
case 'agent-employee-task': {
  const mod = await import('./handlers/agent-employee-task.js');
  return mod.handleAgentEmployeeTask;
}
```

In the `getScheduledJobHandler` switch statement, add:

```typescript
case 'agent-daily-reset': {
  const mod = await import('./handlers/agent-daily-reset.js');
  return mod.handleAgentDailyReset;
}
```

In the CRON_DELAYS object, add:

```typescript
'agent-daily-reset': 24 * 60 * 60 * 1000,  // 24 hours
```

In the CRON_KEYS object, add:

```typescript
'agent-daily-reset': 'agent-daily-reset',
```

- [ ] **Step 5: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/workers/handlers/agent-employee-message.ts apps/api/src/workers/handlers/agent-employee-task.ts apps/api/src/workers/handlers/agent-daily-reset.ts apps/api/src/workers/index.ts
git commit -m "feat(workers): add agent employee message, task, and daily reset handlers

agent-employee-message: handles DMs and @mentions, loads context,
runs agent-runner with employee prompt, posts reply in space.
agent-employee-task: reads task, runs agent, posts comments,
moves to review, notifies assigner.
agent-daily-reset: resets daily_action_count for all employees."
```

---

### Task 7: Agent Employee UI — Sidebar, Settings Nav, @mention

**Files:**
- Modify: `apps/web/src/app/(app)/settings/page.tsx`
- Modify: `apps/web/src/components/sidebar.tsx`
- Modify: `apps/web/src/app/(app)/agent/page.tsx`

- [ ] **Step 1: Add new settings nav links**

In `apps/web/src/app/(app)/settings/page.tsx`, add to the `settingsSections` array (around line 10-15):

```typescript
{ name: 'Agent Employees', href: '/settings/agent-employees' },
{ name: 'MCP Connections', href: '/settings/integrations' },
{ name: 'API Access', href: '/settings/api-access' },
```

- [ ] **Step 2: Add agent employees to sidebar DM section**

In `apps/web/src/components/sidebar.tsx`, after the existing DM list mapping (around line 258), add an agent employees section. Fetch agent employees from the API and render them with a bot badge:

```typescript
{/* Agent Employees */}
{agentEmployees.filter(e => e.is_active).map((employee) => (
  <button
    key={employee.id}
    onClick={() => openAgentDM(employee)}
    className="w-full text-left px-2 flex items-center gap-2"
    style={{
      height: '32px',
      background: 'transparent',
      borderRadius: '6px',
    }}
  >
    <div style={{
      width: 20, height: 20, borderRadius: '50%',
      background: 'var(--accent)', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      fontSize: '10px', color: 'white', position: 'relative',
    }}>
      {employee.name[0]}
      <div style={{
        position: 'absolute', bottom: -1, right: -1,
        width: 8, height: 8, borderRadius: '50%',
        background: employee.is_active ? '#22c55e' : '#6b7280',
        border: '1.5px solid var(--bg)',
      }} />
    </div>
    <span style={{ fontSize: '13px', color: 'var(--foreground)', flex: 1 }}>
      {employee.name}
    </span>
    <span style={{ fontSize: '9px', color: 'var(--muted)', background: 'var(--surface-container)', padding: '1px 4px', borderRadius: '3px' }}>
      AI
    </span>
  </button>
))}
```

Add a `useEffect` to fetch agent employees from `/api/agent-employees` and store in state.

- [ ] **Step 3: Add Defty/employee tabs to agent page**

In `apps/web/src/app/(app)/agent/page.tsx`, add a tab bar above the conversation area:

```typescript
const [activeTab, setActiveTab] = useState<'defty' | string>('defty');

// In the render, before the conversation list:
<div style={{ display: 'flex', gap: '4px', padding: '8px', borderBottom: '1px solid var(--border)' }}>
  <button
    onClick={() => setActiveTab('defty')}
    style={{
      padding: '4px 12px', borderRadius: '6px', fontSize: '13px',
      background: activeTab === 'defty' ? 'var(--accent)' : 'transparent',
      color: activeTab === 'defty' ? 'white' : 'var(--muted)',
    }}
  >
    Defty
  </button>
  {agentEmployees.map(emp => (
    <button
      key={emp.id}
      onClick={() => setActiveTab(emp.id)}
      style={{
        padding: '4px 12px', borderRadius: '6px', fontSize: '13px',
        background: activeTab === emp.id ? 'var(--accent)' : 'transparent',
        color: activeTab === emp.id ? 'white' : 'var(--muted)',
      }}
    >
      {emp.name}
    </button>
  ))}
</div>
```

When `activeTab === 'defty'`, show existing agent conversations. When `activeTab === employeeId`, show the DM space conversation with that employee rendered with rich agent UI (citations from `messages.metadata`).

- [ ] **Step 4: Typecheck and build**

Run: `cd apps/web && pnpm typecheck`
Run: `cd apps/web && pnpm build`
Expected: Both pass

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/(app)/settings/page.tsx apps/web/src/components/sidebar.tsx apps/web/src/app/(app)/agent/page.tsx
git commit -m "feat(ui): add agent employees to sidebar, settings nav, and agent page tabs

Agent employees appear in sidebar DM section with AI badge.
Settings nav links for Agent Employees, MCP Connections, API Access.
Agent page has Defty/employee tabs for switching contexts."
```

---

### Task 8: Agent Employee Settings UI — List + Wizard

**Files:**
- Create: `apps/web/src/app/(app)/settings/agent-employees/page.tsx`
- Create: `apps/web/src/app/(app)/settings/agent-employees/create/page.tsx`

- [ ] **Step 1: Create employee list page**

Create `apps/web/src/app/(app)/settings/agent-employees/page.tsx` with:

- Fetch employees from `GET /api/agent-employees`
- Table/list view: name, role, status (active/paused), daily actions used, last active
- Toggle switch for pause/resume (calls `/pause` or `/resume`)
- Delete button with confirmation
- "Create Agent Employee" button → navigates to `/settings/agent-employees/create`
- If self-hosted: show "Connect External Agent" instead

- [ ] **Step 2: Create agent builder wizard page**

Create `apps/web/src/app/(app)/settings/agent-employees/create/page.tsx` with a multi-step wizard:

**Step 1 (Identity — required):** Name input, role dropdown (PM/Engineering Lead/EA/Custom), avatar picker (8 preset colored circles with initials)

**Step 2 (Instructions — required):** System prompt textarea (pre-filled from template), expertise description input

**Step 3+ (optional):** Tools, spaces, triggers, limits — each as expandable sections with "Configure later" option

Submit calls `POST /api/agent-employees` with collected fields, redirects to employee list on success.

Show the API key in a modal if BYOA was selected (one-time display).

- [ ] **Step 3: Typecheck and build**

Run: `cd apps/web && pnpm typecheck`
Run: `cd apps/web && pnpm build`
Expected: Both pass

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/(app)/settings/agent-employees/
git commit -m "feat(ui): add agent employee list and builder wizard

List page with status toggles, delete, action counts.
Wizard with minimal 2-step creation (identity + instructions),
optional tools/spaces/triggers/limits configuration.
Self-hosted gate shows BYOA setup only."
```

---

### Task 9: MCP Connections Settings UI

**Files:**
- Create: `apps/web/src/app/(app)/settings/integrations/page.tsx`
- Create: `apps/web/src/components/mcp-connection-form.tsx`

- [ ] **Step 1: Create MCP connections page**

Create the integrations page showing:
- List of connected MCP servers with status (green/red/grey dot), tool count, last connected
- "Add MCP Server" button → opens form modal
- Guided setup buttons for "Zapier MCP" and "n8n" (pre-fill URL patterns)
- Per-connection: expand to see tool list with enable/disable toggles and trust tier dropdowns
- Test Connection button, Refresh Tools button, Delete button

- [ ] **Step 2: Create mcp-connection-form component**

Form component with fields:
- Name, transport type (radio), server URL or stdio command/args, auth type, auth config
- Test Connection button that calls `POST /api/mcp-connections/:id/test`
- Shows result (success + tool count, or error message)

- [ ] **Step 3: Typecheck and build**

Run: `cd apps/web && pnpm typecheck`
Run: `cd apps/web && pnpm build`
Expected: Both pass

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/(app)/settings/integrations/ apps/web/src/components/mcp-connection-form.tsx
git commit -m "feat(ui): add MCP connections settings page with tool management

Connection list with status indicators, guided Zapier/n8n setup,
per-tool enable/disable and trust tier overrides, test connection."
```

---

### Task 10: Defty Superintendent Tools

**Files:**
- Modify: `apps/api/src/lib/agent-tools.ts`
- Modify: `apps/api/src/lib/agent-context.ts`
- Modify: `apps/api/src/routes/agent.ts`

- [ ] **Step 1: Add SUPERINTENDENT_TOOLS array to agent-tools.ts**

After the MANAGER_TOOLS array (around line 526), add:

```typescript
export const SUPERINTENDENT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_agent_employees',
    description: 'List all agent employees in the organization with their status, role, daily action usage, and last active timestamp.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status_filter: { type: 'string', enum: ['active', 'paused', 'all'], description: 'Filter by status. Default: all' },
      },
    },
  },
  {
    name: 'manage_agent_employee',
    description: 'Create, update, pause, resume, or delete an agent employee. REQUIRES USER APPROVAL. Use action parameter to specify operation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'pause', 'resume', 'delete'], description: 'Operation to perform' },
        employee_id: { type: 'string', description: 'Employee ID (required for update/pause/resume/delete)' },
        name: { type: 'string', description: 'Employee name (required for create)' },
        role: { type: 'string', enum: ['project_manager', 'engineering_lead', 'executive_assistant', 'custom'], description: 'Role (required for create)' },
        system_prompt: { type: 'string', description: 'System prompt (required for create)' },
        trust_level: { type: 'string', enum: ['conservative', 'standard', 'autonomous'] },
        max_daily_actions: { type: 'number' },
      },
      required: ['action'],
    },
  },
  {
    name: 'get_agent_activity',
    description: 'Get recent actions performed by agent employees. Returns action type, target, status, and timestamp.',
    input_schema: {
      type: 'object' as const,
      properties: {
        employee_id: { type: 'string', description: 'Filter by specific employee. Omit for all.' },
        limit: { type: 'number', description: 'Number of actions to return. Default: 20' },
      },
    },
  },
  {
    name: 'get_agent_economics',
    description: 'Get token spend, action counts, and credit usage per agent employee.',
    input_schema: {
      type: 'object' as const,
      properties: {
        employee_id: { type: 'string', description: 'Filter by specific employee. Omit for all.' },
      },
    },
  },
  {
    name: 'manage_mcp_connection',
    description: 'Add, remove, test, or reconfigure MCP server connections. REQUIRES USER APPROVAL.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['add', 'remove', 'test', 'update'], description: 'Operation to perform' },
        connection_id: { type: 'string', description: 'Connection ID (required for remove/test/update)' },
        name: { type: 'string', description: 'Connection name (required for add)' },
        server_url: { type: 'string', description: 'Server URL (required for add)' },
        transport: { type: 'string', enum: ['sse', 'streamable-http', 'stdio'] },
        auth_type: { type: 'string', enum: ['api_key', 'oauth', 'none'] },
      },
      required: ['action'],
    },
  },
  {
    name: 'manage_triggers',
    description: 'Create, update, or disable triggers for an agent employee. Triggers fire on events like task_overdue, cron schedule, etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'disable', 'enable', 'delete', 'list'], description: 'Operation to perform' },
        employee_id: { type: 'string', description: 'Employee to manage triggers for' },
        trigger_id: { type: 'string', description: 'Trigger ID (for update/disable/enable/delete)' },
        event_type: { type: 'string', description: 'Event type (for create): task_overdue, task_stalled, cron_schedule, pr_merged, message_contains' },
        condition: { type: 'object', description: 'Condition filter (for create/update)' },
        schedule: { type: 'string', description: 'Cron expression (for cron_schedule events)' },
      },
      required: ['action'],
    },
  },
];

export const SUPERINTENDENT_ACTION_TOOLS = new Set([
  'manage_agent_employee',
  'manage_mcp_connection',
  'manage_triggers',
]);
```

- [ ] **Step 2: Add superintendent tool execution in agent-context.ts**

Add cases for the superintendent tools in `executeToolCall`. These call the same API logic as the CRUD routes:

```typescript
case 'list_agent_employees': {
  const employees = await db.select().from(agentEmployees)
    .where(eq(agentEmployees.org_id, orgId));
  const filtered = params.status_filter === 'active'
    ? employees.filter(e => e.is_active)
    : params.status_filter === 'paused'
    ? employees.filter(e => !e.is_active)
    : employees;
  return {
    result: filtered.map(e => ({
      name: e.name, role: e.role, slug: e.slug,
      status: e.is_active ? 'active' : 'paused',
      daily_actions: `${e.daily_action_count}/${e.max_daily_actions}`,
      trust_level: e.trust_level,
      is_byoa: e.is_byoa,
    })),
    citations: [],
  };
}

case 'get_agent_activity': {
  const query = db.select().from(agentActions)
    .where(eq(agentActions.org_id, orgId))
    .orderBy(desc(agentActions.created_at))
    .limit(params.limit || 20);
  // Filter by employee if specified
  const actions = params.employee_id
    ? await db.select().from(agentActions)
        .where(and(eq(agentActions.org_id, orgId), eq(agentActions.agent_employee_id, params.employee_id)))
        .orderBy(desc(agentActions.created_at)).limit(params.limit || 20)
    : await query;
  return {
    result: actions.map(a => ({
      action: a.action, params: a.params, status: a.approval_status,
      employee_id: a.agent_employee_id, source: a.source,
      created_at: a.created_at,
    })),
    citations: [],
  };
}

case 'get_agent_economics': {
  const employees = params.employee_id
    ? await db.select().from(agentEmployees).where(eq(agentEmployees.id, params.employee_id))
    : await db.select().from(agentEmployees).where(eq(agentEmployees.org_id, orgId));
  return {
    result: employees.map(e => ({
      name: e.name, role: e.role,
      daily_actions_used: e.daily_action_count,
      daily_actions_limit: e.max_daily_actions,
      is_active: e.is_active,
    })),
    citations: [],
  };
}
```

For write superintendent tools (`manage_agent_employee`, `manage_mcp_connection`, `manage_triggers`), these flow through the approval pipeline like any other action tool — they'll appear as pending actions for the user to approve.

- [ ] **Step 3: Include SUPERINTENDENT_TOOLS in agent.ts for Defty conversations only**

In `apps/api/src/routes/agent.ts`, when building the tools array, check if this is a Defty conversation (not an employee):

```typescript
// After existing tool building (line ~190):
// Superintendent tools — only for Defty, not employees
if (!agentEmployeeId) {
  tools = [...tools, ...SUPERINTENDENT_TOOLS];
  SUPERINTENDENT_ACTION_TOOLS.forEach(t => allActionTools.add(t));
}
```

Add import:

```typescript
import { SUPERINTENDENT_TOOLS, SUPERINTENDENT_ACTION_TOOLS } from '../lib/agent-tools.js';
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/agent-tools.ts apps/api/src/lib/agent-context.ts apps/api/src/routes/agent.ts
git commit -m "feat(agent): add Defty superintendent tools for platform management

6 new tools: list/manage agent employees, get activity/economics,
manage MCP connections, manage triggers. Only available to Defty
(not employees). Write tools flow through approval pipeline."
```

---

### Task 11: Multi-Step Plans — Engine

**Files:**
- Create: `apps/api/src/lib/agent-plans.ts`
- Create: `apps/api/src/routes/agent-plans.ts`
- Create: `apps/api/src/workers/handlers/plan-executor.ts`
- Modify: `apps/api/src/lib/agent-tools.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/workers/index.ts`

- [ ] **Step 1: Add create_plan tool to agent-tools.ts**

Add to AGENT_TOOLS array (this is a system tool, always included):

```typescript
{
  name: 'create_plan',
  description: 'Create a multi-step execution plan for complex requests. Use this when the task requires 3+ sequential operations, has write actions that need approval, or involves conditional logic. The plan will be shown to the user for approval before execution.',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'Short title for the plan' },
      description: { type: 'string', description: 'What this plan accomplishes' },
      steps: {
        type: 'array',
        description: 'Ordered list of steps to execute',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique step identifier' },
            description: { type: 'string', description: 'What this step does' },
            tool: { type: 'string', description: 'Tool to call' },
            params: { type: 'object', description: 'Tool parameters. Can use $step.{id}.result.{field} to reference prior results' },
            depends_on: { type: 'array', items: { type: 'string' }, description: 'Step IDs this depends on' },
            condition: { type: 'object', description: 'Optional condition for execution' },
          },
          required: ['id', 'description', 'tool', 'params'],
        },
      },
    },
    required: ['title', 'steps'],
  },
},
```

- [ ] **Step 2: Create agent-plans.ts — plan execution engine**

```typescript
import { eq } from 'drizzle-orm';
import { db } from '@deft/db';
import { agentPlans, agentEmployees } from '@deft/db/schema';
import { executeToolCall } from './agent-context.js';
import { shouldAutoExecute, getApprovalTier } from './agent-approval.js';
import { executeActionDirect } from './agent-actions.js';
import { ACTION_TOOLS } from './agent-tools.js';
import { runAgentQuery } from './agent-runner.js';

interface PlanStep {
  id: string;
  description: string;
  tool: string;
  params: Record<string, any>;
  is_write?: boolean;
  depends_on?: string[];
  condition?: {
    step_id: string;
    field: string;
    operator: 'eq' | 'neq' | 'gt' | 'lt' | 'contains' | 'empty' | 'not_empty';
    value: any;
    on_false: 'skip' | 'alternative';
    alternative_tool?: string;
    alternative_params?: Record<string, any>;
  };
  status: string;
  result?: any;
  error?: string;
  started_at?: string;
  completed_at?: string;
}

function resolveStepReferences(params: Record<string, any>, context: Record<string, any>): Record<string, any> {
  const resolved: Record<string, any> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.startsWith('$step.')) {
      // Parse $step.{stepId}.result.{fieldPath}
      const parts = value.replace('$step.', '').split('.');
      const stepId = parts[0];
      const fieldPath = parts.slice(1);
      let ref = context[stepId];
      for (const p of fieldPath) {
        ref = ref?.[p];
      }
      resolved[key] = ref;
    } else if (typeof value === 'object' && value !== null) {
      resolved[key] = resolveStepReferences(value, context);
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

function evaluateCondition(condition: PlanStep['condition'], context: Record<string, any>): boolean {
  if (!condition) return true;
  const stepResult = context[condition.step_id];
  if (!stepResult) return false;

  const parts = condition.field.split('.');
  let value = stepResult;
  for (const p of parts) value = value?.[p];

  switch (condition.operator) {
    case 'eq': return value === condition.value;
    case 'neq': return value !== condition.value;
    case 'gt': return value > condition.value;
    case 'lt': return value < condition.value;
    case 'contains': return String(value).includes(String(condition.value));
    case 'empty': return !value || (Array.isArray(value) && value.length === 0);
    case 'not_empty': return !!value && (!Array.isArray(value) || value.length > 0);
    default: return true;
  }
}

export async function executePlan(
  planId: string,
  orgId: string,
  userId: string,
  onEvent?: (event: any) => void,
): Promise<void> {
  const plan = await db.select().from(agentPlans).where(eq(agentPlans.id, planId)).limit(1);
  if (!plan[0]) throw new Error('Plan not found');

  const steps = plan[0].steps as PlanStep[];
  const context: Record<string, any> = (plan[0].context as Record<string, any>) || {};
  let trustLevel: 'conservative' | 'standard' | 'autonomous' = 'conservative';

  // Load trust level from employee or org
  if (plan[0].agent_employee_id) {
    const emp = await db.select().from(agentEmployees).where(eq(agentEmployees.id, plan[0].agent_employee_id)).limit(1);
    if (emp[0]) trustLevel = emp[0].trust_level;
  }

  // Update plan status to executing
  await db.update(agentPlans).set({ status: 'executing' }).where(eq(agentPlans.id, planId));

  const pendingWrites: PlanStep[] = [];

  for (let i = plan[0].current_step; i < steps.length; i++) {
    const step = steps[i];

    // Check if plan was paused externally
    const current = await db.select().from(agentPlans).where(eq(agentPlans.id, planId)).limit(1);
    if (current[0]?.status === 'paused') {
      onEvent?.({ type: 'plan_paused', planId, reason: 'Paused by user' });
      return;
    }

    // Check dependencies
    if (step.depends_on?.length) {
      const allDone = step.depends_on.every(depId => {
        const depStep = steps.find(s => s.id === depId);
        return depStep?.status === 'completed';
      });
      if (!allDone) {
        step.status = 'skipped';
        step.error = 'Dependencies not met';
        continue;
      }
    }

    // Evaluate condition
    if (step.condition && !evaluateCondition(step.condition, context)) {
      if (step.condition.on_false === 'skip') {
        step.status = 'skipped';
        onEvent?.({ type: 'plan_step_skipped', planId, stepId: step.id, reason: 'Condition not met' });
        continue;
      }
      // Alternative execution
      if (step.condition.alternative_tool) {
        step.tool = step.condition.alternative_tool;
        step.params = step.condition.alternative_params || {};
      }
    }

    // Execute step
    step.status = 'running';
    step.started_at = new Date().toISOString();
    onEvent?.({ type: 'plan_step_started', planId, stepId: step.id, description: step.description });

    // Resolve $step references
    const resolvedParams = resolveStepReferences(step.params, context);

    const isWrite = ACTION_TOOLS.has(step.tool) || step.tool.startsWith('mcp__');
    const isDepOfLater = steps.slice(i + 1).some(s => s.depends_on?.includes(step.id));

    try {
      if (isWrite) {
        if (shouldAutoExecute(step.tool, trustLevel)) {
          // Auto-execute
          const result = await executeActionDirect(
            step.tool, resolvedParams, orgId, userId, null,
            getApprovalTier(step.tool),
            { planId, planStepId: step.id, agentEmployeeId: plan[0].agent_employee_id || undefined },
          );
          step.result = result;
          step.status = 'completed';
          context[step.id] = result;
        } else if (isDepOfLater) {
          // Needs approval AND is a dependency — pause plan
          step.status = 'waiting_approval';
          await db.update(agentPlans).set({
            status: 'paused',
            current_step: i,
            steps: steps as any,
            context: context as any,
          }).where(eq(agentPlans.id, planId));
          onEvent?.({ type: 'plan_step_waiting', planId, stepId: step.id, reason: 'approval_required' });
          return;
        } else {
          // Needs approval but NOT a dependency — batch it
          step.status = 'waiting_approval';
          pendingWrites.push(step);
        }
      } else {
        // Read-only — execute immediately
        const { result } = await executeToolCall(step.tool, resolvedParams, orgId, userId);
        step.result = result;
        step.status = 'completed';
        context[step.id] = result;
      }

      step.completed_at = new Date().toISOString();
      onEvent?.({ type: 'plan_step_completed', planId, stepId: step.id, result: step.result });

    } catch (err: any) {
      step.status = 'failed';
      step.error = err.message;
      onEvent?.({ type: 'plan_step_failed', planId, stepId: step.id, error: err.message });

      // Try alternative reasoning
      try {
        const org = await db.query.orgs.findFirst({ where: eq(db.query.orgs._.id, orgId) });
        const altResult = await runAgentQuery({
          content: `Plan step failed. Step: "${step.description}" using tool "${step.tool}". Error: "${err.message}". Plan goal: "${plan[0].title}". Completed steps: ${JSON.stringify(context)}. Suggest an alternative step that achieves the same goal, or say ESCALATE if the alternative requires fundamentally different actions.`,
          orgId,
          userId,
          orgName: org?.name || '',
          mode: 'background',
        });

        if (altResult.text.includes('ESCALATE')) {
          await db.update(agentPlans).set({
            status: 'paused', current_step: i, steps: steps as any, context: context as any,
            error: `Step "${step.description}" failed. Agent reasoning: ${altResult.text}`,
          }).where(eq(agentPlans.id, planId));
          onEvent?.({ type: 'plan_paused', planId, reason: `Step failed, agent recommends escalation: ${altResult.text}` });
          return;
        }

        onEvent?.({ type: 'plan_alternative', planId, stepId: step.id, original: step.description, alternative: altResult.text, reasoning: altResult.text });
      } catch {
        // Alternative reasoning failed — pause plan
        await db.update(agentPlans).set({
          status: 'paused', current_step: i, steps: steps as any, context: context as any,
        }).where(eq(agentPlans.id, planId));
        return;
      }
    }

    // Update progress
    await db.update(agentPlans).set({
      current_step: i + 1,
      steps: steps as any,
      context: context as any,
    }).where(eq(agentPlans.id, planId));

    // Increment daily action count
    if (plan[0].agent_employee_id) {
      await db.execute(
        `UPDATE agent_employees SET daily_action_count = daily_action_count + 1 WHERE id = '${plan[0].agent_employee_id}' AND daily_action_count < max_daily_actions`
      );
    }
  }

  // Plan complete
  await db.update(agentPlans).set({
    status: 'completed',
    steps: steps as any,
    context: context as any,
  }).where(eq(agentPlans.id, planId));

  onEvent?.({ type: 'plan_completed', planId, summary: `Plan "${plan[0].title}" completed. ${steps.filter(s => s.status === 'completed').length}/${steps.length} steps succeeded.` });
}
```

- [ ] **Step 3: Create agent-plans.ts routes**

```typescript
import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '@deft/db';
import { agentPlans } from '@deft/db/schema';
import { createId } from '@paralleldrive/cuid2';
import { executePlan } from '../lib/agent-plans.js';
import { enqueueJob } from '../lib/queues.js';

export const agentPlanRoutes = new Hono()

  .get('/', async (c) => {
    const orgId = c.get('orgId');
    const plans = await db.select().from(agentPlans)
      .where(eq(agentPlans.org_id, orgId))
      .orderBy(desc(agentPlans.created_at))
      .limit(50);
    return c.json(plans);
  })

  .get('/:id', async (c) => {
    const orgId = c.get('orgId');
    const id = c.req.param('id');
    const plan = await db.select().from(agentPlans)
      .where(and(eq(agentPlans.id, id), eq(agentPlans.org_id, orgId)))
      .limit(1);
    if (!plan[0]) return c.json({ error: 'Not found' }, 404);
    return c.json(plan[0]);
  })

  .post('/', async (c) => {
    const orgId = c.get('orgId');
    const userId = c.get('userId');
    const body = await c.req.json();
    const id = createId();

    const [plan] = await db.insert(agentPlans).values({
      id,
      org_id: orgId,
      user_id: userId,
      agent_employee_id: body.agent_employee_id,
      conversation_id: body.conversation_id,
      title: body.title,
      description: body.description,
      steps: body.steps,
    }).returning();

    return c.json(plan, 201);
  })

  .put('/:id', async (c) => {
    const orgId = c.get('orgId');
    const id = c.req.param('id');
    const body = await c.req.json();

    // Can only edit draft or paused plans
    const existing = await db.select().from(agentPlans)
      .where(and(eq(agentPlans.id, id), eq(agentPlans.org_id, orgId)))
      .limit(1);
    if (!existing[0]) return c.json({ error: 'Not found' }, 404);
    if (!['draft', 'paused'].includes(existing[0].status)) {
      return c.json({ error: 'Can only edit draft or paused plans' }, 400);
    }

    const [updated] = await db.update(agentPlans).set({
      title: body.title,
      description: body.description,
      steps: body.steps,
    }).where(eq(agentPlans.id, id)).returning();

    return c.json(updated);
  })

  .post('/:id/approve', async (c) => {
    const id = c.req.param('id');
    await db.update(agentPlans).set({ status: 'approved' }).where(eq(agentPlans.id, id));
    return c.json({ success: true });
  })

  .post('/:id/execute', async (c) => {
    const orgId = c.get('orgId');
    const userId = c.get('userId');
    const id = c.req.param('id');

    // Enqueue plan execution as a background job
    await enqueueJob('agent-jobs', 'plan-executor', { planId: id, orgId, userId });
    return c.json({ success: true, message: 'Plan execution started' });
  })

  .post('/:id/pause', async (c) => {
    const id = c.req.param('id');
    await db.update(agentPlans).set({ status: 'paused' }).where(eq(agentPlans.id, id));
    return c.json({ success: true });
  })

  .post('/:id/resume', async (c) => {
    const orgId = c.get('orgId');
    const userId = c.get('userId');
    const id = c.req.param('id');
    await db.update(agentPlans).set({ status: 'executing' }).where(eq(agentPlans.id, id));
    await enqueueJob('agent-jobs', 'plan-executor', { planId: id, orgId, userId });
    return c.json({ success: true });
  })

  .post('/:id/abort', async (c) => {
    const id = c.req.param('id');
    await db.update(agentPlans).set({ status: 'failed', error: 'Aborted by user' }).where(eq(agentPlans.id, id));
    return c.json({ success: true });
  });
```

- [ ] **Step 4: Create plan-executor worker**

```typescript
import { executePlan } from '../../lib/agent-plans.js';

export async function handlePlanExecutor(data: { planId: string; orgId: string; userId: string }) {
  await executePlan(data.planId, data.orgId, data.userId);
}
```

- [ ] **Step 5: Register plan-executor worker and mount routes**

In `apps/api/src/workers/index.ts`, add to `getAgentJobHandler`:

```typescript
case 'plan-executor': {
  const mod = await import('./handlers/plan-executor.js');
  return mod.handlePlanExecutor;
}
```

In `apps/api/src/index.ts`:

```typescript
import { agentPlanRoutes } from './routes/agent-plans.js';
app.route('/api/agent-plans', agentPlanRoutes);
```

- [ ] **Step 6: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/agent-plans.ts apps/api/src/routes/agent-plans.ts apps/api/src/workers/handlers/plan-executor.ts apps/api/src/lib/agent-tools.ts apps/api/src/workers/index.ts apps/api/src/index.ts
git commit -m "feat(plans): add multi-step plan engine with conditional branching

Plan execution engine with: step result referencing ($step.id.result),
conditional branching (skip/alternative), dependency-aware approval
(pause if write is a dependency, batch otherwise), alternative
reasoning on failure with escalation. create_plan tool added to
agent toolset. CRUD routes + plan-executor background worker."
```

---

### Task 12: Deft MCP Server + API Keys

**Files:**
- Create: `apps/api/src/routes/api-keys.ts`
- Create: `apps/api/src/routes/mcp-server.ts`
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Create api-keys.ts**

Standard CRUD for API keys with bcrypt hashing. Key is shown once on creation. Includes per-key usage stats.

```typescript
import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '@deft/db';
import { apiKeys } from '@deft/db/schema';
import { createId } from '@paralleldrive/cuid2';
import bcrypt from 'bcryptjs';

export const apiKeyRoutes = new Hono()

  .get('/', async (c) => {
    const orgId = c.get('orgId');
    const keys = await db.select({
      id: apiKeys.id, name: apiKeys.name, key_prefix: apiKeys.key_prefix,
      agent_employee_id: apiKeys.agent_employee_id, permissions: apiKeys.permissions,
      rate_limit_per_minute: apiKeys.rate_limit_per_minute,
      rate_limit_per_day: apiKeys.rate_limit_per_day,
      last_used_at: apiKeys.last_used_at, request_count: apiKeys.request_count,
      is_active: apiKeys.is_active, expires_at: apiKeys.expires_at,
      created_at: apiKeys.created_at,
    }).from(apiKeys).where(eq(apiKeys.org_id, orgId)).orderBy(desc(apiKeys.created_at));
    return c.json(keys);
  })

  .post('/', async (c) => {
    const orgId = c.get('orgId');
    const userId = c.get('userId');
    const body = await c.req.json();

    const rawKey = `deft_${createId()}`;
    const keyHash = await bcrypt.hash(rawKey, 10);

    const [key] = await db.insert(apiKeys).values({
      id: createId(),
      org_id: orgId,
      agent_employee_id: body.agent_employee_id,
      name: body.name,
      key_hash: keyHash,
      key_prefix: rawKey.substring(0, 12),
      permissions: body.permissions || [],
      rate_limit_per_minute: body.rate_limit_per_minute || 60,
      rate_limit_per_day: body.rate_limit_per_day || 10000,
      expires_at: body.expires_at,
      created_by: userId,
    }).returning();

    return c.json({ ...key, key: rawKey }, 201);  // Return raw key ONCE
  })

  .delete('/:id', async (c) => {
    const orgId = c.get('orgId');
    const id = c.req.param('id');
    await db.delete(apiKeys).where(and(eq(apiKeys.id, id), eq(apiKeys.org_id, orgId)));
    return c.json({ success: true });
  })

  .put('/:id', async (c) => {
    const orgId = c.get('orgId');
    const id = c.req.param('id');
    const body = await c.req.json();
    const [updated] = await db.update(apiKeys).set({
      name: body.name, permissions: body.permissions,
      rate_limit_per_minute: body.rate_limit_per_minute,
      rate_limit_per_day: body.rate_limit_per_day,
      is_active: body.is_active, expires_at: body.expires_at,
    }).where(and(eq(apiKeys.id, id), eq(apiKeys.org_id, orgId))).returning();
    if (!updated) return c.json({ error: 'Not found' }, 404);
    return c.json(updated);
  });
```

- [ ] **Step 2: Create mcp-server.ts — Deft MCP Server endpoint**

This implements the streamable HTTP MCP server. External agents connect here with API keys.

```typescript
import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { db } from '@deft/db';
import { apiKeys, agentEmployees, agentActions, orgs } from '@deft/db/schema';
import { executeToolCall } from '../lib/agent-context.js';
import { shouldAutoExecute, getApprovalTier } from '../lib/agent-approval.js';
import { executeActionDirect } from '../lib/agent-actions.js';
import { ACTION_TOOLS } from '../lib/agent-tools.js';
import { createId } from '@paralleldrive/cuid2';
import bcrypt from 'bcryptjs';

// Rate limit tracking (in-memory)
const rateLimits = new Map<string, { minute: number; minuteStart: number; day: number; dayStart: number }>();

// Tools exposed via MCP server
const EXPOSED_READ_TOOLS = [
  'search_tasks', 'get_task_detail', 'search_messages', 'search_knowledge',
  'wiki_search', 'wiki_read', 'get_project_progress', 'get_team_workload',
];
const EXPOSED_WRITE_TOOLS = [
  'create_task', 'update_task_status', 'assign_task', 'post_message',
  'add_knowledge', 'wiki_write',
];

async function authenticateApiKey(authorization: string | undefined) {
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice(7);
  const prefix = token.substring(0, 12);

  const keys = await db.select().from(apiKeys)
    .where(and(eq(apiKeys.key_prefix, prefix), eq(apiKeys.is_active, true)));

  for (const key of keys) {
    if (await bcrypt.compare(token, key.key_hash)) {
      // Check expiry
      if (key.expires_at && new Date(key.expires_at) < new Date()) return null;
      return key;
    }
  }
  return null;
}

function checkRateLimit(keyId: string, perMinute: number, perDay: number): boolean {
  const now = Date.now();
  let limits = rateLimits.get(keyId);
  if (!limits) {
    limits = { minute: 0, minuteStart: now, day: 0, dayStart: now };
    rateLimits.set(keyId, limits);
  }

  // Reset windows
  if (now - limits.minuteStart > 60_000) { limits.minute = 0; limits.minuteStart = now; }
  if (now - limits.dayStart > 86_400_000) { limits.day = 0; limits.dayStart = now; }

  if (limits.minute >= perMinute || limits.day >= perDay) return false;
  limits.minute++;
  limits.day++;
  return true;
}

export const mcpServerRoutes = new Hono()

  // MCP tool list (for discovery)
  .get('/tools', async (c) => {
    const key = await authenticateApiKey(c.req.header('Authorization'));
    if (!key) return c.json({ error: 'Unauthorized' }, 401);

    const allowedTools = new Set(key.permissions);
    const tools = [...EXPOSED_READ_TOOLS, ...EXPOSED_WRITE_TOOLS]
      .filter(t => allowedTools.has(`deft_${t}`) || allowedTools.size === 0)
      .map(t => ({ name: `deft_${t}`, description: `Deft workspace: ${t.replace(/_/g, ' ')}` }));

    return c.json({ tools });
  })

  // MCP tool execution
  .post('/call', async (c) => {
    const key = await authenticateApiKey(c.req.header('Authorization'));
    if (!key) return c.json({ error: 'Unauthorized' }, 401);

    // Rate limit
    if (!checkRateLimit(key.id, key.rate_limit_per_minute, key.rate_limit_per_day)) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const { tool, params } = await c.req.json();
    const toolName = tool.replace('deft_', '');

    // Check permission
    if (key.permissions.length > 0 && !key.permissions.includes(tool)) {
      return c.json({ error: 'Tool not permitted for this API key' }, 403);
    }

    // Resolve employee context
    let trustLevel: 'conservative' | 'standard' | 'autonomous' = 'conservative';
    let employeeId: string | undefined;
    if (key.agent_employee_id) {
      const emp = await db.select().from(agentEmployees).where(eq(agentEmployees.id, key.agent_employee_id)).limit(1);
      if (emp[0]) {
        trustLevel = emp[0].trust_level;
        employeeId = emp[0].id;
      }
    }

    // Get org
    const org = await db.select().from(orgs).where(eq(orgs.id, key.org_id)).limit(1);

    // Check if write action
    const isWrite = ACTION_TOOLS.has(toolName);

    if (isWrite) {
      if (shouldAutoExecute(toolName, trustLevel)) {
        const result = await executeActionDirect(
          toolName, params, key.org_id, employeeId || key.created_by, null,
          getApprovalTier(toolName),
          { agentEmployeeId: employeeId, source: 'native' },
        );
        // Update API key stats
        await db.update(apiKeys).set({ last_used_at: new Date(), request_count: key.request_count + 1 }).where(eq(apiKeys.id, key.id));
        return c.json({ result, status: 'executed' });
      } else {
        // Create pending action
        const actionId = createId();
        await db.insert(agentActions).values({
          id: actionId,
          org_id: key.org_id,
          user_id: employeeId || key.created_by,
          action: toolName,
          params: params as any,
          approval_tier: getApprovalTier(toolName),
          agent_employee_id: employeeId,
          source: 'native',
        });
        await db.update(apiKeys).set({ last_used_at: new Date(), request_count: key.request_count + 1 }).where(eq(apiKeys.id, key.id));
        return c.json({ status: 'pending_approval', action_id: actionId });
      }
    }

    // Read-only tool
    try {
      const { result, citations } = await executeToolCall(toolName, params, key.org_id, employeeId || key.created_by);
      await db.update(apiKeys).set({ last_used_at: new Date(), request_count: key.request_count + 1 }).where(eq(apiKeys.id, key.id));
      return c.json({ result, citations, status: 'executed' });
    } catch (err: any) {
      return c.json({ error: err.message, status: 'error' }, 500);
    }
  })

  // Poll action status
  .get('/actions/:id/status', async (c) => {
    const key = await authenticateApiKey(c.req.header('Authorization'));
    if (!key) return c.json({ error: 'Unauthorized' }, 401);

    const id = c.req.param('id');
    const action = await db.select().from(agentActions)
      .where(and(eq(agentActions.id, id), eq(agentActions.org_id, key.org_id)))
      .limit(1);

    if (!action[0]) return c.json({ error: 'Not found' }, 404);
    return c.json({
      status: action[0].approval_status,
      result: action[0].result,
      error: action[0].error,
    });
  });
```

- [ ] **Step 3: Mount routes**

In `apps/api/src/index.ts`:

```typescript
import { apiKeyRoutes } from './routes/api-keys.js';
import { mcpServerRoutes } from './routes/mcp-server.js';

// API keys need auth
app.route('/api/api-keys', apiKeyRoutes);

// MCP server does NOT use auth middleware — has its own API key auth
app.route('/mcp', mcpServerRoutes);
```

Note: `/mcp` routes are mounted BEFORE the `app.use('/api/*', authMiddleware)` line so they use their own auth.

- [ ] **Step 4: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/api-keys.ts apps/api/src/routes/mcp-server.ts apps/api/src/index.ts
git commit -m "feat(mcp-server): add Deft MCP server + API key management

Deft MCP server at /mcp with API key auth, rate limiting,
tool permission scoping per key. Exposes 14 native tools
(8 read, 6 write). Write actions flow through approval pipeline
using linked employee's trust level. API key CRUD with bcrypt
hashing, one-time key display on creation."
```

---

### Task 13: API Access + Dashboard Integration Settings UI

**Files:**
- Create: `apps/web/src/app/(app)/settings/api-access/page.tsx`
- Modify: `apps/web/src/app/(app)/dashboard/page.tsx`

- [ ] **Step 1: Create API access page**

Settings page showing:
- API key list (name, prefix, linked employee, last used, request count, active toggle)
- Create key modal with employee dropdown, permission checkboxes, rate limits
- Show raw key in one-time modal after creation
- Delete/revoke button

- [ ] **Step 2: Add employee filter to dashboard Agent Activity widget**

In the existing Agent Activity widget on the dashboard, add a dropdown filter:

```typescript
<select
  value={employeeFilter}
  onChange={(e) => setEmployeeFilter(e.target.value)}
  style={{ fontSize: '11px', background: 'var(--surface-container)', border: 'none', borderRadius: '4px', padding: '2px 6px', color: 'var(--muted)' }}
>
  <option value="all">All Agents</option>
  {agentEmployees.map(emp => (
    <option key={emp.id} value={emp.id}>{emp.name}</option>
  ))}
</select>
```

Filter the activity feed by `agent_employee_id` when not "all".

- [ ] **Step 3: Typecheck and build**

Run: `cd apps/web && pnpm typecheck`
Run: `cd apps/web && pnpm build`
Expected: Both pass

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/(app)/settings/api-access/ apps/web/src/app/(app)/dashboard/page.tsx
git commit -m "feat(ui): add API access settings page and dashboard employee filter

API key management with create/revoke/toggle.
Dashboard Agent Activity widget now has employee filter dropdown."
```

---

### Task 14: Plan Approval UI

**Files:**
- Create: `apps/web/src/components/plan-approval.tsx`
- Create: `apps/web/src/components/plan-progress.tsx`

- [ ] **Step 1: Create plan-approval.tsx**

Component that renders a plan card in the agent chat:
- Shows plan title and step list
- Each step shows: status icon (○ pending, ✓ completed, ✗ failed, ⏸ waiting), description, tool type badge ([read — auto] / [write — needs approval])
- Conditional steps show a "↳ Condition:" line
- Bottom buttons: [Approve & Execute] [Edit Plan] [Reject]
- Edit mode: drag-drop reorder, click to edit step, delete step, add step

- [ ] **Step 2: Create plan-progress.tsx**

Component for live plan execution progress:
- Shows steps with live status updates (checkmarks appearing as steps complete)
- Waiting approval state: shows step with [Approve] [Reject] buttons
- Paused state: shows reason + [Resume] button
- Auto-resume countdown: "Resuming in 10s..." with [Pause] button
- Failed step: shows error + alternative reasoning if available
- Completed: summary line

- [ ] **Step 3: Integrate into agent chat**

In the agent chat component, handle `plan_created` SSE event to render `PlanApproval`, and `plan_step_*` events to render `PlanProgress`.

- [ ] **Step 4: Typecheck and build**

Run: `cd apps/web && pnpm typecheck`
Run: `cd apps/web && pnpm build`
Expected: Both pass

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/plan-approval.tsx apps/web/src/components/plan-progress.tsx
git commit -m "feat(ui): add plan approval and execution progress components

Plan approval card with step list, approve/edit/reject buttons.
Plan progress with live status, approval gates, auto-resume
countdown, alternative reasoning display."
```

---

### Task 15: Self-Hosted Feature Gates

**Files:**
- Modify: various (already handled inline in previous tasks)

- [ ] **Step 1: Verify all gates are in place**

Check that these gates exist:
- `apps/api/src/routes/agent-employees.ts`: POST blocks non-BYOA when `DEFT_SELF_HOSTED=true`
- `apps/api/src/routes/agent-employees.ts`: GET `/templates` returns empty when self-hosted
- `packages/mcp/src/transports.ts`: stdio transport blocks when NOT self-hosted
- `apps/web/src/app/(app)/settings/agent-employees/page.tsx`: shows BYOA-only UI when self-hosted

- [ ] **Step 2: Add client-side env check**

In the web app, expose the self-hosted flag via API or env:

```typescript
// In a shared config or API call
export const IS_SELF_HOSTED = process.env.NEXT_PUBLIC_DEFT_SELF_HOSTED === 'true';
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: verify self-hosted feature gates for agent builder"
```

---

## Verification

After all tasks:

1. `cd packages/db && pnpm typecheck` — must pass
2. `cd packages/mcp && npx tsc --noEmit` — must pass
3. `cd apps/api && pnpm typecheck` — must pass
4. `cd apps/web && pnpm typecheck` — must pass
5. `cd apps/web && pnpm build` — must succeed

Manual verification:
- **MCP:** Add an MCP connection in Settings > Integrations, test connection, verify tools appear in agent chat
- **Agent Employee:** Create a PM agent via wizard, verify it appears in sidebar, DM it, assign it a task
- **Plans:** Ask Defty to "prepare a sprint review" — should generate a plan, approve and execute
- **Deft MCP Server:** Create API key, call `POST /mcp/call` with bearer token, verify tool execution
- **Trust levels:** Verify employee trust level governs auto-execution independently from org level
- **Daily limits:** Verify action counter increments and blocks at max
- **Self-hosted:** Set `DEFT_SELF_HOSTED=true`, verify wizard is blocked, BYOA works
