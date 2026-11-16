import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import manifest from '../app/manifest';
import { DEFT_THEME_COLOR } from './web-app-identity';

function enabledManifest() {
  const original = process.env.NEXT_PUBLIC_FEATURE_WEB_APP_INSTALL;
  process.env.NEXT_PUBLIC_FEATURE_WEB_APP_INSTALL = 'true';
  try { return manifest(); } finally {
    if (original === undefined) delete process.env.NEXT_PUBLIC_FEATURE_WEB_APP_INSTALL;
    else process.env.NEXT_PUBLIC_FEATURE_WEB_APP_INSTALL = original;
  }
}

test('install support defaults off for existing deployments', () => {
  const original = process.env.NEXT_PUBLIC_FEATURE_WEB_APP_INSTALL;
  delete process.env.NEXT_PUBLIC_FEATURE_WEB_APP_INSTALL;
  try { assert.deepEqual(manifest(), {}); } finally {
    if (original !== undefined) process.env.NEXT_PUBLIC_FEATURE_WEB_APP_INSTALL = original;
  }
});

function pngSize(path: URL): string {
  const bytes = readFileSync(path);
  assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG', `${path.pathname} is a PNG`);
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

test('the manifest makes Deft installable as a standalone app', () => {
  const value = enabledManifest();
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
  assert.equal(enabledManifest().theme_color, DEFT_THEME_COLOR);
});

test('every manifest icon exists and is declared at its real size only', () => {
  const icons = enabledManifest().icons ?? [];
  assert.ok(icons.length > 0);
  for (const size of ['192x192', '512x512']) {
    assert.ok(icons.some((icon) => icon.sizes === size && icon.purpose === 'any'));
  }
  assert.ok(icons.some((icon) => icon.sizes === '512x512' && icon.purpose === 'maskable'));
  for (const icon of icons) {
    assert.ok(icon.src.startsWith('/'), 'icons are same-origin paths (no address injection needed)');
    const file = new URL(`../../public${icon.src}`, import.meta.url);
    assert.equal(icon.sizes, pngSize(file));
    assert.equal(icon.type, 'image/png');
  }
});

test('the root layout carries the theme colour and Apple home-screen tags', () => {
  const layout = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8');
  assert.match(layout, /themeColor:.*DEFT_THEME_COLOR/);
  assert.match(layout, /appleWebApp:[\s\S]*capable:\s*true/);
  assert.match(layout, /name="apple-mobile-web-app-capable" content="yes"/);
  assert.match(layout, /rel="apple-touch-icon" href=\{DEFT_ICON_PATH\}/);
});

test('the service worker sits at the site root so its scope covers the start address', () => {
  const settings = readFileSync(new URL('../components/browser-notification-settings.tsx', import.meta.url), 'utf8');
  assert.match(settings, /serviceWorker\.register\('\/deft-sw\.js'\)/);
  readFileSync(new URL('../../public/deft-sw.js', import.meta.url), 'utf8');
});
