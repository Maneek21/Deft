import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppIntegrationKnowledgeCitation } from './app-experience-knowledge-citation';

const href = '/apps/source/298a371b-9149-4047-803c-0f4cf8d7ba81';
const render = (source: Parameters<typeof AppIntegrationKnowledgeCitation>[0]) =>
  renderToStaticMarkup(createElement(AppIntegrationKnowledgeCitation, source));

test('Knowledge app citation renders the governed original source link and server label', () => {
  const html = render({ source_url: href, source_label: 'Connected app source' });
  assert.match(html, new RegExp(`href="${href}"`));
  assert.match(html, /Connected app source/);
  assert.doesNotMatch(html, /app_integration/);
});

test('Knowledge app citation keeps a clear retained-copy fallback when original access is unavailable', () => {
  for (const source_url of [null, undefined, '']) {
    const html = render({ source_url, source_label: 'App source' });
    assert.doesNotMatch(html, /<a\b|href=/);
    assert.match(html, /original access unavailable/);
  }
});

test('Knowledge app citation never links an external or malformed source URL', () => {
  for (const source_url of ['javascript:alert(1)', 'https://outside.test/apps/source/one', '//outside.test/', '/apps/source/not-an-id', href + '?account=other', href + '/extra']) {
    const html = render({ source_url });
    assert.doesNotMatch(html, /<a\b|href=/);
    assert.match(html, /original access unavailable/);
  }
});
