// Parse @mentions from message content
// Content format: "Hey <@userId|userName> check this out"
// Returns array of mentioned user IDs
// Also handle @here and @all

export function parseMentions(content: string): { userIds: string[]; here: boolean; all: boolean } {
  const userIds = new Set<string>();
  let here = false;
  let all = false;

  const mentionRegex = /<@([^|>]+)\|[^>]+>/g;
  let match;
  while ((match = mentionRegex.exec(content)) !== null) {
    userIds.add(match[1]!);
  }

  // TipTap thread composers can submit the mention node before the web
  // serializer converts it to the canonical <@id|name> marker.
  const htmlMentionRegex = /<span\b[^>]*\bdata-mention-uuid=(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gi;
  while ((match = htmlMentionRegex.exec(content)) !== null) {
    const userId = match[1] ?? match[2] ?? match[3];
    if (userId) userIds.add(userId);
  }

  if (content.includes('@here')) here = true;
  if (content.includes('@all')) all = true;

  return { userIds: Array.from(userIds), here, all };
}
