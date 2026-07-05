import 'dotenv/config';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { authRoutes } from './routes/auth.js';
import { spaceRoutes } from './routes/spaces.js';
import { messageRoutes } from './routes/messages.js';
import { notificationRoutes } from './routes/notifications.js';
import { inboxRoutes } from './routes/inbox.js';
import { orgRoutes } from './routes/org.js';
import { icsRoutes, icsPublicRoutes } from './routes/ics.js';
import { inviteRoutes } from './routes/invites.js';
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
import { canvasRoutes } from './routes/canvas.js';
import { aiTransformRoutes } from './routes/ai-transform.js';
import { userStatusRoutes } from './routes/user-status.js';
import { knowledgeRoutes, knowledgeAggRoutes } from './routes/knowledge.js';
import { bookmarkRoutes } from './routes/bookmarks.js';
import { groupRoutes } from './routes/groups.js';
import { teamRoutes } from './routes/teams.js';
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
import { mcpAccessRoutes } from './routes/mcp-access.js';
import { agentChannelRoutes } from './routes/agent-channel.js';
import { oauthProtectedRoutes, oauthPublicRoutes, oauthWellKnownRoutes } from './routes/oauth-mcp.js';
import { apiKeyRoutes } from './routes/api-keys.js';
import { mcpServerRoutes } from './routes/mcp-server.js';
import { mcpServerV1Routes } from './routes/mcp-server-v1.js';
import { agentPlanRoutes } from './routes/agent-plans.js';
import { metricsRoutes } from './routes/metrics.js';
import { skillsRoutes } from './routes/skills.js';
import { taskTemplateRoutes } from './routes/task-templates.js';
import { workIntentRoutes } from './routes/work-intents.js';
import { authMiddleware } from './middleware/auth.js';
import { authLimiter, agentLimiter, uploadLimiter, defaultLimiter, webhookLimiter } from './middleware/rate-limit.js';
import { githubWebhookRoutes } from './routes/webhooks/github.js';

const app = new Hono();

app.use('*', logger());
app.use('*', cors({
  origin: [
    process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ],
  credentials: true,
  allowHeaders: ['Content-Type', 'Authorization', 'x-deft-audit-token'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

// Task 4 (private-alpha): security headers. Browsers loading API responses
// cross-origin only see JSON — no script-src needed here. xFrameOptions
// blocks the API itself from being iframed even though there's no HTML;
// defense in depth.
app.use('*', secureHeaders({
  xFrameOptions: 'DENY',
  xContentTypeOptions: 'nosniff',
  referrerPolicy: 'strict-origin-when-cross-origin',
  strictTransportSecurity: 'max-age=31536000; includeSubDomains',
}));

// Public routes
app.route('/.well-known', oauthWellKnownRoutes);
app.route('/oauth', oauthPublicRoutes);
// Keep credential-changing auth endpoints under the strict brute-force limiter,
// but let read-only session checks use the normal app budget. UI-heavy pages
// can call /auth/me repeatedly during navigation; treating those like login
// attempts makes a valid session look expired after a short local demo sweep.
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/signup', authLimiter);
app.use('/api/auth/refresh', authLimiter);
app.use('/api/auth/logout', authLimiter);
app.use('/api/auth/has-workspace', defaultLimiter);
app.use('/api/auth/me', defaultLimiter);
app.use('/api/auth/onboarding', defaultLimiter);
app.route('/api/auth', authRoutes);

// MCP server — own API key auth, mounted before auth middleware
app.route('/mcp', mcpServerRoutes);

// Phase 3 MCP server v1 — Gateway bearer auth, mounted before authMiddleware
app.route('/api/mcp/v1', mcpServerV1Routes);
app.use('/api/agent-channel/v1/*', agentLimiter);
app.route('/api/agent-channel/v1', agentChannelRoutes);

// Phase 10 — Prometheus metrics export, own bearer scheme, mounted before
// authMiddleware so scrapers don't need a JWT.
app.route('/api/metrics', metricsRoutes);

// Task 8.7 — external webhook endpoints (GitHub). Verified via provider-
// specific HMAC header (GITHUB_WEBHOOK_SECRET), not JWT — mounted before
// authMiddleware.
app.use('/api/webhooks/*', webhookLimiter);
app.route('/api/webhooks', githubWebhookRoutes);

// Block 3.3 — per-agent external webhooks. POST with secret in header,
// no JWT. Management routes under /api/agent-webhooks are JWT-gated and
// mounted AFTER authMiddleware below.
const { publicAgentWebhookRoutes, agentWebhookRoutes } = await import('./routes/agent-webhooks.js');
app.use('/api/agent-webhooks/*', webhookLimiter);
app.route('/api/agent-webhooks', publicAgentWebhookRoutes);

// Public ICS calendar feed. The publish token in the URL is the only
// credential; mounted before authMiddleware so calendar clients can
// subscribe without a JWT.
app.route('/api/ics', icsPublicRoutes);

// Public invite preview/accept. Token in URL path; admin shares link
// out-of-band per "Email: none" design. Mounted before authMiddleware.
app.route('/api/invites', inviteRoutes);

// Protected routes
app.use('/api/*', authMiddleware);
app.use('/api/*', defaultLimiter);
app.use('/api/agent/*', agentLimiter);
app.use('/api/upload/*', uploadLimiter);
app.route('/api/agent-webhooks', agentWebhookRoutes);
app.route('/api/spaces', spaceRoutes);
app.route('/api/messages', messageRoutes);
app.route('/api/notifications', notificationRoutes);
app.route('/api/inbox', inboxRoutes);
app.route('/api/org', orgRoutes);
app.route('/api/ics', icsRoutes);
app.route('/api/upload', uploadRoutes);
app.route('/api/files', fileServingRoutes);
app.route('/api/members', memberRoutes);
app.route('/api/projects', projectRoutes);
app.route('/api/tasks', taskRoutes);
app.route('/api/agent', agentRoutes);
app.route('/api/dashboard', dashboardRoutes);
app.route('/api/search', searchRoutes);
app.route('/api/connections', connectionRoutes);
app.route('/api/spaces', pinRoutes);
app.route('/api/spaces', recapRoutes);
app.route('/api/spaces', canvasRoutes);
app.route('/api/ai', aiTransformRoutes);
app.route('/api/scheduled-messages', scheduledRoutes);
app.route('/api/reminders', reminderRoutes);
app.route('/api/users', userStatusRoutes);
app.route('/api/spaces', knowledgeRoutes);
app.route('/api/knowledge', knowledgeAggRoutes);
app.route('/api/wiki', wikiRoutes);
app.route('/api/bookmarks', bookmarkRoutes);
app.route('/api/groups', groupRoutes);
app.route('/api/teams', teamRoutes);
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
app.route('/api/mcp-access', mcpAccessRoutes);
app.route('/api/oauth', oauthProtectedRoutes);
app.route('/api/api-keys', apiKeyRoutes);
app.route('/api/agent-plans', agentPlanRoutes);
app.route('/api/skills', skillsRoutes);
// Task 4.11 — /api/projects/:id/apply-template (template bulk-create)
app.route('/api/projects', taskTemplateRoutes);
// Task 3 — /api/task-templates list + detail (read-only catalog)
app.route('/api/task-templates', taskTemplateRoutes);
app.route('/api/work-intents', workIntentRoutes);

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

export { app };
export default app;
