import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SWRConfig } from 'swr';
import { audienceKey, PostingPrompt, type Audience } from './posting-prompt';

// The posting prompt (spec 5.3; plan Task F13): after posting a document,
// the poster alone sees how many people in the chat can't open it, and may
// share it with the chat. Its counts come from F9's
// GET /api/documents/:id/audience, cached under the signed-in session.

const DOCUMENT = 'doc-1';
const SPACE = 'space-1';
const SCOPE = 'org-1:user-a:session-a:0';

function markup(audience: Audience | undefined, options: { spaceName?: string; isDm?: boolean; scope?: string | null } = {}): string {
  const fallback = audience ? { [audienceKey(SCOPE, DOCUMENT, SPACE)!]: audience } : {};
  return renderToStaticMarkup(createElement(
    SWRConfig, { value: { fallback, provider: () => new Map() } },
    createElement(PostingPrompt, {
      sessionScope: options.scope === undefined ? SCOPE : options.scope,
      documentId: DOCUMENT, spaceId: SPACE, spaceName: options.spaceName ?? 'design', isDm: options.isDm ?? false, onClose: () => {},
    }),
  ));
}

/** The text a reader sees: tags dropped, entities decoded, no space before punctuation. */
function render(audience: Audience | undefined, options: { spaceName?: string; isDm?: boolean; scope?: string | null } = {}): string {
  return markup(audience, options).replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').replace(/ ([,.])/g, '$1').trim();
}

test('the posting prompt shows the counts and offers to share with the chat', () => {
  const text = render({ cannot_open: 8, guests: 1, can_share: true });
  assert.match(text, /Only visible to you/);
  assert.match(text, /8 people in #design can't open this, including 1 guest\./);
  assert.match(text, /Give #design/);
  assert.match(markup({ cannot_open: 8, guests: 1, can_share: true }), /<option value="comment" selected="">Can comment<\/option>/,
    'the role picker starts at comment');
  assert.match(text, /\bShare\b/);
  assert.match(text, /Don't share/);
  assert.match(render({ cannot_open: 5, guests: 2, can_share: true }), /5 people in #design can't open this, including 2 guests\./);
  assert.match(render({ cannot_open: 1, guests: 0, can_share: true }), /1 person in #design can't open this\./);
});

test('the posting prompt drops the guest clause when no guest is left out', () => {
  const text = render({ cannot_open: 3, guests: 0, can_share: true });
  assert.match(text, /3 people in #design can't open this\./);
  assert.doesNotMatch(text, /including|guest/);
});

test('in a DM the posting prompt speaks of this conversation', () => {
  const text = render({ cannot_open: 2, guests: 1, can_share: true }, { spaceName: 'Ana, Sam', isDm: true });
  assert.match(text, /2 people in this conversation can't open this\./);
  assert.doesNotMatch(text, /#|including/);
  assert.match(text, /Give this conversation/);
});

test('the posting prompt doesn’t render for someone who can’t share, when everyone can open it, or before the counts load', () => {
  assert.equal(render({ cannot_open: 8, guests: 1, can_share: false }), '');
  assert.equal(render({ cannot_open: 0, guests: 0, can_share: true }), '');
  assert.equal(render(undefined), '');
});

test('the audience is cached under the signed-in session: another session, or none, reads nothing of it', () => {
  const audience = { cannot_open: 8, guests: 1, can_share: true };
  assert.equal(render(audience, { scope: 'org-1:user-b:session-b:1' }), '');
  assert.equal(render(audience, { scope: null }), '');
  assert.equal(audienceKey(null, DOCUMENT, SPACE), null);
});
