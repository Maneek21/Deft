import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EXTRACTOR_SOURCE,
  extractLinkMetadata,
  extractLinkMetadataReference,
  linkPreviewExtractionStats,
} from '../src/lib/link-preview.js';

const URL_A = 'http://pub.test/a/b';
const SIZE = 512 * 1024;
const fill = (unit: string, tail = '') => unit.repeat(Math.floor((SIZE - tail.length) / unit.length)) + tail;
const extractFromSource = new Function(`${EXTRACTOR_SOURCE}; return extract;`)() as typeof extractLinkMetadataReference;

const PAGE = '<html><head><title>T</title><meta property="og:title" content="Hello">'
  + '<meta content="World" name="description"><link rel="icon" href="/fav.ico"></head></html>';
const heads = [
  '<meta property="og:title" content="A > B < C">',
  `<meta data-v1="content='Wrong'" property="og:title" content="Right">`,
  '<meta x1property="other" property="og:title" content="Right">',
  `<meta data-x="${'z'.repeat(5000)}" property="og:title" content="Long">`,
  `<title>${'t'.repeat(5000)}</title>`,
  "<META CONTENT='D' NAME='Description'>",
  '<link href="/i.png" rel="shortcut icon"><title>T</title>',
  '<title>İstanbul</title>',
  '<meta name="author" content="İ"><meta property="og:title" content="Right">',
  '<script>const t = "<title>";</script><title>Right</title>',
  '<title-widget>Ignore</title-widget><title>Right</title>',
  '<title>Right</title><meta property="og:title" content="Wrong',
  '<title>Right</title><link rel=icon href=//[>',
  '<meta property="og:image" content="http://x.test/i.png"><meta property="og:site_name" content=\'S\'><title>T</title>',
];
const longTags = `<meta ${'a'.repeat(4080)}>`.repeat(64) + `<meta ${'a1 '.repeat(1360)}>`.repeat(64);
const fixtures = [PAGE, PAGE + ' '.repeat(SIZE - PAGE.length), longTags, ...heads.map((h) => `<html><head>${h}</head></html>`)];

function seededPage(seed: number): string {
  let s = seed >>> 0;
  const rand = () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const tags = ['meta', 'META', 'Meta', 'title', 'TITLE', 'link', 'LINK', 'metadata', 'title-widget', 'script', 'style'];
  const names = ['property', 'name', 'content', 'rel', 'href', 'NAME', 'Content', 'data-property', 'x1property'];
  const values = ['og:title', 'og:description', 'og:image', 'og:site_name', 'description', 'Description', 'icon', 'shortcut icon',
    '/fav.ico', 'http://a.test/i.png', '//[', 'İstanbul', 'a > b', 'a < b', 'x', '', 'é漢字', '<title>', '</title>'];
  const quotes = ['"', "'", ''];
  const ends = ['>', '/>', ' >', '', '<', '"', "'"];
  const texts = ['Hello', ' ', '\n', 'Ünïcödé ✓', '</title>', '<!-- <title>c</title> -->', '</script>', '>', '<', '"', "'"];
  let html = '';
  const pieces = 1 + Math.floor(rand() * 12);
  for (let i = 0; i < pieces; i += 1) {
    if (rand() < 0.3) { html += pick(texts); continue; }
    html += `<${pick(tags)}`;
    const attrs = Math.floor(rand() * 4);
    for (let a = 0; a < attrs; a += 1) {
      const q1 = pick(quotes);
      const q2 = rand() < 0.85 ? q1 : pick(quotes);
      html += `${pick([' ', '', '\n'])}${pick(names)}=${q1}${pick(values)}${q2}`;
    }
    html += pick(ends);
    if (rand() < 0.4) html += pick(texts);
  }
  return html;
}

test('worker extraction source matches the reference on fixtures and 3,000 generated pages', () => {
  const pages = [...fixtures];
  for (let seed = 1; seed <= 3000; seed += 1) pages.push(seededPage(seed));
  let withResult = 0;
  for (const html of pages) {
    const expected = extractLinkMetadataReference(html, URL_A);
    assert.deepEqual(extractFromSource(html, URL_A), expected, html);
    if (expected) withResult += 1;
  }
  assert.ok(withResult > 300, `only ${withResult} pages produced a preview`);
});

test('worker extraction returns the reference result for every fixture', async () => {
  for (const html of fixtures) {
    assert.deepEqual(await extractLinkMetadata(html, URL_A), extractLinkMetadataReference(html, URL_A));
  }
});

const families: Record<string, string> = {
  'unterminated meta tags': fill('<meta'),
  'meta tags closed once at the end': fill('<meta ', '>'),
  'unterminated title tags': fill('<title'),
  'title tags closed once at the end': fill('<title ', '>'),
  'unterminated link tags': fill('<link'),
  'link tags closed once at the end': fill('<link ', '>'),
  'double quotes': fill('"'),
  'single quotes': fill("'"),
  'repeated og:title attribute in one tag': `<meta ${fill('property="og:title" ')}`,
  'repeated content attribute in one tag': `<meta ${fill('content="a" ')}`,
  'repeated name attribute in one tag': `<meta ${fill('name="description" ')}`,
  'repeated rel attribute in one tag': `<link ${fill('rel="icon" ')}`,
  'repeated href attribute in one tag': `<link ${fill('href="a" ')}`,
  'unterminated content values': fill('<meta content="'),
};

async function worstStall<T>(run: () => Promise<T>): Promise<{ worstMs: number; ticks: number; elapsed: number; result: T }> {
  let last = performance.now();
  let worstMs = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worstMs = Math.max(worstMs, now - last);
    last = now;
    ticks += 1;
  }, 5);
  await new Promise((r) => setTimeout(r, 30));
  const started = performance.now();
  const result = await run();
  const elapsed = performance.now() - started;
  await new Promise((r) => setTimeout(r, 30));
  clearInterval(timer);
  return { worstMs, ticks, elapsed, result };
}

for (const [name, html] of Object.entries(families)) {
  test(`extraction keeps the main thread responsive: ${name}`, async (t) => {
    const { worstMs, ticks, elapsed, result } = await worstStall(() => extractLinkMetadata(html, URL_A));
    t.diagnostic(`longest main-thread stall ${Math.round(worstMs)} ms, total ${Math.round(elapsed)} ms`);
    assert.ok(ticks > 5, `only ${ticks} ticks`);
    assert.ok(worstMs < 250, `main thread blocked for ${Math.round(worstMs)} ms`);
    assert.ok(elapsed < 4000, `took ${Math.round(elapsed)} ms`);
    assert.equal(result, null);
  });
}

test('large captured values in every field keep the main thread responsive', async () => {
  const value = `İ${'x'.repeat(SIZE - 200)}`;
  const html = `<meta property="og:title" property="og:description" property="og:image" property="og:site_name" content="${value}">`;
  const { worstMs, result } = await worstStall(() => extractLinkMetadata(html, URL_A));
  assert.ok(worstMs < 250, `main thread blocked for ${Math.round(worstMs)} ms`);
  assert.deepEqual(result, { url: URL_A, title: value, description: value, image: value, favicon: null, siteName: value });
});

async function idle(): Promise<void> {
  while (linkPreviewExtractionStats.pending > 0) await new Promise((r) => setTimeout(r, 10));
  assert.equal(linkPreviewExtractionStats.liveWorkers, 0);
  assert.equal(linkPreviewExtractionStats.maxLiveWorkers, 1);
}

test('a time-limited extraction ends its thread and the next page still previews', async () => {
  const started = performance.now();
  assert.equal(await extractLinkMetadata(families['unterminated meta tags']!, URL_A), null);
  assert.ok(performance.now() - started >= 2000, 'expected the time limit to end the extraction');
  assert.equal((await extractLinkMetadata(PAGE, URL_A))?.title, 'Hello');
  await idle();
});

test('extractions beyond the waiting limit get no preview without starting a thread', async () => {
  await idle();
  const runs = Array.from({ length: 17 }, () => extractLinkMetadata(PAGE, URL_A));
  const started = performance.now();
  assert.equal(await extractLinkMetadata(PAGE, URL_A), null);
  assert.ok(performance.now() - started < 100);
  for (const preview of await Promise.all(runs)) assert.equal(preview?.title, 'Hello');
  await idle();
});
