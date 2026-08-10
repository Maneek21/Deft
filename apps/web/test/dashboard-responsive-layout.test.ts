import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStackedLayout, type StackedLayoutSource } from '../src/app/(app)/dashboard/grid/responsive-layout.js';

const sources: StackedLayoutSource[] = [
  { i: 'today', x: 0, y: 0, w: 8, h: 4, minH: 3 },
  { i: 'calendar', x: 8, y: 0, w: 4, h: 6, minH: 5 },
  { i: 'projects', x: 0, y: 9, w: 3, h: 4, minH: 3, maxH: 5 },
];

test('narrow dashboard layouts are full-width, stacked, and collision-free', () => {
  const layout = buildStackedLayout(sources, 2);

  assert.deepEqual(layout.map(({ i, x, y, w, minW, maxW }) => ({ i, x, y, w, minW, maxW })), [
    { i: 'today', x: 0, y: 0, w: 2, minW: 2, maxW: 2 },
    { i: 'calendar', x: 0, y: 4, w: 2, minW: 2, maxW: 2 },
    { i: 'projects', x: 0, y: 10, w: 2, minW: 2, maxW: 2 },
  ]);
});

test('saved narrow layouts preserve vertical order and clamp height bounds', () => {
  const layout = buildStackedLayout(sources, 4, [
    { i: 'projects', x: 0, y: 0, w: 1, h: 99 },
    { i: 'today', x: 2, y: 3, w: 1, h: 1 },
  ]);

  assert.deepEqual(layout.map(({ i, y, w, h }) => ({ i, y, w, h })), [
    { i: 'projects', y: 0, w: 4, h: 5 },
    { i: 'calendar', y: 5, w: 4, h: 6 },
    { i: 'today', y: 11, w: 4, h: 3 },
  ]);
});
