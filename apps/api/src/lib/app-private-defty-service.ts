import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { canonicalCapabilityJson } from '@deft/shared';
import type { AppRunKeyProvider } from './app-run-keyrings.js';
import type { AppRunTransaction } from './app-run-repository.js';
import type { AccessCaller } from './app-resource-access-service.js';
import { accessUnavailable, HumanAccessAccept } from './app-resource-access-contract.js';
import { AppResourceSyncSecretService } from './app-resource-sync-secrets.js';
import { privateSearchDatabase } from './app-resource-private-search-db.js';
import { samplePrivateAccessClock, type PrivateAccessClock } from './app-private-access-clock.js';
import { PrivateDeftyGrantSnapshot, PrivateDeftyReviewInput, PrivateDeftyReviewOutput,
  PrivateDeftyHistoryOutput, PrivateDeftyMessageMetadata,
  PrivateDeftyTurnInput, PrivateDeftyTurnOutput, PRIVATE_DEFTY_PLACEHOLDERS,
  PrivateDeftyCapacityError,
  PrivateDeftyRequestError,
  PRIVATE_DEFTY_LIMITS, type PrivateDeftySnapshot } from './app-private-defty-contract.js';
import { finalPrivateDefty, lockedPrivateDeftyContext, privateDeftyDigest, privateDeftyEnabled } from './app-private-defty-authority.js';
import { PrivateDeftySecretService } from './app-private-defty-secrets.js';
import { privateDeftyModelTurn } from './app-private-defty-turn.js';

type Tx = AppRunTransaction;
type Context = Awaited<ReturnType<typeof lockedPrivateDeftyContext>>;
const notice = 'The reviewed model provider receives your selected fields and private prompts. Revocation stops future requests and cannot recall input already delivered. Private turns cannot use tools or create memory.' as const;
let modelSlots = 0;

export class AppPrivateDeftyService {
  private readonly clocks = new WeakMap<Tx, PrivateAccessClock>();
  readonly secrets: AppResourceSyncSecretService;
  constructor(private readonly keys: AppRunKeyProvider, private readonly clock = () => new Date()) {
    this.secrets = new AppResourceSyncSecretService(keys);
  }
  private current(tx: Tx) {
    const clock = this.clocks.get(tx); if (!clock) throw accessUnavailable(); return clock.current();
  }
  private async run<T>(signal: AbortSignal | undefined, work: (tx: Tx) => Promise<T>, allowEnded = false) {
    if (!allowEnded && !privateDeftyEnabled()) throw accessUnavailable();
    let clock: PrivateAccessClock | undefined;
    const result = await privateSearchDatabase().transaction(async tx => {
      clock = await samplePrivateAccessClock(tx, this.clock);
      this.clocks.set(tx, clock);
      try { return await work(tx); } finally { this.clocks.delete(tx); }
    }, signal, performance.now() + 3000);
    signal?.throwIfAborted();
    if (clock?.expired() || (!allowEnded && !privateDeftyEnabled())) throw accessUnavailable();
    return result;
  }
  private token(value: PrivateDeftySnapshot) {
    const key = this.keys.current('fingerprint');
    try {
      const body = Buffer.from(canonicalCapabilityJson({ key_version: key.key_id, value })).toString('base64url');
      const mac = createHmac('sha256', key.key).update('deft.private_defty.review.v1\0').update(body).digest('base64url');
      return `${body}.${mac}`;
    } finally { key.key.fill(0); }
  }
  private open(token: string) {
    try {
      const [body, mac, ...extra] = token.split('.');
      if (!body || !mac || extra.length) throw accessUnavailable();
      const envelope = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      const key = this.keys.read('fingerprint', envelope.key_version);
      if (!key) throw accessUnavailable();
      try {
        const expected = createHmac('sha256', key.key).update('deft.private_defty.review.v1\0').update(body).digest();
        const actual = Buffer.from(mac, 'base64url');
        if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) throw accessUnavailable();
        return PrivateDeftyGrantSnapshot.parse(envelope.value);
      } finally { key.key.fill(0); }
    } catch { throw accessUnavailable(); }
  }
  private pins(context: Context) {
    const { authority: a, checkpoint: p, record } = context.parent;
    if (!record) throw accessUnavailable();
    return {
      app_installation_id: a.installation.id, app_version_id: a.version.id, grant_snapshot_id: a.grant.id,
      lifecycle_epoch: a.installation.lifecycle_epoch, grant_epoch: a.installation.grant_epoch,
      registration_id: a.registration.id, operator_user_id: a.registration.operator_user_id,
      runtime_epoch: a.registration.runtime_epoch, resource_binding_id: a.binding.id,
      descriptor_digest: a.descriptor_digest, checkpoint_id: p.id, generation: p.generation,
      revision_digest: privateDeftyDigest({ revision: record.revision }),
      content_digest: privateDeftyDigest({ revision: record.revision, data: record.data }),
      owner_membership_authorization_version: context.memberPins.owner,
      defty_membership_authorization_version: context.memberPins.defty,
      defty_user_id: context.defty.id, model_destination: context.destination,
    };
  }
  private context(tx: Tx, c: AccessCaller, spaceId: string, ref: PrivateDeftySnapshot['ref'],
    signal?: AbortSignal, write = false, empty = false, keyVersion?: string) {
    return lockedPrivateDeftyContext({ tx, caller: c, spaceId, ref, keys: this.keys,
      secrets: this.secrets, clock: () => this.current(tx), signal, write, empty, credentialKeyVersion: keyVersion });
  }
  private async final(tx: Tx, c: AccessCaller, context: Context, expires: Date) {
    const bounded = new Date(Math.min(expires.getTime(), context.parent.authority.binding.consent_expires_at!.getTime(),
      c.guard.current_web_session_expires_at().getTime()));
    this.clocks.get(tx)!.bindDeadline(bounded);
    await finalPrivateDefty(tx, c, context, bounded, () => this.current(tx));
  }

  async prepare(c: AccessCaller, raw: unknown, signal?: AbortSignal) {
    const input = PrivateDeftyReviewInput.parse(raw);
    return this.run(signal, async tx => {
      const context = await this.context(tx, c, input.space_id, input.ref, signal, false, true);
      const existing = await tx.execute(sql`SELECT id FROM app_private_defty_seals WHERE org_id=${c.org_id} AND space_id=${input.space_id} FOR SHARE`);
      if (existing.rows.length) throw accessUnavailable();
      if (input.field_keys.some(field => !Object.hasOwn(context.parent.authority.descriptor.record_schema.properties, field)
        || !Object.hasOwn(context.parent.record!.data, field))) throw accessUnavailable();
      const now = this.clocks.get(tx)!.issuance();
      const expires = new Date(Math.min(Date.parse(input.expires_at), now.getTime() + PRIVATE_DEFTY_LIMITS.grant_ms,
        context.parent.authority.binding.consent_expires_at!.getTime(), c.guard.current_web_session_expires_at().getTime()));
      const snapshot = PrivateDeftyGrantSnapshot.parse({
        schema_version: 'deft.app_private_defty_snapshot.v1', purpose: 'defty_private_context',
        org_id: c.org_id, owner_user_id: c.user_id, space_id: input.space_id, seal_id: randomUUID(),
        ...this.pins(context), ref: input.ref, field_keys: input.field_keys,
        app_label: String((context.parent.authority.version.manifest as Record<string, unknown>).name ?? context.parent.authority.installation.app_id).slice(0, 200),
        expires_at: expires.toISOString(), review_expires_at: new Date(Math.min(expires.getTime(), now.getTime() + PRIVATE_DEFTY_LIMITS.review_ms)).toISOString(),
      });
      const selected = Object.fromEntries(input.field_keys.map(field => [field, context.parent.record!.data[field]!]));
      if (Buffer.byteLength(canonicalCapabilityJson(selected)) > PRIVATE_DEFTY_LIMITS.context_bytes) throw accessUnavailable();
      const result = PrivateDeftyReviewOutput.parse({ snapshot, selected_data: selected,
        custody_notice: notice, review_digest: privateDeftyDigest(snapshot), review_token: this.token(snapshot) });
      if (Buffer.byteLength(JSON.stringify(result)) > 131072) throw accessUnavailable();
      await this.final(tx, c, context, new Date(snapshot.review_expires_at));
      return result;
    });
  }

  async accept(c: AccessCaller, raw: unknown, signal?: AbortSignal) {
    const input = HumanAccessAccept.parse(raw), snapshot = this.open(input.review_token);
    if (snapshot.org_id !== c.org_id || snapshot.owner_user_id !== c.user_id
      || privateDeftyDigest(snapshot) !== input.review_digest) throw accessUnavailable();
    return this.run(signal, async tx => {
      const context = await this.context(tx, c, snapshot.space_id, snapshot.ref, signal, true, false,
        snapshot.model_destination.credential_key_version);
      const pins = this.pins(context);
      if (Object.entries(pins).some(([key, value]) => canonicalCapabilityJson(value)
        !== canonicalCapabilityJson(snapshot[key as keyof PrivateDeftySnapshot]))) throw accessUnavailable();
      const seals = await tx.execute(sql`SELECT id FROM app_private_defty_seals WHERE org_id=${c.org_id} AND space_id=${snapshot.space_id} FOR UPDATE`);
      if (seals.rows.length) {
        if (seals.rows[0]!.id !== snapshot.seal_id) throw accessUnavailable();
        const grants = await tx.execute(sql`SELECT id,review_digest,revoked_at FROM app_private_defty_grants WHERE org_id=${c.org_id} AND seal_id=${snapshot.seal_id} FOR UPDATE`);
        const prior = grants.rows[0];
        if (!prior || prior.revoked_at || prior.review_digest !== input.review_digest) throw accessUnavailable();
        await this.final(tx, c, context, new Date(snapshot.expires_at));
        return { grant_id: String(prior.id), seal_id: snapshot.seal_id, space_id: snapshot.space_id, expires_at: snapshot.expires_at };
      }
      const old = await tx.execute(sql`SELECT id FROM messages WHERE org_id=${c.org_id} AND space_id=${snapshot.space_id} LIMIT 1`);
      if (old.rows.length) throw accessUnavailable();
      const retained = await tx.execute(sql`SELECT id FROM app_private_defty_seals WHERE org_id=${c.org_id}
        AND owner_user_id=${c.user_id} LIMIT 4097`);
      if (retained.rows.length >= PRIVATE_DEFTY_LIMITS.retained_seals) throw new PrivateDeftyCapacityError('retained_contexts');
      const active = await tx.execute(sql`SELECT id FROM app_private_defty_grants WHERE org_id=${c.org_id}
        AND owner_user_id=${c.user_id} AND snapshot->>'app_installation_id'=${snapshot.app_installation_id}
        AND revoked_at IS NULL AND expires_at>${this.current(tx)} LIMIT 257`);
      if (active.rows.length >= PRIVATE_DEFTY_LIMITS.active_contexts_per_app) throw new PrivateDeftyCapacityError('active_contexts');
      const grantId = randomUUID();
      await tx.execute(sql`INSERT INTO app_private_defty_seals(id,org_id,space_id,owner_user_id,defty_user_id)
        VALUES(${snapshot.seal_id},${c.org_id},${snapshot.space_id},${c.user_id},${snapshot.defty_user_id})`);
      await tx.execute(sql`INSERT INTO app_private_defty_grants(id,org_id,seal_id,owner_user_id,resource_binding_id,checkpoint_id,projection_id,review_digest,snapshot,accepted_at,expires_at)
        VALUES(${grantId},${c.org_id},${snapshot.seal_id},${c.user_id},${snapshot.resource_binding_id},${snapshot.checkpoint_id},${snapshot.ref.resource_id},${input.review_digest},${JSON.stringify(snapshot)}::jsonb,clock_timestamp(),${snapshot.expires_at}::timestamptz)`);
      await tx.execute(sql`INSERT INTO audit_log(id,org_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
        VALUES(${randomUUID()},${c.org_id},'user',${c.user_id},'private_defty_context_accepted','app_private_defty_grant',${grantId},${JSON.stringify({ seal_id: snapshot.seal_id, review_digest: input.review_digest })}::jsonb)`);
      await this.final(tx, c, context, new Date(Math.min(Date.parse(snapshot.review_expires_at), Date.parse(snapshot.expires_at))));
      return { grant_id: grantId, seal_id: snapshot.seal_id, space_id: snapshot.space_id, expires_at: snapshot.expires_at };
    });
  }

  private async ownerSeal(tx: Tx, c: AccessCaller, spaceId: string, write = false) {
    const located = await tx.execute(sql`SELECT id,owner_user_id,defty_user_id FROM app_private_defty_seals
      WHERE org_id=${c.org_id} AND space_id=${spaceId}`);
    const locator = located.rows[0];
    if (!locator || locator.owner_user_id !== c.user_id) throw accessUnavailable();
    for (const id of [...new Set([c.user_id, String(locator.defty_user_id)])].sort()) {
      await tx.execute(write && id === c.user_id
        ? sql`SELECT id FROM org_members WHERE org_id=${c.org_id} AND user_id=${id} FOR UPDATE`
        : sql`SELECT id FROM org_members WHERE org_id=${c.org_id} AND user_id=${id} FOR SHARE`);
    }
    await tx.execute(write
      ? sql`SELECT id FROM spaces WHERE org_id=${c.org_id} AND id=${spaceId} FOR UPDATE`
      : sql`SELECT id FROM spaces WHERE org_id=${c.org_id} AND id=${spaceId} FOR SHARE`);
    const seals = await tx.execute(write
      ? sql`SELECT id,owner_user_id,defty_user_id FROM app_private_defty_seals WHERE org_id=${c.org_id} AND space_id=${spaceId} FOR UPDATE`
      : sql`SELECT id,owner_user_id,defty_user_id FROM app_private_defty_seals WHERE org_id=${c.org_id} AND space_id=${spaceId} FOR SHARE`);
    const seal = seals.rows[0];
    if (!seal || privateDeftyDigest(seal) !== privateDeftyDigest(locator)) throw accessUnavailable();
    return { id: String(seal.id), defty: String(seal.defty_user_id), spaceId };
  }

  private async ownerFence(tx: Tx, c: AccessCaller, spaceId: string) {
    await c.guard(tx);
    const owner = await tx.execute(sql`
      SELECT m.user_id FROM org_members m INNER JOIN users u ON u.id=m.user_id
      INNER JOIN spaces s ON s.org_id=m.org_id AND s.id=${spaceId}
      INNER JOIN space_members sm ON sm.space_id=s.id AND sm.user_id=m.user_id
      WHERE m.org_id=${c.org_id} AND m.user_id=${c.user_id} AND m.is_active AND m.role<>'guest'
      AND u.kind='human' AND s.type='agent_conversation' AND s.created_by=${c.user_id}
    `);
    this.clocks.get(tx)!.bindDeadline(c.guard.current_web_session_expires_at());
    if (owner.rows.length !== 1 || c.guard.current_web_session_expires_at() <= this.current(tx)) throw accessUnavailable();
  }

  async history(c: AccessCaller, spaceId: string, signal?: AbortSignal) {
    return this.run(signal, async tx => {
      const seal = await this.ownerSeal(tx, c, spaceId);
      const grants = await tx.execute(sql`SELECT id,snapshot,expires_at,revoked_at FROM app_private_defty_grants
        WHERE org_id=${c.org_id} AND seal_id=${seal.id} FOR SHARE`);
      const grant = grants.rows[0];
      const rows = await tx.execute(sql`SELECT id,metadata,created_at FROM messages WHERE org_id=${c.org_id}
        AND space_id=${spaceId} ORDER BY created_at,id LIMIT 21`);
      if (rows.rows.length > 20) throw accessUnavailable();
      const crypto = new PrivateDeftySecretService(this.keys);
      let bytes = 0;
      const values = rows.rows.map(row => {
        const metadata = PrivateDeftyMessageMetadata.parse(row.metadata);
        if (metadata.seal_id !== seal.id) throw accessUnavailable();
        bytes += Buffer.from(metadata.envelope.ciphertext_b64, 'base64').length;
        if (bytes > PRIVATE_DEFTY_LIMITS.history_bytes) throw accessUnavailable();
        signal?.throwIfAborted();
        const plain = crypto.open(metadata.envelope, { org_id: c.org_id, space_id: spaceId,
          message_id: String(row.id), owner_user_id: c.user_id, defty_user_id: seal.defty,
          seal_id: seal.id, grant_id: metadata.grant_id, role: metadata.role });
        return { id: String(row.id), request_id: metadata.request_id, role: plain.role,
          text: plain.text, created_at: new Date(String(row.created_at)).toISOString() };
      });
      // Retained viewer authority is distinct from model replay authority.
      // It does not assert that the historical parent/model remains live.
      const result = PrivateDeftyHistoryOutput.parse({ schema_version: 'deft.app_private_defty_history.v1',
        grant_id: grant ? String(grant.id) : null,
        grant_expires_at: grant ? new Date(String(grant.expires_at)).toISOString() : null,
        space_id: spaceId, seal_id: seal.id, grant_state: grant && !grant.revoked_at
          && new Date(String(grant.expires_at)) > this.current(tx) && privateDeftyEnabled() ? 'active' : 'ended',
        turn_requires_reauthorization: true, messages: values });
      if (Buffer.byteLength(JSON.stringify(result)) > 327680) throw accessUnavailable();
      await this.ownerFence(tx, c, spaceId);
      return result;
    }, true);
  }

  async revoke(c: AccessCaller, grantId: string, signal?: AbortSignal) {
    return this.run(signal, async tx => {
      const found = await tx.execute(sql`SELECT s.space_id FROM app_private_defty_grants g INNER JOIN app_private_defty_seals s
        ON s.org_id=g.org_id AND s.id=g.seal_id WHERE g.org_id=${c.org_id} AND g.id=${grantId} AND g.owner_user_id=${c.user_id}`);
      if (!found.rows[0]) throw accessUnavailable();
      const spaceId = String(found.rows[0].space_id);
      const seal = await this.ownerSeal(tx, c, spaceId, true);
      const rows = await tx.execute(sql`SELECT id,revoked_at FROM app_private_defty_grants WHERE org_id=${c.org_id}
        AND id=${grantId} AND seal_id=${seal.id} AND owner_user_id=${c.user_id} FOR UPDATE`);
      if (!rows.rows.length) throw accessUnavailable();
      if (!rows.rows[0]!.revoked_at) {
        await tx.execute(sql`UPDATE app_private_defty_grants SET revoked_at=clock_timestamp()
          WHERE org_id=${c.org_id} AND id=${grantId}`);
        await tx.execute(sql`INSERT INTO audit_log(id,org_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
          VALUES(${randomUUID()},${c.org_id},'user',${c.user_id},'private_defty_context_revoked','app_private_defty_grant',${grantId},'{}'::jsonb)`);
      }
      await this.ownerFence(tx, c, spaceId);
      return { revoked: true };
    }, true);
  }

  private async live(tx: Tx, c: AccessCaller, spaceId: string, signal?: AbortSignal) {
    const located = await tx.execute(sql`SELECT g.id,g.snapshot,g.review_digest FROM app_private_defty_grants g
      INNER JOIN app_private_defty_seals s ON s.org_id=g.org_id AND s.id=g.seal_id
      WHERE g.org_id=${c.org_id} AND s.space_id=${spaceId} AND g.owner_user_id=${c.user_id}`);
    const locator = located.rows[0];
    if (!locator) throw accessUnavailable();
    const snapshot = PrivateDeftyGrantSnapshot.parse(locator.snapshot);
    if (snapshot.org_id !== c.org_id || snapshot.owner_user_id !== c.user_id || snapshot.space_id !== spaceId
      || privateDeftyDigest(snapshot) !== locator.review_digest) throw accessUnavailable();
    const context = await this.context(tx, c, spaceId, snapshot.ref, signal, true, false,
      snapshot.model_destination.credential_key_version);
    const seals = await tx.execute(sql`SELECT id,owner_user_id,defty_user_id FROM app_private_defty_seals
      WHERE org_id=${c.org_id} AND space_id=${spaceId} FOR SHARE`);
    if (seals.rows[0]?.id !== snapshot.seal_id || seals.rows[0]?.owner_user_id !== c.user_id
      || seals.rows[0]?.defty_user_id !== snapshot.defty_user_id) throw accessUnavailable();
    const grants = await tx.execute(sql`SELECT id,snapshot,revoked_at,active_request_id,active_prompt_digest
      FROM app_private_defty_grants WHERE org_id=${c.org_id} AND id=${String(locator.id)} FOR UPDATE`);
    const grant = grants.rows[0];
    if (!grant || grant.revoked_at || privateDeftyDigest(grant.snapshot) !== privateDeftyDigest(snapshot)) throw accessUnavailable();
    const pins = this.pins(context);
    if (Object.entries(pins).some(([key, value]) => canonicalCapabilityJson(value)
      !== canonicalCapabilityJson(snapshot[key as keyof PrivateDeftySnapshot]))) throw accessUnavailable();
    this.clocks.get(tx)!.bindDeadline(new Date(snapshot.expires_at));
    if (new Date(snapshot.expires_at) <= this.current(tx)) throw accessUnavailable();
    return { grant, grantId: String(grant.id), snapshot, context };
  }

  private promptDigest(snapshot: PrivateDeftySnapshot, grantId: string, requestId: string, prompt: string) {
    const key = this.keys.read('fingerprint', snapshot.model_destination.credential_key_version);
    if (!key) throw accessUnavailable();
    try {
      return `hmac-sha256:${createHmac('sha256', key.key).update('deft.private_defty.prompt.v1\0')
        .update(canonicalCapabilityJson([snapshot.org_id, snapshot.space_id, grantId, requestId, prompt])).digest('hex')}`;
    } finally { key.key.fill(0); }
  }

  private async insertPrivateMessage(tx: Tx, c: AccessCaller, state: Awaited<ReturnType<AppPrivateDeftyService['live']>>,
    requestId: string, role: 'user' | 'assistant', text: string) {
    const id = randomUUID();
    const envelope = new PrivateDeftySecretService(this.keys).seal({ role, text }, {
      org_id: c.org_id, space_id: state.snapshot.space_id, message_id: id,
      owner_user_id: c.user_id, defty_user_id: state.snapshot.defty_user_id,
      seal_id: state.snapshot.seal_id, grant_id: state.grantId, role,
    });
    const metadata = PrivateDeftyMessageMetadata.parse({ schema_version: 'deft.private_defty_message.v1',
      seal_id: state.snapshot.seal_id, grant_id: state.grantId, request_id: requestId, role, envelope });
    await tx.execute(sql`SELECT set_config('deft.private_defty_write',${state.snapshot.seal_id},true)`);
    await tx.execute(sql`INSERT INTO messages(id,org_id,space_id,user_id,content,metadata)
      VALUES(${id},${c.org_id},${state.snapshot.space_id},${role === 'user' ? c.user_id : state.snapshot.defty_user_id},
      ${PRIVATE_DEFTY_PLACEHOLDERS[role]},${JSON.stringify(metadata)}::jsonb)`);
    return id;
  }

  async turn(c: AccessCaller, spaceId: string, raw: unknown, signal?: AbortSignal) {
    const input = PrivateDeftyTurnInput.parse(raw);
    if (modelSlots >= 2) throw accessUnavailable();
    modelSlots++;
    try {
      const reserved = await this.run(signal, async tx => {
        const state = await this.live(tx, c, spaceId, signal);
        const rows = await tx.execute(sql`SELECT id,metadata FROM messages WHERE org_id=${c.org_id}
          AND space_id=${spaceId} ORDER BY created_at,id LIMIT 21`);
        if (rows.rows.length > 20) throw accessUnavailable();
        let bytes = 0;
        const crypto = new PrivateDeftySecretService(this.keys);
        const history = rows.rows.map(row => {
          const metadata = PrivateDeftyMessageMetadata.parse(row.metadata);
          if (metadata.seal_id !== state.snapshot.seal_id || metadata.grant_id !== state.grantId) throw accessUnavailable();
          bytes += Buffer.from(metadata.envelope.ciphertext_b64, 'base64').length;
          if (bytes > PRIVATE_DEFTY_LIMITS.history_bytes) throw accessUnavailable();
          signal?.throwIfAborted();
          const plain = crypto.open(metadata.envelope, { org_id: c.org_id, space_id: spaceId,
            message_id: String(row.id), owner_user_id: c.user_id, defty_user_id: state.snapshot.defty_user_id,
            seal_id: state.snapshot.seal_id, grant_id: state.grantId, role: metadata.role });
          return { metadata, plain, id: String(row.id) };
        });
        const prior = history.find(value => value.metadata.request_id === input.request_id && value.plain.role === 'user');
        if (prior) {
          if (prior.plain.text !== input.prompt) throw new PrivateDeftyRequestError('APP_PRIVATE_DEFTY_REQUEST_CONFLICT');
          const answer = history.find(value => value.metadata.request_id === input.request_id && value.plain.role === 'assistant');
          await this.final(tx, c, state.context, new Date(state.snapshot.expires_at));
          if (!answer) throw new PrivateDeftyRequestError('APP_PRIVATE_DEFTY_REQUEST_PENDING_OR_UNKNOWN');
          return { kind: 'replay' as const, result: PrivateDeftyTurnOutput.parse({
            schema_version: 'deft.app_private_defty_turn_result.v1', space_id: spaceId, request_id: input.request_id,
            message_id: answer.id, text: answer.plain.text, expires_at: state.snapshot.expires_at,
          }) };
        }
        if (state.grant.active_request_id) throw new PrivateDeftyRequestError('APP_PRIVATE_DEFTY_REQUEST_BUSY');
        if (history.filter(value => value.plain.role === 'user').length >= PRIVATE_DEFTY_LIMITS.turns) throw accessUnavailable();
        // Reserve worst-case whole answer capacity before sending any new input.
        if (bytes + Buffer.byteLength(canonicalCapabilityJson({ role: 'user', text: input.prompt }))
          + PRIVATE_DEFTY_LIMITS.output_bytes > PRIVATE_DEFTY_LIMITS.history_bytes) throw accessUnavailable();
        const fingerprint = this.promptDigest(state.snapshot, state.grantId, input.request_id, input.prompt);
        await tx.execute(sql`UPDATE app_private_defty_grants SET active_request_id=${input.request_id},active_prompt_digest=${fingerprint}
          WHERE org_id=${c.org_id} AND id=${state.grantId}`);
        await this.insertPrivateMessage(tx, c, state, input.request_id, 'user', input.prompt);
        await this.final(tx, c, state.context, new Date(state.snapshot.expires_at));
        const selected = Object.fromEntries(state.snapshot.field_keys.map(field => {
          if (!Object.hasOwn(state.context.parent.record!.data, field)) throw accessUnavailable();
          return [field, state.context.parent.record!.data[field]!];
        }));
        return { kind: 'dispatch' as const, state, fingerprint, selected,
          history: history.map(value => value.plain) };
      });
      if (reserved.kind === 'replay') return reserved.result;
      signal?.throwIfAborted();
      if (!privateDeftyEnabled()) throw accessUnavailable();
      // The only model I/O is outside all database transactions. Already sent
      // reviewed input cannot be recalled if authority ends during this await.
      const text = await privateDeftyModelTurn({ resolved: reserved.state.context.resolved,
        selected: reserved.selected, history: reserved.history, prompt: input.prompt, signal });
      return await this.run(signal, async tx => {
        const state = await this.live(tx, c, spaceId, signal);
        if (state.grantId !== reserved.state.grantId || state.grant.active_request_id !== input.request_id
          || state.grant.active_prompt_digest !== reserved.fingerprint) throw accessUnavailable();
        const messageId = await this.insertPrivateMessage(tx, c, state, input.request_id, 'assistant', text);
        await tx.execute(sql`UPDATE app_private_defty_grants SET active_request_id=NULL,active_prompt_digest=NULL
          WHERE org_id=${c.org_id} AND id=${state.grantId} AND active_request_id=${input.request_id}`);
        await tx.execute(sql`INSERT INTO audit_log(id,org_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
          VALUES(${randomUUID()},${c.org_id},'user',${c.user_id},'private_defty_turn_completed','message',${messageId},
          ${JSON.stringify({ grant_id: state.grantId, request_id: input.request_id })}::jsonb)`);
        await this.final(tx, c, state.context, new Date(state.snapshot.expires_at));
        return PrivateDeftyTurnOutput.parse({ schema_version: 'deft.app_private_defty_turn_result.v1',
          space_id: spaceId, request_id: input.request_id, message_id: messageId, text, expires_at: state.snapshot.expires_at });
      });
    } finally { modelSlots--; }
  }
}
