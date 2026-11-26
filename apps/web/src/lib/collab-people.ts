// Naming the people in a shared document (plan Task F12, rule C4). Awareness
// carries a user id and a colour, never a name (the server drops anything
// else: apps/api/src/collab/awareness.ts). Each viewer names people through
// their own members list, which the people rule has already filtered (a guest
// sees only the people they share a chat with); anyone else is "A
// collaborator", and their id is never shown.

export const HIDDEN_COLLABORATOR = 'A collaborator';

/** The name `names` gives `userId`, or HIDDEN_COLLABORATOR. */
export function collaboratorName(names: ReadonlyMap<string, string>, userId: unknown): string {
  return (typeof userId === 'string' ? names.get(userId) : undefined) ?? HIDDEN_COLLABORATOR;
}
