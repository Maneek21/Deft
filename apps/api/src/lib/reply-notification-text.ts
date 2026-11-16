/**
 * "X replied to your message" notifications.
 *
 * The notification's body is the reply's text, but its link opens the parent
 * message. Since the reply's id is stored in `metadata.message_id`, the
 * notification follows the reply and is hidden once the reply is deleted
 * (lib/native-mention-visibility.ts). Rows written before that have no
 * `message_id`: nothing ties them to the reply, so nothing can tell whether
 * the reply still exists. Those rows keep their title and link and lose the
 * reply text, wherever a notification or the needs-you item made from it is
 * returned to a reader.
 */
export const REPLY_NOTIFICATION_TITLE_SUFFIX = ' replied to your message';

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

/** Returns the row unchanged unless it is a reply notice that names no reply; then its body is removed. */
export function withoutUnverifiableReplyText<T extends object>(row: T): T {
  const fields = row as Record<string, unknown>;
  if (typeof fields.title !== 'string' || !fields.title.endsWith(REPLY_NOTIFICATION_TITLE_SUFFIX)) return row;
  if (fields.body === null || fields.body === undefined) return row;
  const metadata = fields.metadata && typeof fields.metadata === 'object' && !Array.isArray(fields.metadata)
    ? fields.metadata as Record<string, unknown>
    : {};
  // A row that names its reply, and a newer-style mention delivery, are checked against their source instead.
  if (hasText(metadata.message_id) || hasText(metadata.native_mention_delivery_id)) return row;
  return { ...row, body: null };
}
