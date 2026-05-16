/**
 * Chat-only slash *commands* — side-effect items the chat surface used to
 * surface via the legacy `SlashCommandAutocomplete` popup. They live in the
 * unified slash menu now, but only at the very start of a message (see
 * `requireStartOfMessage`). On select, they delete the slash text and
 * delegate to the host React component via `ctx.chatCommand`.
 */
import { slashRegistry, type SlashCommand, type SlashCommandContext } from './commands';

const CHAT_ONLY: SlashCommand['surfaces'] = ['chat'];

/**
 * Module-level mirror of the currently-active space's mute state. Set by
 * `space-chat.tsx` whenever its `isMuted` changes; read by the
 * mute-toggle command to render the right label + dispatch the right action.
 *
 * We do this rather than threading a per-space context through the registry
 * because the slash registry is shared across all editor surfaces and only
 * one chat space is active at a time.
 */
let currentSpaceMuted = false;
export function setCurrentSpaceMuted(muted: boolean) {
  currentSpaceMuted = muted;
}

/**
 * Replace the slash query with `/<name> ` so the user can type arguments,
 * then press Enter — the chat composer's `handleSend` already parses
 * `/<name> <args>` and routes via `onSlashCommand`. Used by commands that
 * meaningfully take input (time/title/status emoji+text). No-arg commands
 * (mute, dnd, search, …) use `fire()` instead.
 */
function prefill(name: string) {
  return ({ editor, range }: SlashCommandContext) => {
    editor
      .chain()
      .focus()
      .deleteRange(range)
      .insertContent(`/${name} `)
      .run();
  };
}

/** Immediate-fire commands: no arguments make sense, dispatch right away. */
function fire(name: string) {
  return ({ editor, range, chatCommand }: SlashCommandContext) => {
    editor.chain().focus().deleteRange(range).run();
    chatCommand?.(name, '');
  };
}

const commands: SlashCommand[] = [
  {
    id: 'chat-remind',
    group: 'commands',
    label: 'Remind',
    description: 'Set a reminder — type a duration and message (e.g. 30m check email)',
    keywords: ['reminder', 'remember'],
    surfaces: CHAT_ONLY,
    iconName: 'Clock',
    requireStartOfMessage: true,
    run: prefill('remind'),
  },
  {
    id: 'chat-task',
    group: 'commands',
    label: 'Create task',
    description: 'Type the task title and press Enter',
    keywords: ['todo', 'issue', 'ticket'],
    surfaces: CHAT_ONLY,
    iconName: 'CheckSquare',
    requireStartOfMessage: true,
    run: prefill('task'),
  },
  {
    id: 'chat-note',
    group: 'commands',
    label: 'New note',
    description: 'Type the note title and press Enter',
    keywords: ['daily', 'jot'],
    surfaces: CHAT_ONLY,
    iconName: 'FileText',
    requireStartOfMessage: true,
    run: prefill('note'),
  },
  {
    id: 'chat-status',
    group: 'commands',
    label: 'Set status',
    description: 'Type an emoji + text (e.g. 🍕 Lunch)',
    keywords: ['away', 'presence'],
    surfaces: CHAT_ONLY,
    iconName: 'Smile',
    requireStartOfMessage: true,
    run: prefill('status'),
  },
  {
    id: 'chat-mute-toggle',
    group: 'commands',
    // Static label is used for filter matching only; the popup renders
    // `getLabel()` which flips based on the current mute state.
    label: 'Mute channel',
    description: 'Toggle channel notifications',
    keywords: ['silence', 'quiet', 'unmute', 'unsilence'],
    surfaces: CHAT_ONLY,
    iconName: 'BellOff',
    requireStartOfMessage: true,
    getLabel: () => (currentSpaceMuted ? 'Unmute channel' : 'Mute channel'),
    run: ({ editor, range, chatCommand }) => {
      editor.chain().focus().deleteRange(range).run();
      chatCommand?.(currentSpaceMuted ? 'unmute' : 'mute', '');
    },
  },
  {
    id: 'chat-dnd',
    group: 'commands',
    label: 'Toggle Do Not Disturb',
    description: 'Pause notifications',
    keywords: ['dnd', 'focus'],
    surfaces: CHAT_ONLY,
    iconName: 'Moon',
    requireStartOfMessage: true,
    run: fire('dnd'),
  },
  {
    id: 'chat-search',
    group: 'commands',
    label: 'Search everything',
    description: 'Open global search',
    keywords: ['find', 'lookup'],
    surfaces: CHAT_ONLY,
    iconName: 'Search',
    requireStartOfMessage: true,
    run: fire('search'),
  },
];

let registered = false;
export function registerChatCommands() {
  if (registered) return;
  for (const cmd of commands) slashRegistry.register(cmd);
  registered = true;
}
