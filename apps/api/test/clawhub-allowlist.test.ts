/**
 * Block 0.11 — parseVoltAgentMarkdown + bundled allowlist unit tests.
 *
 * Does not hit the network or the DB — pure parser + static data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVoltAgentMarkdown } from '../src/lib/clawhub-allowlist.js';
import { BUNDLED_ALLOWLIST } from '../src/lib/clawhub-bundled-allowlist.js';

test('parseVoltAgentMarkdown extracts bulleted skill entries', () => {
  const md = `
## Skills

- [firecrawl](https://clawhub.ai/skills/firecrawl) — Web scraping with JS rendering
- [slack](https://clawhub.ai/skills/slack) — Slack messaging via MCP

Stuff below that isn't a skill.
`;
  const parsed = parseVoltAgentMarkdown(md);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]!.slug, 'firecrawl');
  assert.match(parsed[0]!.description, /Web scraping/);
  assert.equal(parsed[1]!.slug, 'slack');
});

test('parseVoltAgentMarkdown tolerates em-dash and ascii-hyphen separators', () => {
  const md = `
- [alpha](https://clawhub.ai/skills/alpha) — em dash
- [beta](https://clawhub.ai/skills/beta) - ascii hyphen
`;
  const parsed = parseVoltAgentMarkdown(md);
  assert.equal(parsed.length, 2);
});

test('parseVoltAgentMarkdown ignores non-clawhub links', () => {
  const md = `
- [wiki](https://en.wikipedia.org/wiki/example) — not a skill
- [legit](https://clawhub.ai/skills/legit) — is a skill
`;
  const parsed = parseVoltAgentMarkdown(md);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.slug, 'legit');
});

test('parseVoltAgentMarkdown accepts asterisk bullets', () => {
  const md = `
* [asterisk-skill](https://clawhub.ai/skills/asterisk-skill) — demo
`;
  const parsed = parseVoltAgentMarkdown(md);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.slug, 'asterisk-skill');
});

test('bundled allowlist has at least 10 entries with distinct slugs', () => {
  assert.ok(BUNDLED_ALLOWLIST.length >= 10, 'expected >=10 bundled entries');
  const slugs = new Set(BUNDLED_ALLOWLIST.map((e) => e.slug));
  assert.equal(slugs.size, BUNDLED_ALLOWLIST.length, 'slugs must be distinct');
});

test('bundled allowlist entries all have description', () => {
  for (const e of BUNDLED_ALLOWLIST) {
    assert.ok(e.description && e.description.length > 0, `${e.slug} missing description`);
  }
});
