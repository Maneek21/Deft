import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { HeartbeatSummaryTiles } from './heartbeat-summary-tiles';

test('W2-4: with no recorded cost the 24h cost tile is not shown', () => {
  const html = renderToStaticMarkup(<HeartbeatSummaryTiles summary={{ total_cents: 0, total_actions: 4, turn_count: 12 }} />);
  assert.doesNotMatch(html, /24h cost/);
  assert.doesNotMatch(html, /\$0\.00/);
  assert.match(html, /24h actions/);
  assert.match(html, /24h turns/);
});

test('W2-4: a recorded cost is shown', () => {
  const html = renderToStaticMarkup(<HeartbeatSummaryTiles summary={{ total_cents: 250, total_actions: 4, turn_count: 12 }} />);
  assert.match(html, /24h cost/);
  assert.match(html, /\$2\.50/);
});
