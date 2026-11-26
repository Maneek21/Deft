import type { JSONContent } from '@tiptap/core';
import { BLOCK_ID_TYPES } from './extensions';
import { ensureBlockIds } from './blocks';
import { markdownToJson } from './markdown';

export type BuiltInTemplateKey = 'meeting_notes' | 'spec' | 'one_on_one' | 'retro' | 'proposal' | 'handbook_page';

const sections = (...headings: string[]) => headings.map((heading) => `## ${heading}\n\n`).join('');
const actionItems = '## Action items\n\n- [ ] \n';

/** The built-in templates. Each one's headings are the sections people fill in; "Action items" is a task list. */
export const BUILT_IN_TEMPLATES: ReadonlyArray<{ key: BuiltInTemplateKey; title: string; markdown: string }> = [
  { key: 'meeting_notes', title: 'Meeting notes', markdown: `${sections('Attendees', 'Agenda', 'Notes', 'Decisions')}${actionItems}` },
  { key: 'spec', title: 'Spec', markdown: sections('Summary', 'Problem', 'Goals', 'Non-goals', 'Design', 'Open questions') },
  { key: 'one_on_one', title: '1:1', markdown: `${sections('Check-in', 'Topics', 'Feedback')}${actionItems}` },
  { key: 'retro', title: 'Retro', markdown: `${sections('What went well', "What didn't", 'Ideas')}${actionItems}` },
  { key: 'proposal', title: 'Proposal', markdown: sections('Overview', 'Scope', 'Timeline', 'Pricing', 'Next steps') },
  {
    key: 'handbook_page',
    title: 'Handbook page',
    markdown: `<div data-table-of-contents></div>\n\n${sections('Purpose', 'How it works', 'Who to ask', 'Related pages')}`,
  },
];

const blockIdTypes = new Set<string>(BLOCK_ID_TYPES);

/**
 * A copy of `json` with every block id dropped and a new one given to each
 * block, so a document made from a template shares no id with it.
 */
export function withFreshBlockIds(json: JSONContent): JSONContent {
  const strip = (node: JSONContent): JSONContent => {
    const copy: JSONContent = { ...node };
    if (blockIdTypes.has(node.type ?? '') && node.attrs) {
      const { id: _id, ...rest } = node.attrs;
      copy.attrs = rest;
    }
    if (node.content) copy.content = node.content.map(strip);
    return copy;
  };
  return ensureBlockIds(strip(json));
}

/** The built-in template's content: its Markdown as JSON, with fresh block ids on every call. */
export function templateJson(key: BuiltInTemplateKey): JSONContent {
  const template = BUILT_IN_TEMPLATES.find((candidate) => candidate.key === key);
  if (!template) throw new Error(`Unknown template ${key}`);
  return withFreshBlockIds(markdownToJson(template.markdown));
}
