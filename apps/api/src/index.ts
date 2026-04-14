import 'dotenv/config';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { setupSocket } from './socket.js';
import { authRoutes } from './routes/auth.js';
import { spaceRoutes } from './routes/spaces.js';
import { messageRoutes } from './routes/messages.js';
import { notificationRoutes } from './routes/notifications.js';
import { uploadRoutes, fileServingRoutes } from './routes/upload.js';
import { memberRoutes } from './routes/members.js';
import { projectRoutes } from './routes/projects.js';
import { taskRoutes } from './routes/tasks.js';
import { agentRoutes } from './routes/agent.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { searchRoutes } from './routes/search.js';
import { connectionRoutes } from './routes/connections.js';
import { pinRoutes } from './routes/pins.js';
import { scheduledRoutes } from './routes/scheduled.js';
import { reminderRoutes } from './routes/reminders.js';
import { recapRoutes } from './routes/recap.js';
import { userStatusRoutes } from './routes/user-status.js';
import { knowledgeRoutes, knowledgeAggRoutes } from './routes/knowledge.js';
import { bookmarkRoutes } from './routes/bookmarks.js';
import { groupRoutes } from './routes/groups.js';
import { emojiRoutes } from './routes/emoji.js';
import { workflowRoutes } from './routes/workflows.js';
import { crossReferenceRoutes } from './routes/cross-references.js';
import { auditRoutes } from './routes/audit.js';
import { decisionRoutes } from './routes/decisions.js';
import { managerRoutes } from './routes/manager.js';
import { clipRoutes } from './routes/clips.js';
import { dailyNoteRoutes } from './routes/daily-notes.js';
import { tagRoutes } from './routes/tags.js';
import { calendarRoutes } from './routes/calendar.js';
import { eventRoutes } from './routes/events.js';
import { wikiRoutes } from './routes/wiki.js';
import { agentEmployeeRoutes } from './routes/agent-employees.js';
import { mcpConnectionRoutes } from './routes/mcp-connections.js';
import { apiKeyRoutes } from './routes/api-keys.js';
import { mcpServerRoutes } from './routes/mcp-server.js';
import { mcpServerV1Routes } from './routes/mcp-server-v1.js';
import { agentFollowupsRoutes } from './routes/agent-followups.js';
import { agentPlanRoutes } from './routes/agent-plans.js';
import { integrationsRoutes } from './routes/integrations.js';
import { agentDeployRoutes } from './routes/agent-deploy.js';
import { metricsRoutes } from './routes/metrics.js';
import { authMiddleware } from './middleware/auth.js';

const app = new Hono();

app.use('*', logger());
app.use('*', cors({
  origin: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
  credentials: true,
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

// Public routes
app.route('/api/auth', authRoutes);
app.route('/api/files', fileServingRoutes);

// MCP server — own API key auth, mounted before auth middleware
app.route('/mcp', mcpServerRoutes);

// Phase 3 MCP server v1 — Gateway bearer auth, mounted before authMiddleware
app.route('/api/mcp/v1', mcpServerV1Routes);

// Phase 10 — Prometheus metrics export, own bearer scheme, mounted before
// authMiddleware so scrapers don't need a JWT.
app.route('/api/metrics', metricsRoutes);

// Protected routes
app.use('/api/*', authMiddleware);
app.route('/api/spaces', spaceRoutes);
app.route('/api/messages', messageRoutes);
app.route('/api/notifications', notificationRoutes);
app.route('/api/upload', uploadRoutes);
app.route('/api/members', memberRoutes);
app.route('/api/projects', projectRoutes);
app.route('/api/tasks', taskRoutes);
app.route('/api/agent', agentRoutes);
app.route('/api/dashboard', dashboardRoutes);
app.route('/api/search', searchRoutes);
app.route('/api/connections', connectionRoutes);
app.route('/api/spaces', pinRoutes);
app.route('/api/spaces', recapRoutes);
app.route('/api/scheduled-messages', scheduledRoutes);
app.route('/api/reminders', reminderRoutes);
app.route('/api/users', userStatusRoutes);
app.route('/api/spaces', knowledgeRoutes);
app.route('/api/knowledge', knowledgeAggRoutes);
app.route('/api/wiki', wikiRoutes);
app.route('/api/bookmarks', bookmarkRoutes);
app.route('/api/groups', groupRoutes);
app.route('/api/emoji', emojiRoutes);
app.route('/api/workflows', workflowRoutes);
app.route('/api', crossReferenceRoutes);
app.route('/api/audit', auditRoutes);
app.route('/api/decisions', decisionRoutes);
app.route('/api/manager', managerRoutes);
app.route('/api/clips', clipRoutes);
app.route('/api/daily-notes', dailyNoteRoutes);
app.route('/api/tags', tagRoutes);
app.route('/api/calendar', calendarRoutes);
app.route('/api/events', eventRoutes);
app.route('/api/agent-employees', agentEmployeeRoutes);
app.route('/api/mcp-connections', mcpConnectionRoutes);
app.route('/api/api-keys', apiKeyRoutes);
app.route('/api/agent/followups', agentFollowupsRoutes);
app.route('/api/agent-plans', agentPlanRoutes);
app.route('/api/integrations', integrationsRoutes);
app.route('/api/agents/deploy', agentDeployRoutes);

app.get('/health', (c) => c.json({ status: 'ok' }));

app.get('/health/queue', async (c) => {
  try {
    const { db } = await import('./lib/db.js');
    const { sql } = await import('drizzle-orm');
    const result = await db.execute(sql`
      SELECT status, count(*)::int as count
      FROM job_queue
      GROUP BY status
    `);
    const rows = (result as any).rows || result;
    const counts: Record<string, number> = { pending: 0, running: 0, failed: 0, completed: 0 };
    for (const row of rows) {
      counts[row.status] = row.count;
    }
    return c.json(counts);
  } catch (err) {
    return c.json({ error: 'Failed to query queue health', code: 'INTERNAL_ERROR' }, 500);
  }
});

const port = parseInt(process.env.API_PORT || '3001');

const server = serve({ fetch: app.fetch, port }, async (info) => {
  console.log(`Deft API running on http://localhost:${info.port}`);

  // Start background job workers — uses Postgres, no Redis needed
  try {
    const { startWorkers } = await import('./workers/index.js');
    const { initScheduler } = await import('./lib/job-scheduler.js');
    startWorkers();
    await initScheduler();
    console.log('[startup] Job workers and scheduler started');
  } catch (err) {
    console.warn('[startup] Job workers failed to start:', (err as Error).message);
  }
});

setupSocket(server as unknown as Server);

export default app;
