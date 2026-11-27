import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DocumentHeader, EditedLine, type DocRole } from './document-header';

const noop = () => {};
const render = (role: DocRole, over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(DocumentHeader, {
  title: 'Checkout redesign',
  breadcrumb: [
    { type: 'drive', id: 'd-eng', title: 'Engineering' },
    { type: 'folder', id: 'f-specs', title: 'Specs' },
    { type: 'document', id: 'doc-1', title: 'Checkout redesign' },
  ],
  role,
  presence: [{ key: '7', name: 'Sam Lee', color: '#2563eb' }, { key: '9', name: 'Ana', color: '#db2777' }],
  status: null,
  onHistory: noop,
  onShare: noop,
  onCopyLink: noop,
  onMove: noop,
  onDelete: noop,
  ...over,
}));

const has = (markup: string, label: string) => new RegExp(`>\\s*(?:<[^>]+>\\s*)*${label}\\s*<`).test(markup);

test('the header hides History and Share for a viewer and hides Share for a commenter', () => {
  const viewer = render('view');
  assert.equal(has(viewer, 'History'), false, 'a viewer has no History');
  assert.equal(has(viewer, 'Share'), false, 'a viewer has no Share');
  const commenter = render('comment');
  assert.equal(has(commenter, 'Share'), false, 'a commenter has no Share');
  assert.equal(has(commenter, 'History'), false, 'history needs edit (spec 5.6)');
  for (const role of ['edit', 'full'] as const) {
    const markup = render(role);
    assert.equal(has(markup, 'History'), true, `${role} has History`);
    assert.equal(has(markup, 'Share'), true, `${role} has Share`);
  }
  // Everyone keeps the ⋯ menu (copy link at least) and sees who is here.
  for (const role of ['view', 'comment', 'edit'] as const) {
    const markup = render(role);
    assert.match(markup, /aria-label="More actions"/);
    assert.match(markup, /title="Sam Lee"/);
    assert.match(markup, /title="Ana"/);
  }
});

test('the breadcrumb links the drive and parent pages, and shows hidden ancestors as plain "Shared with you"', () => {
  const markup = render('view', {
    breadcrumb: [
      { type: 'shared', title: 'Shared with you' },
      { type: 'document', id: 'doc-parent', title: 'Payments' },
      { type: 'document', id: 'doc-1', title: 'Checkout redesign' },
    ],
  });
  assert.match(markup, /Shared with you/);
  assert.doesNotMatch(markup, /href="[^"]*shared/i, 'no link for a hidden ancestor');
  assert.match(markup, /href="\/d\/doc-parent"/);
  assert.doesNotMatch(markup, /href="\/d\/doc-1"/, 'the page itself is not a link');
  const drive = render('edit');
  assert.match(drive, /href="\/drive\/d-eng"/);
});

test('"Edited {time} by {name}" names the editor only when the viewer may see them', () => {
  const recent = new Date(Date.now() - 2 * 60_000).toISOString();
  assert.match(renderToStaticMarkup(createElement(EditedLine, { at: recent, by: 'Ana' })), /Edited 2m ago by Ana/);
  const hidden = renderToStaticMarkup(createElement(EditedLine, { at: recent, by: null }));
  assert.match(hidden, /Edited 2m ago/);
  assert.doesNotMatch(hidden, / by /);
  assert.equal(renderToStaticMarkup(createElement(EditedLine, { at: null, by: 'Ana' })), '');
});
