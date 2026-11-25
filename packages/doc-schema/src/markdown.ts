import { Extension, type AnyExtension, type JSONContent, type MarkdownToken } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { BLOCK_ID_COMMENT, ensureBlockIds } from './blocks';
import { emptyDocument, plainJson } from './convert';
import { HEADING_LEVELS, documentSchemaExtensions, getDocumentSchema } from './extensions';
import { htmlToJson, jsonToHtml } from './html';
import { Callout } from './nodes/callout';
import { DocumentImage } from './nodes/document-image';
import { NativeMention, isNativeMention, nativeMentionText } from './nodes/native-mention';
import { TableOfContents } from './nodes/table-of-contents';
import { TaskView } from './nodes/task-view';
import { Toggle } from './nodes/toggle';

/**
 * How Markdown maps to the document schema. TipTap's MarkdownManager does
 * the work headless (marked lexes; each extension parses and renders its
 * own syntax). The nodes Markdown has no syntax for are written as one-line
 * HTML blocks and read back through `htmlToJson`; a native mention is its
 * `[[deft:kind:id]]` token; an image of a Deft file is `![alt](deft-file:<id>)`.
 */

const FILE_SCHEME = 'deft-file:';
const MENTION_TOKEN = /^\[\[deft:([a-z_]+):([^\]\s]+)\]\]/;
/** Placeholder a parsed HTML block leaves behind: a block-id comment (`blockId`) or nothing to keep. */
const MARKER = 'deftMarkdownMarker';

/** An HTML block in Markdown must not contain a blank line, so newlines are written as character references. */
const oneLine = (html: string) => html.replace(/\r/g, '&#13;').replace(/\n/g, '&#10;');
const escapeAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const escapeImageText = (value: string) => value.replace(/([\\[\]])/g, '\\$1');

function calloutHtml(node: JSONContent): string {
  const id = typeof node.attrs?.id === 'string' ? ` data-id="${escapeAttribute(node.attrs.id)}"` : '';
  const emoji = escapeAttribute(String(node.attrs?.emoji ?? '💡'));
  return `<div data-callout="" data-emoji="${emoji}"${id}>${jsonToHtml({ type: 'doc', content: node.content ?? [] })}</div>`;
}

function imageMarkdown(node: JSONContent): string {
  const attrs = node.attrs ?? {};
  const target = attrs.fileId ? `${FILE_SCHEME}${attrs.fileId}` : String(attrs.src ?? '');
  const title = attrs.title ? ` "${String(attrs.title).replace(/"/g, '\\"')}"` : '';
  return `![${escapeImageText(String(attrs.alt ?? ''))}](${target}${title})`;
}

function imageFromToken(token: MarkdownToken): JSONContent {
  const href = String(token.href ?? '');
  const file = href.startsWith(FILE_SCHEME) ? href.slice(FILE_SCHEME.length) : null;
  return {
    type: 'image',
    attrs: { src: file ? null : href || null, alt: token.text || null, title: token.title || null, fileId: file || null },
  };
}

/** Block-level HTML: a block-id comment becomes a marker; anything else is read as HTML. */
function htmlBlockToJson(token: MarkdownToken): JSONContent | JSONContent[] {
  const html = String(token.text ?? token.raw ?? '').trim();
  const blockId = BLOCK_ID_COMMENT.exec(html)?.[1];
  if (blockId) return { type: MARKER, attrs: { blockId } };
  const content = htmlToJson(html).json.content ?? [];
  const nothingKept = content.length === 1 && content[0]!.type === 'paragraph' && !content[0]!.content?.length;
  return nothingKept ? { type: MARKER, attrs: { blockId: null } } : content;
}

const MarkdownHtmlBlocks = Extension.create({
  name: 'markdownHtmlBlocks',
  markdownTokenName: 'html',
  parseMarkdown: token => htmlBlockToJson(token),
});

function markdownExtensions(): AnyExtension[] {
  const htmlBlock = (node: JSONContent) => oneLine(jsonToHtml(node));
  const replacements = new Map<string, AnyExtension>([
    [Callout.name, Callout.extend({ renderMarkdown: node => oneLine(calloutHtml(node)) })],
    [Toggle.name, Toggle.extend({ renderMarkdown: htmlBlock })],
    [TaskView.name, TaskView.extend({ renderMarkdown: htmlBlock })],
    [TableOfContents.name, TableOfContents.extend({ renderMarkdown: htmlBlock })],
    [DocumentImage.name, DocumentImage.extend({ parseMarkdown: imageFromToken, renderMarkdown: imageMarkdown })],
    [NativeMention.name, NativeMention.extend({
      markdownTokenName: 'nativeMention',
      markdownTokenizer: {
        name: 'nativeMention',
        level: 'inline',
        start: src => src.indexOf('[[deft:'),
        tokenize: src => {
          const match = MENTION_TOKEN.exec(src);
          if (!match || !isNativeMention(match[1], match[2])) return undefined;
          return { type: 'nativeMention', raw: match[0], kind: match[1], id: match[2] };
        },
      },
      parseMarkdown: (token, helpers) => helpers.createNode('nativeMention', { kind: token.kind, id: token.id }),
      renderMarkdown: node => nativeMentionText(node.attrs?.kind, node.attrs?.id),
    })],
  ]);
  return [...documentSchemaExtensions().map(extension => replacements.get(extension.name) ?? extension), MarkdownHtmlBlocks];
}

let manager: MarkdownManager | null = null;

/** One manager per process: it registers its tokenizers on marked's shared instance. */
function markdownManager(): MarkdownManager {
  manager ??= new MarkdownManager({ extensions: markdownExtensions() });
  return manager;
}

/** Markdown for a block that renders to nothing, so its id line still names a block. */
function emptyBlockMarkdown(node: JSONContent): string {
  return node.type === 'heading' ? '#'.repeat(Number(node.attrs?.level) || 1) : '&nbsp;';
}

/**
 * The document as Markdown, top-level blocks separated by a blank line.
 * With `blockIds`, it runs `ensureBlockIds` on a copy first, so every
 * top-level block is preceded by its own `<!-- block:<id> -->` line, and an
 * empty block is kept (`&nbsp;` for a paragraph, `#` for a heading).
 * Without it, empty blocks are left out.
 */
export function jsonToMarkdown(json: JSONContent, opts: { blockIds?: boolean } = {}): string {
  const markdown = markdownManager();
  const source = opts.blockIds ? ensureBlockIds(json) : json;
  const parts: string[] = [];
  for (const node of source.content ?? []) {
    const body = markdown.serialize({ type: 'doc', content: [node] }).replace(/^\n+|\n+$/g, '');
    const id: unknown = node.attrs?.id;
    if (opts.blockIds && typeof id === 'string') parts.push(`<!-- block:${id} -->\n${body || emptyBlockMarkdown(node)}`);
    else if (body) parts.push(body);
  }
  return parts.join('\n\n');
}

const MAX_HEADING_LEVEL = Math.max(...HEADING_LEVELS);

/**
 * At any depth: drops markers and empty text nodes, and folds headings
 * deeper than the schema has (`####` and below) into its last level.
 */
function cleanParsed(nodes: JSONContent[]): JSONContent[] {
  return nodes.flatMap(node => {
    if (node.type === MARKER || (node.type === 'text' && !node.text)) return [];
    const tooDeep = node.type === 'heading' && Number(node.attrs?.level) > MAX_HEADING_LEVEL;
    const kept = tooDeep ? { ...node, attrs: { ...node.attrs, level: MAX_HEADING_LEVEL } } : node;
    return [kept.content ? { ...kept, content: cleanParsed(kept.content) } : kept];
  });
}

/**
 * Rebuilds the tree bottom-up, filling in content the schema requires around
 * what Markdown gave: a list item that starts with an image gets its leading
 * empty paragraph back.
 */
function fitToSchema(node: ProseMirrorNode): ProseMirrorNode {
  if (node.isLeaf || node.isTextblock) return node;
  const children: ProseMirrorNode[] = [];
  node.forEach(child => { children.push(fitToSchema(child)); });
  const content = Fragment.fromArray(children);
  if (node.type.validContent(content)) return node.copy(content);
  return node.type.createAndFill(node.attrs, content, node.marks) ?? node.copy(content);
}

/** Gives the block after each top-level block-id comment that id. */
function applyBlockIds(nodes: JSONContent[]): JSONContent[] {
  const out: JSONContent[] = [];
  let pendingId: string | null = null;
  for (const node of nodes) {
    if (node.type === MARKER) {
      if (typeof node.attrs?.blockId === 'string') pendingId = node.attrs.blockId;
      continue;
    }
    out.push(pendingId ? { ...node, attrs: { ...node.attrs, id: pendingId } } : node);
    pendingId = null;
  }
  return out;
}

/**
 * Moves block nodes out of the paragraph or heading that holds them (an
 * image written in the middle of a sentence), splitting the text around
 * them. The first piece of text keeps the block id.
 */
function liftBlocksOutOfTextblocks(nodes: JSONContent[]): JSONContent[] {
  const schema = getDocumentSchema();
  const isBlock = (child: JSONContent) => Boolean(child.type && schema.nodes[child.type]?.isInline === false);
  return nodes.flatMap(node => {
    if (!node.content) return [node];
    if (!(node.type && schema.nodes[node.type]?.isTextblock)) {
      return [{ ...node, content: liftBlocksOutOfTextblocks(node.content) }];
    }
    if (!node.content.some(isBlock)) return [node];
    const pieces: JSONContent[] = [];
    let inline: JSONContent[] = [];
    let idGiven = false;
    const flushText = () => {
      if (!inline.length) return;
      pieces.push({ ...node, attrs: idGiven ? { ...node.attrs, id: null } : node.attrs, content: inline });
      idGiven = true;
      inline = [];
    };
    for (const child of node.content) {
      if (isBlock(child)) {
        flushText();
        pieces.push(child);
      } else {
        inline.push(child);
      }
    }
    flushText();
    return pieces;
  });
}

/**
 * Reads Markdown into a document in the schema's canonical JSON form, fitted
 * to the schema (headings 1–3, required paragraphs filled in). Block-id
 * comments give the next top-level block its id; blocks without one keep a
 * null id (run `ensureBlockIds` to fill them).
 */
export function markdownToJson(markdown: string): JSONContent {
  const parsed = markdownManager().parse(markdown);
  const content = liftBlocksOutOfTextblocks(cleanParsed(applyBlockIds(parsed.content ?? [])));
  if (!content.length) return emptyDocument();
  return plainJson(fitToSchema(getDocumentSchema().nodeFromJSON({ type: 'doc', content })));
}
