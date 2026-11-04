import assert from 'node:assert/strict';
import test from 'node:test';
import { EXPERIENCE_ICON_PATHS, EXPERIENCE_RENDERER_CSS } from './app-experience-renderer';
import { DEFT_EXPERIENCE_ICONS } from '../../../../packages/app-kit/src/experience-menu';

test('every Kit icon name has exactly one Host path', () => {
  assert.deepEqual(Object.keys(EXPERIENCE_ICON_PATHS).sort(), [...DEFT_EXPERIENCE_ICONS].sort());
  for (const [name, d] of Object.entries(EXPERIENCE_ICON_PATHS)) assert.ok(d.trim().length > 0, name);
});

test('every subpath starts with an absolute move', () => {
  for (const [name, d] of Object.entries(EXPERIENCE_ICON_PATHS)) {
    assert.match(d, /^M/, name);
    assert.doesNotMatch(d, /\s m/, name);
  }
});

test('read, unread and mail are distinct shapes', () => {
  const { mail, read, unread } = EXPERIENCE_ICON_PATHS;
  assert.equal(new Set([mail, read, unread]).size, 3);
});

test('icons use a 1.5 stroke and icon-only toolbar buttons are muted when idle', () => {
  assert.match(EXPERIENCE_RENDERER_CSS, /\.ex-icon \{[^}]*stroke-width:1\.5/);
  assert.match(EXPERIENCE_RENDERER_CSS, /\[data-icon=print\]\) \{[^}]*color:var\(--on-surface-variant\)/);
  assert.match(EXPERIENCE_RENDERER_CSS, /:hover[^{]*\{ color:var\(--on-surface\) \}/);
});
