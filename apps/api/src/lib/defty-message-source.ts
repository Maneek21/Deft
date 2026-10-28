export type DeftyMessageCitation = { type: 'message'; id: string; title: string; url: string };

/** Message citation metadata uses the renderer's safe title format; visible link labels may include commas. */
export function deftyMessageCitation(input: {
  id: string; spaceId: string; author: string; createdAt: Date;
}): DeftyMessageCitation {
  const author = input.author.replace(/,/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 450) || 'Message';
  return {
    type: 'message', id: input.id,
    title: `${author} · ${input.createdAt.toISOString()}`,
    url: `/chat?space=${encodeURIComponent(input.spaceId)}&message=${encodeURIComponent(input.id)}`,
  };
}
