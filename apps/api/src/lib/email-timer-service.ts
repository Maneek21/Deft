import { resolveEmailOutboxSchedule } from './email-outbox-schedule.js';
import type { EmailActor, EmailCapability, EmailOperation, EmailScope } from './email-mailbox-service.js';
import { EmailTimerStore } from './email-timer-store.js';
import { EmailTimerActorSchema, EmailTimerError, EmailTimerIdSchema, EmailTimerListQuerySchema,
  EmailTimerScopeSchema, EmailTimerWriteSchema, type EmailTimerPage, type EmailTimerView } from './email-timer-types.js';

export type EmailTimerAuthorityPort = Readonly<{ current(actor: EmailActor, scope: EmailScope, operation: EmailOperation,
  transaction?: unknown, signal?: AbortSignal): Promise<EmailCapability> }>;

/** Timer writes are local-only. The connected authority is inspected outside
 * SQL transactions; only the SQL authority guard runs while rows are locked. */
export class EmailTimerService {
  constructor(private readonly connectedAuthority: EmailTimerAuthorityPort, private readonly sqlAuthority: EmailTimerAuthorityPort,
    private readonly store: EmailTimerStore, private readonly now = Date.now,
    private readonly schedule?: (scope: EmailScope, timer: EmailTimerView) => Promise<void>) {}

  private async authorized(rawActor: EmailActor, rawScope: EmailScope, operation: 'human_read' | 'human_draft', signal?: AbortSignal) {
    let actor: EmailActor, scope: EmailScope;
    try { actor = Object.freeze(EmailTimerActorSchema.parse(rawActor)); scope = Object.freeze(EmailTimerScopeSchema.parse(rawScope)); }
    catch { throw new EmailTimerError('EMAIL_TIMER_ACCESS_DENIED'); }
    const time = this.now();
    if (actor.user_id !== scope.owner_user_id || !Number.isFinite(time) || actor.access_expires_at <= time) throw new EmailTimerError('EMAIL_TIMER_ACCESS_DENIED');
    signal?.throwIfAborted();
    let sqlInitial: EmailCapability, connectedInitial: EmailCapability, sqlRechecked: EmailCapability;
    try {
      sqlInitial = await this.sqlAuthority.current(actor, scope, operation, undefined, signal);
      connectedInitial = await this.connectedAuthority.current(actor, scope, operation, undefined, signal);
      sqlRechecked = await this.sqlAuthority.current(actor, scope, operation, undefined, signal);
    } catch (error) { if (signal?.aborted) throw error; throw new EmailTimerError('EMAIL_TIMER_ACCESS_DENIED'); }
    const valid = (capability: EmailCapability) => capability.scope.org_id === scope.org_id && capability.scope.owner_user_id === scope.owner_user_id
      && capability.scope.account_id === scope.account_id && Number.isFinite(capability.expires_at) && capability.expires_at > this.now()
      && capability.resource_binding_id === sqlInitial.resource_binding_id;
    if (!valid(sqlInitial) || !valid(connectedInitial) || !valid(sqlRechecked)
      || sqlInitial.authority_version !== sqlRechecked.authority_version || connectedInitial.expires_at <= this.now())
      throw new EmailTimerError('EMAIL_TIMER_ACCESS_DENIED');
    const guard = async (transaction: unknown) => {
      signal?.throwIfAborted();
      if (actor.access_expires_at <= this.now()) throw new EmailTimerError('EMAIL_TIMER_ACCESS_DENIED');
      const current = await this.sqlAuthority.current(actor, scope, operation, transaction, signal);
      signal?.throwIfAborted();
      if (current.scope.org_id !== scope.org_id || current.scope.owner_user_id !== scope.owner_user_id || current.scope.account_id !== scope.account_id
        || current.authority_version !== sqlInitial.authority_version || current.resource_binding_id !== sqlInitial.resource_binding_id
        || current.expires_at <= this.now()) throw new EmailTimerError('EMAIL_TIMER_ACCESS_DENIED');
    };
    const recheck = async () => {
      signal?.throwIfAborted();
      const [currentSql, currentConnected] = await Promise.all([
        this.sqlAuthority.current(actor, scope, operation, undefined, signal),
        this.connectedAuthority.current(actor, scope, operation, undefined, signal),
      ]);
      signal?.throwIfAborted();
      if (currentSql.authority_version !== sqlInitial.authority_version || currentSql.resource_binding_id !== sqlInitial.resource_binding_id
        || currentConnected.resource_binding_id !== connectedInitial.resource_binding_id || currentConnected.authority_version !== connectedInitial.authority_version
        || currentSql.expires_at <= this.now() || currentConnected.expires_at <= this.now()) throw new EmailTimerError('EMAIL_TIMER_ACCESS_DENIED');
    };
    return { actor, scope, guard, recheck };
  }

  async get(actor: EmailActor, scope: EmailScope, timerId: string, signal?: AbortSignal): Promise<EmailTimerView> {
    let id: string; try { id = EmailTimerIdSchema.parse(timerId); } catch { throw new EmailTimerError('EMAIL_TIMER_INVALID'); }
    const auth = await this.authorized(actor, scope, 'human_read', signal);
    const result = await this.store.read(auth.scope, id, auth.guard, signal); await auth.recheck();
    if (!result) throw new EmailTimerError('EMAIL_TIMER_NOT_FOUND');
    return result;
  }

  async list(actor: EmailActor, scope: EmailScope, rawQuery: unknown, signal?: AbortSignal): Promise<EmailTimerPage> {
    let query: ReturnType<typeof EmailTimerListQuerySchema.parse>;
    try { query = EmailTimerListQuerySchema.parse(rawQuery); } catch { throw new EmailTimerError('EMAIL_TIMER_INVALID'); }
    const auth = await this.authorized(actor, scope, 'human_read', signal);
    const result = await this.store.list(auth.scope, query.kind ?? null, query.state ?? null, query.cursor, query.limit, auth.guard, signal);
    await auth.recheck();
    for (const timer of result.items) if (timer.state === 'scheduled') await this.schedule?.(auth.scope, timer);
    return result;
  }

  async save(actor: EmailActor, scope: EmailScope, timerId: string, rawInput: unknown, signal?: AbortSignal): Promise<EmailTimerView> {
    let id: string, input: ReturnType<typeof EmailTimerWriteSchema.parse>, schedule: ReturnType<typeof resolveEmailOutboxSchedule>;
    try {
      id = EmailTimerIdSchema.parse(timerId); input = EmailTimerWriteSchema.parse(rawInput);
      schedule = resolveEmailOutboxSchedule({ ...input.schedule, missed_policy: 'send_when_available' }, new Date(this.now()));
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof EmailTimerError) throw error;
      const code = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
      throw new EmailTimerError(code.startsWith('EMAIL_OUTBOX_SCHEDULE_') ? 'EMAIL_TIMER_INVALID' : 'EMAIL_TIMER_INVALID');
    }
    const auth = await this.authorized(actor, scope, 'human_draft', signal);
    let result: EmailTimerView;
    if ('logical_message_id' in input) {
      const content = { logical_message_id: input.logical_message_id, kind: input.kind,
        ...(input.reminder_text === undefined ? {} : { reminder_text: input.reminder_text }) };
      result = await this.store.create(auth.scope, id, content, new Date(schedule.instant), schedule.zone, auth.guard, signal);
    } else {
      result = await this.store.reschedule(auth.scope, id, input.expected_revision, new Date(schedule.instant), schedule.zone,
        input.reminder_text, Object.prototype.hasOwnProperty.call(input, 'reminder_text'), auth.guard, signal);
    }
    await auth.recheck();
    if (result.state === 'scheduled') await this.schedule?.(auth.scope, result).catch(() => {});
    return result;
  }

  async cancel(actor: EmailActor, scope: EmailScope, timerId: string, expectedRevision: number, signal?: AbortSignal): Promise<EmailTimerView> {
    let id: string; try { id = EmailTimerIdSchema.parse(timerId); } catch { throw new EmailTimerError('EMAIL_TIMER_INVALID'); }
    const auth = await this.authorized(actor, scope, 'human_draft', signal);
    const result = await this.store.cancel(auth.scope, id, expectedRevision, auth.guard, signal); await auth.recheck(); return result;
  }

  async hiddenInboxMessageIds(actor: EmailActor, scope: EmailScope, logicalMessageIds: readonly string[], signal?: AbortSignal) {
    const auth = await this.authorized(actor, scope, 'human_read', signal);
    const result = await this.store.hiddenInboxMessageIds(auth.scope, logicalMessageIds, auth.guard, signal); await auth.recheck(); return result;
  }

  async futureInboxMessageIds(actor: EmailActor, scope: EmailScope, signal?: AbortSignal) {
    const auth = await this.authorized(actor, scope, 'human_read', signal);
    const result = await this.store.futureInboxMessageIds(auth.scope, auth.guard, signal); await auth.recheck(); return result;
  }
}
