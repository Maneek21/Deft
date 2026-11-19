/**
 * Two workspaces in one database for the workspace exporter's tests.
 *
 * Workspace A holds every kind of content with ordinary text. Workspace B
 * holds the same kinds, and every text value in B contains B_MARKER, so any
 * B content that reaches an export of A is found by a byte search. Every
 * secret-bearing column we know of, in both workspaces, holds a value
 * containing SECRET_MARKER, which must never appear in any export.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';

export const B_MARKER = 'BWORKSPACEMARK';
export const SECRET_MARKER = 'SECRETMARK';

type Row = Record<string, unknown>;

export class Seeder {
  constructor(readonly client: pg.Client) {}
  async insert(table: string, row: Row): Promise<void> {
    const keys = Object.keys(row);
    const values = keys.map((key) => {
      const value = row[key];
      return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) ? JSON.stringify(value) : value;
    });
    await this.client.query(
      `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, index) => `$${index + 1}`).join(', ')})`,
      values,
    );
  }
  /** Plants a secret marker naming the column, so a leak says where it came from. */
  secret(column: string): string {
    return `${SECRET_MARKER}-${column}-${randomUUID().slice(0, 8)}`;
  }
}

export type WorkspaceIds = {
  orgId: string; slug: string;
  owner: string; member: string; other: string; guest: string; former: string; agentUser: string; agentEmployee: string;
  spaces: Record<'general' | 'publicUnjoined' | 'privateOthers' | 'privateWithMember' | 'dmMemberOther' | 'dmOwnerOther'
    | 'archivedPrivateWithMember' | 'archivedPublic' | 'groupDm' | 'agentConversation', string>;
};

export type ExportWorld = { a: WorkspaceIds; b: WorkspaceIds; shared: string; ids: string[] };

const text = (isB: boolean, value: string) => (isB ? `${value} ${B_MARKER}` : value);

async function seedWorkspace(s: Seeder, label: string, isB: boolean, ids: string[]): Promise<WorkspaceIds> {
  const id = () => { const value = randomUUID(); ids.push(value); return value; };
  const orgId = id();
  const slug = `ex1-${label}-${orgId.slice(0, 8)}`;
  await s.insert('orgs', { id: orgId, name: text(isB, `Workspace ${label}`), slug, ai_config: { api_key: s.secret('orgs.ai_config') } });
  const person = async (name: string, role: string, isActive = true, kind = 'human') => {
    const userId = id();
    await s.insert('users', {
      id: userId, email: `${label}-${name}-${userId.slice(0, 8)}@example.test`, name: text(isB, `${label} ${name}`), kind,
      is_agent: kind === 'agent', title: text(isB, `${name} title`), password_hash: s.secret('users.password_hash'),
      ics_publish_token: s.secret('users.ics_publish_token'), email_verified: true,
    });
    await s.insert('org_members', { id: id(), org_id: orgId, user_id: userId, role, is_active: isActive });
    return userId;
  };
  const owner = await person('owner', 'owner');
  const member = await person('member', 'member');
  const other = await person('other', 'member');
  const guest = await person('guest', 'guest');
  const former = await person('former', 'member', false);
  const agentUser = await person('agent', 'member', true, 'agent');
  const agentEmployee = id();
  await s.insert('agent_employees', {
    id: agentEmployee, org_id: orgId, user_id: agentUser, name: text(isB, `${label} agent`), slug: `agent-${agentEmployee.slice(0, 8)}`,
    role: 'project_manager', system_prompt: s.secret('agent_employees.system_prompt'), mcp_token_hash: s.secret('agent_employees.mcp_token_hash'),
    job_title: text(isB, 'Agent job'), is_byoa: true, created_by: owner,
  });
  await s.client.query('UPDATE users SET agent_employee_id = $2 WHERE id = $1', [agentUser, agentEmployee]);

  const space = async (name: string, type: string, members: string[], archived = false) => {
    const spaceId = id();
    await s.insert('spaces', { id: spaceId, org_id: orgId, name: text(isB, `${label} ${name}`), type, is_archived: archived,
      description: text(isB, `${name} description`), topic: text(isB, `${name} topic`), created_by: owner });
    for (const userId of members) await s.insert('space_members', { id: id(), space_id: spaceId, user_id: userId });
    return spaceId;
  };
  const spaces = {
    general: await space('general', 'public', [owner, member, other, guest, former]),
    publicUnjoined: await space('public-unjoined', 'public', [other]),
    privateOthers: await space('private-others', 'private', [owner, other]),
    privateWithMember: await space('private-with-member', 'private', [member, other, guest]),
    dmMemberOther: await space('dm-member-other', 'dm', [member, other]),
    dmOwnerOther: await space('dm-owner-other', 'dm', [owner, other]),
    archivedPrivateWithMember: await space('archived-private', 'private', [member], true),
    archivedPublic: await space('archived-public', 'public', [other], true),
    groupDm: await space('group-dm', 'group_dm', [owner, member, guest]),
    agentConversation: await space('agent-conversation', 'agent_conversation', [other, agentUser]),
  };

  // Credentials and links Deft stores for this workspace. None may be exported.
  await s.insert('invites', { id: id(), org_id: orgId, token: s.secret('invites.token'), invited_by: owner });
  await s.insert('web_sessions', { id: id(), org_id: orgId, user_id: member, refresh_token_hash: s.secret('web_sessions.refresh_token_hash'),
    expires_at: new Date(Date.now() + 86_400_000) });
  await s.insert('connected_accounts', { id: id(), org_id: orgId, user_id: member, provider: 'google_calendar',
    access_token_encrypted: s.secret('connected_accounts.access_token_encrypted'),
    refresh_token_encrypted: s.secret('connected_accounts.refresh_token_encrypted') });
  await s.insert('ics_subscriptions', { id: id(), org_id: orgId, user_id: member, ics_url: `https://calendar.example.test/${s.secret('ics_subscriptions.ics_url')}.ics` });
  await s.insert('ics_publish_tokens', { id: id(), org_id: orgId, user_id: member, token: s.secret('ics_publish_tokens.token') });
  await s.insert('api_keys', { id: id(), org_id: orgId, name: 'key', key_hash: s.secret('api_keys.key_hash'), key_prefix: 'dk_test',
    permissions: ['read'], created_by: owner });
  await s.insert('agent_webhooks', { id: id(), org_id: orgId, agent_employee_id: agentEmployee, slug: `hook-${orgId.slice(0, 8)}`,
    secret_hash: s.secret('agent_webhooks.secret_hash'), hmac_key_encrypted: s.secret('agent_webhooks.hmac_key_encrypted') });
  await s.insert('user_two_step', { user_id: owner, secret_encrypted: s.secret('user_two_step.secret_encrypted'),
    pending_secret_encrypted: s.secret('user_two_step.pending_secret_encrypted') });
  await s.insert('user_two_step_recovery_codes', { id: id(), user_id: owner, code_hash: s.secret('user_two_step_recovery_codes.code_hash') });

  return { orgId, slug, owner, member, other, guest, former, agentUser, agentEmployee, spaces };
}

/** Seeds A and B, a person who belongs to both, and malformed cross-workspace links. */
export async function seedExportWorld(client: pg.Client): Promise<ExportWorld> {
  const s = new Seeder(client);
  const ids: string[] = [];
  const a = await seedWorkspace(s, 'a', false, ids);
  const b = await seedWorkspace(s, 'b', true, ids);
  // A person in both workspaces, a member of a private space in each.
  const shared = randomUUID();
  ids.push(shared);
  await s.insert('users', { id: shared, email: `shared-${shared.slice(0, 8)}@example.test`, name: 'Shared person', kind: 'human' });
  for (const [ws, spaceId] of [[a, a.spaces.privateWithMember], [b, b.spaces.privateOthers]] as const) {
    await s.insert('org_members', { id: randomUUID(), org_id: ws.orgId, user_id: shared, role: 'member' });
    await s.insert('space_members', { id: randomUUID(), space_id: spaceId, user_id: shared });
  }
  // Malformed: a B-only person listed as a member of an A space, and an A
  // member listed in a B space. Neither may put B into A's export.
  await s.insert('space_members', { id: randomUUID(), space_id: a.spaces.general, user_id: b.owner });
  await s.insert('space_members', { id: randomUUID(), space_id: b.spaces.general, user_id: a.member });
  // A space created by a B person.
  await client.query('UPDATE spaces SET created_by = $2 WHERE id = $1', [a.spaces.publicUnjoined, b.owner]);
  return { a, b, shared, ids };
}

/** Deletes everything the world created (children first). */
export async function dropExportWorld(client: pg.Client, world: ExportWorld): Promise<void> {
  const orgs = [world.a.orgId, world.b.orgId];
  const users = (await client.query<{ user_id: string }>('SELECT user_id FROM org_members WHERE org_id = ANY($1)', [orgs])).rows.map((row) => row.user_id);
  for (const statement of [
    'DELETE FROM user_two_step_recovery_codes WHERE user_id = ANY($2)',
    'DELETE FROM user_two_step WHERE user_id = ANY($2)',
    'DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id = ANY($1))',
    'DELETE FROM agent_webhooks WHERE org_id = ANY($1)',
    'DELETE FROM api_keys WHERE org_id = ANY($1)',
    'DELETE FROM ics_publish_tokens WHERE org_id = ANY($1)',
    'DELETE FROM ics_subscriptions WHERE org_id = ANY($1)',
    'DELETE FROM connected_accounts WHERE org_id = ANY($1)',
    'DELETE FROM web_sessions WHERE org_id = ANY($1)',
    'DELETE FROM invites WHERE org_id = ANY($1)',
    'DELETE FROM spaces WHERE org_id = ANY($1)',
    'UPDATE users SET agent_employee_id = NULL WHERE id = ANY($2)',
    'DELETE FROM agent_employees WHERE org_id = ANY($1)',
    'DELETE FROM org_members WHERE org_id = ANY($1)',
    'DELETE FROM users WHERE id = ANY($2)',
    'DELETE FROM orgs WHERE id = ANY($1)',
  ]) {
    await client.query(statement.replace('$2', '$1'), [statement.includes('$2') ? users : orgs]);
  }
}
