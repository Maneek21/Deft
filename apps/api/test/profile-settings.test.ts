import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { Hono } from 'hono';
import { authRoutes } from '../src/routes/auth.js';
import { messageRoutes } from '../src/routes/messages.js';
import { authMiddleware } from '../src/middleware/auth.js';
import { env } from '../src/lib/env.js';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const app = new Hono();
app.route('/api/auth', authRoutes);
app.use('/api/messages/*', authMiddleware);
app.route('/api/messages', messageRoutes);

const RUN_ID = crypto.randomUUID();
const ORG_ID = crypto.randomUUID();
const USER_ID = crypto.randomUUID();
const SPACE_ID = crypto.randomUUID();
const EMAIL = `profile-${RUN_ID}@test.local`;

function accessToken() {
  return jwt.sign({ id: USER_ID, email: EMAIL, org_id: ORG_ID }, env.JWT_SECRET, { expiresIn: '15m' });
}

async function authed(path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken()}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  }));
}

before(async () => {
  const passwordHash = await bcrypt.hash('old-password-123', 12);
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO orgs (id, name, slug)
       VALUES ($1, 'Profile Settings Org', $2)`,
      [ORG_ID, `profile-settings-${RUN_ID.slice(0, 8)}`],
    );
    await c.query(
      `INSERT INTO users (id, email, name, email_verified, password_hash)
       VALUES ($1, $2, 'Profile Test User', true, $3)`,
      [USER_ID, EMAIL, passwordHash],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES ($1, $2, $3, 'member', true)`,
      [crypto.randomUUID(), ORG_ID, USER_ID],
    );
    await c.query(
      `INSERT INTO spaces (id, org_id, name, type, created_by)
       VALUES ($1, $2, 'profile-avatar-smoke', 'public', $3)`,
      [SPACE_ID, ORG_ID, USER_ID],
    );
    await c.query(
      `INSERT INTO space_members (id, space_id, user_id)
       VALUES ($1, $2, $3)`,
      [crypto.randomUUID(), SPACE_ID, USER_ID],
    );
  });
});

after(async () => {
  await withClient(async (c) => {
    await c.query(`DELETE FROM messages WHERE space_id = $1`, [SPACE_ID]);
    await c.query(`DELETE FROM space_members WHERE space_id = $1`, [SPACE_ID]);
    await c.query(`DELETE FROM spaces WHERE id = $1`, [SPACE_ID]);
    await c.query(`DELETE FROM org_members WHERE user_id = $1`, [USER_ID]);
    await c.query(`DELETE FROM users WHERE id = $1`, [USER_ID]);
    await c.query(`DELETE FROM orgs WHERE id = $1`, [ORG_ID]);
  });
});

describe('profile settings', () => {
  test('PATCH /api/auth/me persists profile identity and preferences', async () => {
    const res = await authed('/api/auth/me', {
      method: 'PATCH',
      body: JSON.stringify({
        name: 'Diego Profile',
        title: 'Founder and Farm Manager',
        profile_summary: 'Runs buyer commitments and harvest tradeoffs.',
        expertise_tags: ['buyer ops', 'harvest', 'buyer ops', 'pricing'],
        timezone: 'America/Los_Angeles',
        avatar_url: '/avatars/avatar-08-elf.png',
        notification_keywords: ['launch', 'blocker', 'launch'],
        notification_preferences: {
          keywords: ['launch', 'blocker', 'launch'],
          channels: {
            chat: true,
            tasks: false,
            approvals: true,
            calendar: false,
            agents: true,
          },
        },
        show_read_receipts: false,
      }),
    });

    const body = await res.json() as any;
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.user.name, 'Diego Profile');
    assert.equal(body.user.role, 'member');
    assert.deepEqual(body.user.expertise_tags, ['buyer ops', 'harvest', 'pricing']);
    assert.equal(body.user.avatar_url, '/avatars/avatar-08-elf.png');
    assert.deepEqual(body.user.notification_keywords, ['launch', 'blocker']);
    assert.deepEqual(body.user.notification_preferences, {
      keywords: ['launch', 'blocker'],
      channels: {
        chat: true,
        tasks: false,
        approvals: true,
        calendar: false,
        agents: true,
      },
      push: {
        enabled: false,
        chat: true,
        tasks: true,
        approvals: true,
        calendar: true,
        agents: true,
        quiet_hours: {
          enabled: false,
          start: '22:00',
          end: '08:00',
        },
      },
    });
    assert.equal(body.user.show_read_receipts, false);

    const meRes = await authed('/api/auth/me');
    const me = await meRes.json() as any;
    assert.equal(me.user.profile_summary, 'Runs buyer commitments and harvest tradeoffs.');
    assert.equal(me.user.title, 'Founder and Farm Manager');
    assert.equal(me.user.timezone, 'America/Los_Angeles');
    assert.equal(me.user.avatar_url, '/avatars/avatar-08-elf.png');
    assert.equal(me.user.notification_preferences.channels.tasks, false);
  });

  test('chat message responses include the saved profile avatar', async () => {
    const avatar = '/avatars/avatar-20-mushroom.png';
    const update = await authed('/api/auth/me', {
      method: 'PATCH',
      body: JSON.stringify({ avatar_url: avatar }),
    });
    const updateBody = await update.json() as any;
    assert.equal(update.status, 200, JSON.stringify(updateBody));
    assert.equal(updateBody.user.avatar_url, avatar);

    const send = await authed(`/api/messages/${SPACE_ID}`, {
      method: 'POST',
      body: JSON.stringify({ content: 'Avatar contract smoke' }),
    });
    const sendBody = await send.json() as any;
    assert.equal(send.status, 201, JSON.stringify(sendBody));
    assert.equal(sendBody.user_avatar, avatar);

    const list = await authed(`/api/messages/${SPACE_ID}`);
    const listBody = await list.json() as any;
    assert.equal(list.status, 200, JSON.stringify(listBody));
    const rows = Array.isArray(listBody) ? listBody : listBody.messages;
    const created = rows.find((message: any) => message.id === sendBody.id);
    assert.ok(created, 'sent message should be returned from GET /api/messages/:spaceId');
    assert.equal(created.user_avatar, avatar);
  });

  test('PATCH /api/auth/me accepts uploaded image data URLs and rejects unsafe avatar schemes', async () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const ok = await authed('/api/auth/me', {
      method: 'PATCH',
      body: JSON.stringify({ avatar_url: dataUrl }),
    });
    const okBody = await ok.json() as any;
    assert.equal(ok.status, 200, JSON.stringify(okBody));
    assert.equal(okBody.user.avatar_url, dataUrl);

    const bad = await authed('/api/auth/me', {
      method: 'PATCH',
      body: JSON.stringify({ avatar_url: 'javascript:alert(1)' }),
    });
    assert.equal(bad.status, 400);
  });

  test('PATCH /api/auth/password validates current password and updates hash', async () => {
    const wrong = await authed('/api/auth/password', {
      method: 'PATCH',
      body: JSON.stringify({ current_password: 'wrong-password', new_password: 'new-password-123' }),
    });
    assert.equal(wrong.status, 403);

    const ok = await authed('/api/auth/password', {
      method: 'PATCH',
      body: JSON.stringify({ current_password: 'old-password-123', new_password: 'new-password-123' }),
    });
    const body = await ok.json() as any;
    assert.equal(ok.status, 200, JSON.stringify(body));

    const hash = await withClient(async (c) => {
      const result = await c.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [USER_ID]);
      return result.rows[0]!.password_hash;
    });
    assert.equal(await bcrypt.compare('new-password-123', hash), true);
  });
});
