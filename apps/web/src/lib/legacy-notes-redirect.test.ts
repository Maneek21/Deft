import assert from 'node:assert/strict';
import test from 'node:test';
import { legacyNoteId, legacyNotesHref, legacyNotesTarget } from './legacy-notes-redirect';

// Old /notes links (plan Task F16): the page asks the API where the note went
// and sends the person to the document, or to Drive when it is not mapped.

test('legacyNotesTarget sends ?id= to /d/<id> when mapped and to /drive otherwise', () => {
  assert.equal(legacyNotesTarget(new URLSearchParams('id=n1'), 'doc-1'), '/d/doc-1');
  assert.equal(legacyNotesTarget(new URLSearchParams('id=n1'), null), '/drive');
  assert.equal(legacyNotesTarget(new URLSearchParams(''), null), '/drive');
  assert.equal(legacyNotesTarget(new URLSearchParams(''), 'doc-1'), '/drive');
  assert.equal(legacyNotesTarget(new URLSearchParams('id=n1'), 'a b/c'), '/d/a%20b%2Fc');
});

test('?note= resolves like ?id=', () => {
  assert.equal(legacyNoteId(new URLSearchParams('note=n2')), 'n2');
  assert.equal(legacyNoteId(new URLSearchParams('id=n1&note=n2')), 'n1');
  assert.equal(legacyNotesTarget(new URLSearchParams('note=n2'), 'doc-2'), '/d/doc-2');
  assert.equal(legacyNotesTarget(new URLSearchParams('note=n2'), null), '/drive');
});

test('legacyNotesHref builds the old link the redirect resolves', () => {
  assert.equal(legacyNotesHref('n 1'), '/notes?id=n%201');
});
