// Parse @mentions from message content
// Content format: "Hey <@userId|userName> check this out"
// Returns array of mentioned user IDs
// Also handle @here and @all

export function parseMentions(content: string): { userIds: string[]; here: boolean; all: boolean } {
  const userIds: string[] = [];
  let here = false;
  let all = false;

  const mentionRegex = /<@([^|>]+)\|[^>]+>/g;
  let match;
  while ((match = mentionRegex.exec(content)) !== null) {
    userIds.push(match[1]!);
  }

  if (content.includes('@here')) here = true;
  if (content.includes('@all')) all = true;

  return { userIds, here, all };
}
