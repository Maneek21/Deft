/**
 * Deleting a message only marks its row (`is_deleted = true`): the text, the
 * metadata and the attachment links stay in the database, because the
 * assistant's audit trail needs them. Nothing a deleted message said may be
 * returned to a reader, whoever they are (a member of the space, a member
 * reading a public space before joining, or the author).
 *
 * Every place that returns message rows to a reader either leaves deleted
 * rows out of its query (`is_deleted = false`) or, where the row must still be
 * shown as "message deleted" (the chat list and threads), passes each row
 * through `withoutDeletedContent`.
 */

/** Fields that carry what the message said, or what was attached to it. */
const TEXT_FIELDS = ['content', 'body', 'snippet', 'preview'] as const;
const LIST_FIELDS = ['reactions', 'file_ids', 'files', 'attachments', 'link_previews'] as const;
const NULLED_FIELDS = ['edited_at', 'link_preview'] as const;

/**
 * Of a deleted message's metadata only `kind` is kept: it holds no content,
 * and the chat view uses it to leave tool-result rows out.
 */
function deletedMetadata(metadata: unknown): { kind: string } | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const kind = (metadata as Record<string, unknown>).kind;
  return typeof kind === 'string' ? { kind } : null;
}

/**
 * Returns the row unchanged unless it is deleted. A deleted row keeps what a
 * client needs to show "message deleted" in place (id, space, author, time,
 * thread position, reply count, the deleted flag) and loses its text,
 * metadata, reactions, attachments and link previews.
 */
export function withoutDeletedContent<T extends { is_deleted?: boolean | null }>(message: T): T {
  if (message.is_deleted !== true) return message;
  const blank: Record<string, unknown> = { ...message };
  for (const field of TEXT_FIELDS) if (field in blank) blank[field] = '';
  for (const field of LIST_FIELDS) if (field in blank) blank[field] = [];
  for (const field of NULLED_FIELDS) if (field in blank) blank[field] = null;
  if ('metadata' in blank) blank.metadata = deletedMetadata(blank.metadata);
  return blank as T;
}
