import test from 'node:test';
import assert from 'node:assert/strict';
import { placeChatMenu } from './chat-menu-placement';

test('measured chat menu stays above composer when full371px cannot fit', () => {
  const menu = placeChatMenu({ top: 270, bottom: 292, left: 1000, right: 1022 }, { top: 90, bottom: 481, left: 220, right: 1159 }, { top: 0, bottom: 612, left: 0, right: 1159 }, 176, 371);
  assert.ok(menu.top >= 98); assert.ok(menu.top + menu.maxHeight <= 473);
  assert.ok(menu.maxHeight < 371); assert.equal(menu.maxHeight, 175);
});
test('measured chat menu flips to full above fit and clamps small visual viewport width', () => {
  const up = placeChatMenu({ top: 500, bottom: 522, left: 700, right: 722 }, { top: 40, bottom: 580, left: 0, right: 800 }, { top: 0, bottom: 600, left: 0, right: 800 }, 176, 371);
  assert.equal(up.top, 123); assert.ok(up.maxHeight >= 371);
  const small = placeChatMenu({ top: 140, bottom: 160, left: 0, right: 20 }, { top: 0, bottom: 300, left: 0, right: 150 }, { top: 50, bottom: 250, left: 10, right: 140 }, 176, 371);
  assert.equal(small.width, 114); assert.equal(small.left, 18); assert.ok(small.top >= 58); assert.ok(small.top + small.maxHeight <= 242);
});
