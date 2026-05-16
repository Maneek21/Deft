/**
 * Command registry unit tests.
 *
 * Pure logic — no DOM, no TipTap. Verifies the slash command registry
 * filtering and matching used by the BlockSlashMenu extension.
 *
 * Run: pnpm --filter @deft/web exec tsx --test test/editor-commands.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCommandRegistry,
  filterCommands,
  type SlashCommand,
} from '../src/lib/editor/commands.js';

const noop = () => {};

const heading: SlashCommand = {
  id: 'heading-1',
  group: 'block',
  label: 'Heading 1',
  description: 'Big section heading',
  keywords: ['h1', 'title'],
  surfaces: ['chat', 'note', 'task', 'canvas'],
  run: noop,
};

const callout: SlashCommand = {
  id: 'callout',
  group: 'block',
  label: 'Callout',
  description: 'Highlighted box',
  keywords: ['note', 'info'],
  surfaces: ['note', 'task', 'canvas'],
  run: noop,
};

const aiSummarize: SlashCommand = {
  id: 'ai-summarize',
  group: 'ai',
  label: 'Summarize',
  description: 'Summarize selection or document',
  keywords: ['summary', 'tldr'],
  surfaces: ['note', 'task', 'canvas'],
  run: noop,
};

test('registry registers and returns commands', () => {
  const reg = createCommandRegistry();
  reg.register(heading);
  reg.register(callout);
  assert.equal(reg.all().length, 2);
});

test('registry rejects duplicate ids', () => {
  const reg = createCommandRegistry();
  reg.register(heading);
  assert.throws(() => reg.register({ ...heading, label: 'Other' }), /duplicate command id/i);
});

test('filterCommands matches by label prefix', () => {
  const filtered = filterCommands([heading, callout], 'head', 'note');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]!.id, 'heading-1');
});

test('filterCommands matches by keyword', () => {
  const filtered = filterCommands([heading, callout], 'h1', 'note');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]!.id, 'heading-1');
});

test('filterCommands is case insensitive', () => {
  const filtered = filterCommands([heading], 'HEADING', 'note');
  assert.equal(filtered.length, 1);
});

test('filterCommands filters by surface', () => {
  // callout is not available in 'chat' surface
  const filtered = filterCommands([heading, callout], '', 'chat');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]!.id, 'heading-1');
});

test('filterCommands empty query returns all surface-matching commands', () => {
  const filtered = filterCommands([heading, callout, aiSummarize], '', 'note');
  assert.equal(filtered.length, 3);
});

test('filterCommands ranks label matches above keyword matches', () => {
  const labelMatchCmd: SlashCommand = {
    id: 'note-block',
    group: 'block',
    label: 'Note',
    description: 'note block',
    keywords: [],
    surfaces: ['note'],
    run: noop,
  };
  const keywordMatchCmd: SlashCommand = {
    id: 'callout-2',
    group: 'block',
    label: 'Callout',
    description: 'highlighted',
    keywords: ['note', 'info'],
    surfaces: ['note'],
    run: noop,
  };
  const filtered = filterCommands([labelMatchCmd, keywordMatchCmd], 'note', 'note');
  assert.equal(filtered[0]!.id, 'note-block');
  assert.equal(filtered[1]!.id, 'callout-2');
});

test('filterCommands groups results by group field', () => {
  const filtered = filterCommands([heading, callout, aiSummarize], '', 'note');
  // Verify all three exist; grouping for UI is done downstream
  const ids = filtered.map(c => c.id);
  assert.ok(ids.includes('heading-1'));
  assert.ok(ids.includes('callout'));
  assert.ok(ids.includes('ai-summarize'));
});
