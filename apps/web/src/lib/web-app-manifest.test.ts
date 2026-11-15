import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import manifest from '../app/manifest';
import { DEFT_THEME_COLOR } from './web-app-identity';

function pngSize(path: URL): string {
  const bytes = readFileSync(path);
  assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG', `${path.pathname} is a PNG`);
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

test('the manifest makes Deft installable as a standalone app', () => {
  const value = manifest();
  assert.equal(value.name, 'Deft');
  assert.equal(value.short_name, 'Deft');
  assert.equal(value.start_url, '/');
  assert.equal(value.scope, '/');
  assert.equal(value.display, 'standalone');
  assert.match(String(value.theme_color), /^#[0-9A-Fa-f]{6}$/);
  assert.match(String(value.background_color), /^#[0-9A-Fa-f]{6}$/);
});

test('the theme colour is the default dark surface from globals.css', () => {
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
  const root = css.slice(css.indexOf(':root {'), css.indexOf('.light {'));
  const surface = /--surface:\s*(#[0-9A-Fa-f]{6});/.exec(root)?.[1];
  assert.equal(surface?.toLowerCase(), DEFT_THEME_COLOR.toLowerCase());
  assert.equal(manifest().theme_color, DEFT_THEME_COLOR);
});

test('every manifest icon exists and is declared at its real size only', () => {
  const icons = manifest().icons ?? [];
  assert.ok(icons.length > 0);
  for (const icon of icons) {
    assert.ok(icon.src.startsWith('/'), 'icons are same-origin paths (no address injection needed)');
    const file = new URL(`../../public${icon.src}`, import.meta.url);
    assert.equal(icon.sizes, pngSize(file));
    assert.equal(icon.type, 'image/png');
  }
});

test('the root layout carries the theme colour and Apple home-screen tags', () => {
  const layout = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8');
  assert.match(layout, /themeColor:\s*DEFT_THEME_COLOR/);
  assert.match(layout, /appleWebApp:\s*\{[^}]*capable:\s*true/);
  assert.match(layout, /name="apple-mobile-web-app-capable" content="yes"/);
  assert.match(layout, /rel="apple-touch-icon" href=\{DEFT_ICON_PATH\}/);
});

test('the service worker sits at the site root so its scope covers the start address', () => {
  const settings = readFileSync(new URL('../components/browser-notification-settings.tsx', import.meta.url), 'utf8');
  assert.match(settings, /serviceWorker\.register\('\/deft-sw\.js'\)/);
  readFileSync(new URL('../../public/deft-sw.js', import.meta.url), 'utf8');
});
