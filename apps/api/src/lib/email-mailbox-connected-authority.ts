import { createHash } from 'node:crypto';
import type {NativeEmailAccount} from './email-native-adapter-contract.js';
import { EmailMailboxError, type EmailOperationActor, type EmailAuthority, type EmailCapability,
  type EmailOperation, type EmailScope } from './email-mailbox-service.js';

type ConnectionAuthority = {
  assertConnected(scope: EmailScope, capability: EmailCapability, recheck: () => Promise<void>, signal?: AbortSignal): Promise<NativeEmailAccount>;
};

/** Legacy disconnect can revoke OAuth custody without revoking its App binding.
 * Until lifecycle writes share native account state, every native cache exposure
 * checks both. Custody generation pins same-account reconnects during held I/O. */
export class ConnectedEmailMailboxAuthority implements EmailAuthority {
  constructor(private readonly base: EmailAuthority, private readonly connection: ConnectionAuthority,
    private readonly now = Date.now) {}
  async current(actor: EmailOperationActor, scope: EmailScope, operation: EmailOperation, transaction?: unknown,
    signal?: AbortSignal): Promise<EmailCapability> {
    return (await this.inspect(actor, scope, operation, transaction, signal)).capability;
  }
  async inspect(actor: EmailOperationActor, scope: EmailScope, operation: EmailOperation, transaction?: unknown,
    signal?: AbortSignal): Promise<Readonly<{capability:EmailCapability;account:NativeEmailAccount}>> {
    return inspectEmailMailboxConnection(scope,()=>this.base.current(actor,scope,operation,transaction,signal),this.connection,signal,this.now);
  }
}

/** Shared connected-custody check accepts a real principal's SQL authority
 * closure: either an exact human session or a leased account-service job. */
export async function inspectEmailMailboxConnection(scope:EmailScope,currentSql:()=>Promise<EmailCapability>,
  connection:ConnectionAuthority,signal?:AbortSignal,now=Date.now):Promise<Readonly<{capability:EmailCapability;account:NativeEmailAccount}>> {
    const initial = await currentSql();
    const recheck = async () => {
      signal?.throwIfAborted();
      const current = await currentSql();
      if (current.resource_binding_id !== initial.resource_binding_id || current.authority_version !== initial.authority_version
        || current.scope.org_id !== scope.org_id || current.scope.owner_user_id !== scope.owner_user_id || current.scope.account_id !== scope.account_id
        || !Number.isFinite(current.expires_at) || current.expires_at <= now()) throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
    };
    // This callback is deliberately SQL-only: checking custody recursively here
    // would repeatedly call nativeEmailAccount without ever reaching provider I/O.
    const account = await connection.assertConnected(scope, initial, recheck, signal);
    await recheck();
    if (initial.expires_at <= now() || account.account_id !== scope.account_id
      || account.resource_binding_id !== initial.resource_binding_id || account.health !== 'connected'
      || !Number.isSafeInteger(account.connection_revision) || account.connection_revision < 0
      || !Number.isSafeInteger(account.authority_epoch) || account.authority_epoch < 1
      || !/^[a-f0-9]{64}$/.test(account.principal_digest)
      || account.implementation_digest!==undefined&&!/^[a-f0-9]{64}$/.test(account.implementation_digest)
      || !account.capabilities.includes('read')) throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
    const authority_version = createHash('sha256').update(JSON.stringify({
      base: initial.authority_version, provider: account.provider, epoch: account.authority_epoch,
      connection_revision: account.connection_revision, principal_digest: account.principal_digest, capabilities: [...account.capabilities].sort(),
      ...(account.implementation_digest?{implementation_digest:account.implementation_digest}:{}),
    })).digest('hex');
    return Object.freeze({capability:Object.freeze({...initial, authority_version}),account:Object.freeze({...account,capabilities:Object.freeze([...account.capabilities])})});
}
