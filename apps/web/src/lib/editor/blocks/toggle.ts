/**
 * Toggle block — re-exports @tiptap/extension-details with Deft defaults.
 *
 * In TipTap v3, the single @tiptap/extension-details package exports all three
 * required nodes: Details (wrapper), DetailsSummary (clickable header),
 * DetailsContent (collapsible body).
 */
import { Details, DetailsSummary, DetailsContent } from '@tiptap/extension-details';

export const Toggle = Details.configure({
  HTMLAttributes: { class: 'deft-toggle' },
  persist: true,
  openClassName: 'deft-toggle-open',
});

export const ToggleSummary = DetailsSummary.configure({
  HTMLAttributes: { class: 'deft-toggle-summary' },
});

export const ToggleContent = DetailsContent.configure({
  HTMLAttributes: { class: 'deft-toggle-content' },
});
