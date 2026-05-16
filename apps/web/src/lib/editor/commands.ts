/**
 * Slash command registry. Pure data + filter functions.
 *
 * Commands are insertion or action affordances offered by the BlockSlashMenu.
 * Each command declares which editor surfaces it appears in.
 */
import type { Editor, Range } from '@tiptap/core';

export type EditorSurface = 'chat' | 'note' | 'task' | 'task-comment' | 'canvas';
export type CommandGroup = 'commands' | 'block' | 'ai' | 'insert';

/**
 * Callback for chat-only "command" items (mute, remind, task, etc.) — they
 * fire side effects in the host React component rather than transforming the
 * editor's document. Block/AI commands ignore this.
 */
export type ChatCommandHandler = (name: string, args: string) => void;

export type SlashCommandContext = {
  editor: Editor;
  range: Range;
  surface: EditorSurface;
  chatCommand?: ChatCommandHandler;
};

export type SlashCommand = {
  id: string;
  group: CommandGroup;
  label: string;
  description: string;
  /** Aliases the user can type to match this command */
  keywords: string[];
  /** Surfaces this command is available in */
  surfaces: EditorSurface[];
  /** Lucide icon name (rendered by the popup component); optional */
  iconName?: string;
  /**
   * Optional dynamic label override evaluated at render time. Used by
   * context-sensitive commands (e.g. "Mute channel" / "Unmute channel"
   * collapses to one entry whose label flips with the current state).
   * The static `label` is still used for filter matching and as a
   * fallback when `getLabel` returns falsy.
   */
  getLabel?: () => string;
  /**
   * If true, this command only appears when the slash is at the very start of
   * the editor content. Used by chat-level action commands (mute, dnd, etc.)
   * which only make sense when the whole message is the command.
   */
  requireStartOfMessage?: boolean;
  /** Invoked when the user selects the command */
  run: (ctx: SlashCommandContext) => void | Promise<void>;
};

export type CommandRegistry = {
  register: (cmd: SlashCommand) => void;
  all: () => SlashCommand[];
  forSurface: (surface: EditorSurface) => SlashCommand[];
};

export function createCommandRegistry(): CommandRegistry {
  const byId = new Map<string, SlashCommand>();
  return {
    register(cmd) {
      if (byId.has(cmd.id)) {
        throw new Error(`Duplicate command id: ${cmd.id}`);
      }
      byId.set(cmd.id, cmd);
    },
    all() {
      return Array.from(byId.values());
    },
    forSurface(surface) {
      return Array.from(byId.values()).filter(c => c.surfaces.includes(surface));
    },
  };
}

/**
 * Filter and rank commands for a given query and surface.
 * Ranking: label-prefix match > label-substring > keyword match.
 */
export function filterCommands(
  commands: SlashCommand[],
  query: string,
  surface: EditorSurface,
  opts: { isStartOfMessage?: boolean } = {},
): SlashCommand[] {
  const q = query.trim().toLowerCase();
  const atStart = opts.isStartOfMessage ?? false;
  const surfaceCmds = commands.filter(c => {
    if (!c.surfaces.includes(surface)) return false;
    if (c.requireStartOfMessage && !atStart) return false;
    return true;
  });
  if (!q) return surfaceCmds;

  const scored: Array<{ cmd: SlashCommand; score: number }> = [];
  for (const cmd of surfaceCmds) {
    const label = cmd.label.toLowerCase();
    let score = 0;
    if (label.startsWith(q)) score = 3;
    else if (label.includes(q)) score = 2;
    else if (cmd.keywords.some(k => k.toLowerCase().includes(q))) score = 1;
    if (score > 0) scored.push({ cmd, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.cmd);
}

/** Module-level singleton registry (shared across surfaces). */
export const slashRegistry = createCommandRegistry();
