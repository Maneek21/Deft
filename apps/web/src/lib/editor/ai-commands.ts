/**
 * AI slash actions. Each command hits POST /api/ai/transform with a chosen
 * action; the result replaces the user's selection (or appends after the
 * cursor if no selection).
 */
import { api } from '@/lib/api';
import { slashRegistry, type SlashCommand, type SlashCommandContext } from './commands';

const DOC_SURFACES: SlashCommand['surfaces'] = ['note', 'task', 'canvas'];

async function runTransform(
  ctx: SlashCommandContext,
  action: 'summarize' | 'translate' | 'tone-formal' | 'tone-casual' | 'expand',
  loadingMessage: string,
  extra?: { target?: string },
): Promise<void> {
  const { editor, range } = ctx;

  // Remove the slash query first
  editor.chain().focus().deleteRange(range).run();

  const { from, to } = editor.state.selection;
  const hasSelection = from !== to;

  // Determine text to operate on
  const text = hasSelection
    ? editor.state.doc.textBetween(from, to, '\n')
    : editor.getText();

  if (!text.trim()) {
    return;
  }

  window.dispatchEvent(new CustomEvent('deft:ai-loading', { detail: { message: loadingMessage } }));

  try {
    const res = await api.post('/api/ai/transform', {
      action,
      text: text.slice(0, 20000),
      ...(extra || {}),
    });
    const data = await res.json();
    if (!res.ok) {
      window.dispatchEvent(new CustomEvent('deft:ai-toast', { detail: { kind: 'error', message: data.error || 'AI failed' } }));
      return;
    }

    if (hasSelection) {
      editor.chain().focus().deleteRange({ from, to }).insertContent(data.output).run();
    } else {
      editor.chain().focus().insertContentAt(editor.state.doc.content.size, `\n\n${data.output}`).run();
    }
  } catch {
    window.dispatchEvent(new CustomEvent('deft:ai-toast', { detail: { kind: 'error', message: 'Network error' } }));
  } finally {
    window.dispatchEvent(new CustomEvent('deft:ai-loading-done'));
  }
}

const aiCommands: SlashCommand[] = [
  {
    id: 'ai-summarize',
    group: 'ai',
    label: 'Summarize',
    description: 'Summarize selection or document',
    keywords: ['tldr', 'summary'],
    surfaces: DOC_SURFACES,
    iconName: 'Sparkles',
    run: (ctx) => runTransform(ctx, 'summarize', 'Summarizing…'),
  },
  {
    id: 'ai-translate',
    group: 'ai',
    label: 'Translate to English',
    description: 'Translate selection or document to English',
    keywords: ['translate', 'en'],
    surfaces: DOC_SURFACES,
    iconName: 'Languages',
    run: (ctx) => runTransform(ctx, 'translate', 'Translating…', { target: 'English' }),
  },
  {
    id: 'ai-tone-formal',
    group: 'ai',
    label: 'Make it formal',
    description: 'Rewrite in a formal tone',
    keywords: ['professional', 'formal'],
    surfaces: DOC_SURFACES,
    iconName: 'Briefcase',
    run: (ctx) => runTransform(ctx, 'tone-formal', 'Adjusting tone…'),
  },
  {
    id: 'ai-tone-casual',
    group: 'ai',
    label: 'Make it casual',
    description: 'Rewrite in a casual tone',
    keywords: ['informal', 'casual'],
    surfaces: DOC_SURFACES,
    iconName: 'Smile',
    run: (ctx) => runTransform(ctx, 'tone-casual', 'Adjusting tone…'),
  },
  {
    id: 'ai-expand',
    group: 'ai',
    label: 'Expand',
    description: 'Add detail and supporting points',
    keywords: ['elaborate', 'longer'],
    surfaces: DOC_SURFACES,
    iconName: 'Expand',
    run: (ctx) => runTransform(ctx, 'expand', 'Expanding…'),
  },
];

let registered = false;
export function registerAICommands() {
  if (registered) return;
  for (const cmd of aiCommands) slashRegistry.register(cmd);
  registered = true;
}
