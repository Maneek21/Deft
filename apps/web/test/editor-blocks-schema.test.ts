/**
 * Schema-only tests for new block extensions.
 *
 * Uses TipTap's getSchema to verify our extensions register valid
 * ProseMirror node specs without requiring a DOM/editor instance.
 *
 * Run: pnpm --filter @deft/web exec tsx --test test/editor-blocks-schema.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { Callout } from '../src/lib/editor/blocks/callout.js';

const baseExtensions = [Document, Paragraph, Text];

test('Callout extension registers a block node', () => {
  const schema = getSchema([...baseExtensions, Callout]);
  const node = schema.nodes.callout;
  assert.ok(node, 'callout node should be present in schema');
  assert.equal(node.spec.group, 'block');
});

test('Callout node has an emoji attribute with a default', () => {
  const schema = getSchema([...baseExtensions, Callout]);
  const node = schema.nodes.callout;
  assert.ok(node.spec.attrs?.emoji, 'emoji attribute should exist');
  assert.equal(node.spec.attrs!.emoji!.default, '💡');
});

test('Callout node parses from a div[data-callout]', () => {
  const schema = getSchema([...baseExtensions, Callout]);
  const node = schema.nodes.callout;
  const parseRules = node.spec.parseDOM ?? [];
  assert.ok(parseRules.length > 0);
  const rule = parseRules[0]!;
  assert.equal(rule.tag, 'div[data-callout]');
});

import { Toggle, ToggleSummary, ToggleContent } from '../src/lib/editor/blocks/toggle.js';

test('Toggle extension registers details + summary + content nodes', () => {
  const schema = getSchema([...baseExtensions, Toggle, ToggleSummary, ToggleContent]);
  assert.ok(schema.nodes.details, 'details node should be registered');
  assert.ok(schema.nodes.detailsSummary, 'detailsSummary node should be registered');
  assert.ok(schema.nodes.detailsContent, 'detailsContent node should be registered');
});
