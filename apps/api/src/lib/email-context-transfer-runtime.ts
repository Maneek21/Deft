import { db } from './db.js';
import { getEmailMailboxAuthority } from './email-account-authority-router.js';
import { getEmailMailboxRuntime } from './email-mailbox-runtime.js';
import { EmailMessageContentService } from './email-message-content.js';
import { EmailContextTransferService, createPostgresEmailTransferSource } from './email-context-transfer.js';
import { enqueue, QUEUE_NAMES } from './queues.js';
import { getIO } from '../socket.js';
import type { EmailActor } from './email-mailbox-service.js';
import { EmailMailboxCrypto } from './email-mailbox-crypto.js';
import { getAppRunRuntime } from './app-run-runtime.js';
import { nativeChatForwardBroadcast } from './native-chat-forward.js';

export async function getEmailContextTransferService(actor: EmailActor) {
  const [base, runtime, { keys }] = await Promise.all([getEmailMailboxAuthority(db), getEmailMailboxRuntime(actor), getAppRunRuntime()]);
  const cipher = new EmailMailboxCrypto(keys);
  // An explicit excerpt re-fetches the current provider presentation; retained
  // reader caches cannot silently stand in for the reviewed source at commit.
  const content = new EmailMessageContentService(runtime.authority, runtime.store, runtime.provider);
  const source = createPostgresEmailTransferSource(db, base, (host, scope, id, signal) => content.readPresentation(host, scope, id, signal),
    (scope, id, signal) => runtime.store.readMessage(scope, id, signal),
    (scope, row) => cipher.open(row.source_envelope, { ...scope, kind: 'provider_source', record_id: row.logical_message_id,
      revision: row.storage_revision }) as Record<string, import('@deft/shared').CapabilityJsonValue>);
  return new EmailContextTransferService(db, source, async (result, entry) => {
    if (result.destination_kind === 'chat') {
      const full = await nativeChatForwardBroadcast(db, entry.id);
      if (full) getIO()?.to(`space:${full.space_id}`).emit('message:new', full);
    } else if (result.destination_kind === 'knowledge') {
      await enqueue(QUEUE_NAMES.AGENT_JOBS, 'embed-content', { source_type: 'wiki_page', source_id: entry.id }).catch(() => undefined);
      if ('space_id' in entry && entry.space_id) getIO()?.to(`space:${entry.space_id}`).emit('knowledge:created', {
        ...entry, created_by: entry.user_id, author_name: null, author_avatar: null,
        source_message_id: null, source_space_id: null,
      });
    } else if (entry.content && /[A-Z]+-\d+/u.test(entry.content)) {
      await enqueue(QUEUE_NAMES.AGENT_JOBS, 'cross-reference', { sourceType: 'note', sourceId: entry.id,
        content: entry.content, orgId: entry.org_id, userId: actor.user_id }).catch(() => undefined);
    }
  });
}
