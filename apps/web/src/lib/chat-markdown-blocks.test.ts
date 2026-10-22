import test from 'node:test';
import assert from 'node:assert/strict';
import { splitChatMarkdownBlocks, escapeChatCode } from './chat-markdown-blocks';
test('fenced JSON adjacent to prose stays separate and multiple blocks retain text', () => {
  const blocks = splitChatMarkdownBlocks('Before\n```json\n{"role":"lead"}\n```\nAfter```html\n<script>&x</script>\n```');
  assert.deepEqual(blocks.map(block => block.kind), ['text', 'code', 'text', 'code']);
  assert.equal(blocks[1]!.text, '{"role":"lead"}');
  assert.equal(escapeChatCode(blocks[3]!.text), '&lt;script&gt;&amp;x&lt;/script&gt;');
  assert.equal(JSON.stringify(blocks).includes('%%CODEBLOCK_'), false);
});
