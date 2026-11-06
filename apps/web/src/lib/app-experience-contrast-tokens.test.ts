import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function token(css: string, selector: string, name: string): string {
  const start = css.indexOf(selector + ' {');
  const end = css.indexOf('}', start);
  const block = css.slice(start, end + 1);
  const match = block.match(new RegExp(name + ':\\s*(#[0-9a-fA-F]{6})'));
  if (!match) throw new Error(`${name} not found in ${selector}`);
  return match[1];
}
function lum(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const c = (x: number) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}
function contrast(fg: string, bg: string): number {
  const a = lum(fg), b = lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('muted record-form text meets 4.5:1 on its surface in both themes (UI-13)', () => {
  const css = readFileSync(fileURLToPath(new URL('../app/globals.css', import.meta.url)), 'utf8');
  for (const [selector, theme] of [[':root', 'dark'], ['.light', 'light']] as const) {
    const fg = token(css, selector, '--on-surface-variant');
    const bg = token(css, selector, '--surface');
    assert.ok(contrast(fg, bg) >= 4.5, `${theme}: ${contrast(fg, bg)}`);
  }
});
