/**
 * Code block with syntax highlighting via lowlight.
 *
 * Drop-in replacement for StarterKit's codeBlock. Callers should disable the
 * default in StarterKit (codeBlock: false) and add this instead. Includes
 * a curated set of common languages (lowlight's `common` bundle, ~35 langs).
 */
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { createLowlight, common } from 'lowlight';

const lowlight = createLowlight(common);

export const CodeBlock = CodeBlockLowlight.configure({
  lowlight,
  HTMLAttributes: { class: 'deft-code-block' },
  defaultLanguage: 'plaintext',
});
