// Which typed or menu slash commands a composer acts on (plan Task F16). A
// composer with an `onSlashCommand` handles the whole set; one given `only`
// (a thread composer: just `note`) acts on those and leaves every other
// command exactly as if there were no handler (posted as text, or ignored).

export const ARG_COMMANDS = ['remind', 'task', 'status', 'note', 'mute', 'unmute', 'dnd', 'search'] as const;
export const BARE_COMMANDS = ['mute', 'unmute', 'dnd', 'search'] as const;

const permitted = (name: string, only?: readonly string[]) => !only || only.includes(name);

/** `/name args…` typed and sent: does the composer run it instead of posting it? */
export function interceptsWithArgs(name: string, only?: readonly string[]): boolean {
  return (ARG_COMMANDS as readonly string[]).includes(name) && permitted(name, only);
}

/** `/name` typed and sent with nothing after it. */
export function interceptsBare(name: string, only?: readonly string[]): boolean {
  return (BARE_COMMANDS as readonly string[]).includes(name) && permitted(name, only);
}

/** The composer's action buttons (Create task draft, New note) show only for commands it acts on. */
export function offersCommand(name: string, only?: readonly string[]): boolean {
  return permitted(name, only);
}

/**
 * A command picked from the slash menu. Nothing happens for a command this
 * composer doesn't act on; a rejection or throw from the handler goes to
 * `onError` instead of becoming an unhandled rejection.
 */
export function forwardMenuCommand(
  handler: ((command: string, args: string) => void | Promise<void>) | undefined,
  only: readonly string[] | undefined,
  name: string,
  args: string,
  onError: (message: string) => void,
): void {
  if (!handler || !permitted(name, only)) return;
  const fail = (error: unknown) => onError(error instanceof Error ? error.message : 'Failed to run command');
  try {
    void Promise.resolve(handler(name, args)).catch(fail);
  } catch (error) {
    fail(error);
  }
}
