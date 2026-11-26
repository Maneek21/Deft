import assert from 'node:assert/strict';
import test from 'node:test';
import { legacyNoteId, legacyNotesHref, legacyNotesTarget, noteResultHref, resolveLegacyNote } from './legacy-notes-redirect';
import { bucketByDay, calNoteHref, type CalendarData } from './calendar';
import { createDocumentAndOpen, runThreadSlashCommand, THREAD_SLASH_COMMANDS } from './quick-actions';
import { forwardMenuCommand, interceptsBare, interceptsWithArgs, offersCommand } from './slash-command-gate';

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

// ── the redirect's lookup, against a mocked fetch ──

const reply = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('resolveLegacyNote: a mapped note gives its document, a 404, other refusals, a network error and a bad body give null', async () => {
  const asked: string[] = [];
  const client = (answer: () => Promise<Response>) => ({ get: (path: string) => { asked.push(path); return answer(); } });
  assert.equal(await resolveLegacyNote('n 1', client(async () => reply(200, { document_id: 'doc-9' }))), 'doc-9');
  assert.deepEqual(asked, ['/api/documents/by-legacy/note/n%201']);
  assert.equal(await resolveLegacyNote('n1', client(async () => reply(404, { error: 'Document not found', code: 'NOT_FOUND' }))), null);
  assert.equal(await resolveLegacyNote('n1', client(async () => reply(500, { error: 'x', code: 'X' }))), null);
  assert.equal(await resolveLegacyNote('n1', client(async () => { throw new TypeError('network down'); })), null);
  assert.equal(await resolveLegacyNote('n1', client(async () => reply(200, { document_id: 5 }))), null);
  assert.equal(await resolveLegacyNote('n1', client(async () => new Response('not json', { status: 200 }))), null);
});

// ── where each reader links, by where the id came from ──

test('calendar notes keep where they came from: documents open at /d/<id>, legacy notes go through /notes?id=', () => {
  const at = '2026-11-20T10:00:00.000Z';
  const item = (id: string) => ({ id, title: id, icon: null, created_at: at });
  const base = { tasks: [], events: [] };
  const notesOf = (data: CalendarData) => [...bucketByDay(data).values()].flatMap((bucket) => bucket.notes);

  const fromDocuments = notesOf({ ...base, documents: [item('doc-1')], notes: [] });
  assert.deepEqual(fromDocuments.map(calNoteHref), ['/d/doc-1']);

  const fromLegacy = notesOf({ ...base, notes: [item('n-1')] });
  assert.deepEqual(fromLegacy.map(calNoteHref), ['/notes?id=n-1']);

  const both = notesOf({ ...base, documents: [item('doc-1')], notes: [item('n-1')] });
  assert.deepEqual(both.map(calNoteHref).sort(), ['/d/doc-1', '/notes?id=n-1']);
});

test('palette note results link to the document when the API gave one, and through the redirect otherwise (keyboard and click use the same helper)', () => {
  assert.equal(noteResultHref({ id: 'doc-1', url: '/d/doc-1' }), '/d/doc-1');
  assert.equal(noteResultHref({ id: 'n-1' }), '/notes?id=n-1');
  assert.equal(noteResultHref({ id: 'n-1', url: null }), '/notes?id=n-1');
  assert.equal(noteResultHref({ id: 'n-1', url: 'https://evil.example/x' }), '/notes?id=n-1');
  assert.equal(noteResultHref({ id: 'n-1', url: '/d/a/b' }), '/notes?id=n-1');
});

// ── creating a document ──

type Call = { path: string; body?: unknown };
function fakeApi(answers: Record<string, () => Promise<Response> | Response>) {
  const calls: Call[] = [];
  return {
    calls,
    post: async (path: string, body?: unknown) => { calls.push({ path, body }); return answers[path]!(); },
  };
}
const router = () => { const pushed: string[] = []; return { pushed, push: (to: string) => { pushed.push(to); } }; };

test('createDocumentAndOpen makes a document in My drive and opens it', async () => {
  const api = fakeApi({ '/api/drives/mine': () => reply(200, { drive: { id: 'd1' } }), '/api/documents': () => reply(201, { document: { id: 'doc-5' } }) });
  const r = router();
  assert.deepEqual(await createDocumentAndOpen(api as never, r as never, '  Plan  '), { ok: true, id: 'doc-5' });
  assert.deepEqual(api.calls, [{ path: '/api/drives/mine', body: undefined }, { path: '/api/documents', body: { drive_id: 'd1', title: 'Plan' } }]);
  assert.deepEqual(r.pushed, ['/d/doc-5']);
});

test('createDocumentAndOpen returns a message for a paused workspace, a refusal, a server message and a network failure, and opens nothing', async () => {
  const cases: Array<[() => Response | Promise<Response>, string]> = [
    [() => reply(503, { error: 'paused', code: 'PAUSED' }), 'The workspace is paused right now. Try again when it resumes.'],
    [() => reply(403, { error: 'no', code: 'FORBIDDEN' }), "You can't create documents in your drive."],
    [() => reply(400, { error: 'Title too long', code: 'VALIDATION_ERROR' }), 'Title too long'],
    [() => { throw new TypeError('offline'); }, 'Could not reach the server. Check your connection and try again.'],
  ];
  for (const [fail, message] of cases) {
    const api = fakeApi({ '/api/drives/mine': () => reply(200, { drive: { id: 'd1' } }), '/api/documents': fail });
    const r = router();
    assert.deepEqual(await createDocumentAndOpen(api as never, r as never), { ok: false, message });
    assert.deepEqual(r.pushed, []);
  }
  const noDrive = fakeApi({ '/api/drives/mine': () => reply(503, { error: 'paused', code: 'PAUSED' }) });
  assert.equal((await createDocumentAndOpen(noDrive as never, router() as never)).ok, false);
});

test('concurrent createDocumentAndOpen calls share one creation, and a later call makes a new one', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const api = fakeApi({
    '/api/drives/mine': async () => { await gate; return reply(200, { drive: { id: 'd1' } }); },
    '/api/documents': () => reply(201, { document: { id: 'doc-1' } }),
  });
  const r = router();
  const first = createDocumentAndOpen(api as never, r as never);
  const second = createDocumentAndOpen(api as never, r as never);
  const third = createDocumentAndOpen(api as never, r as never);
  release();
  assert.deepEqual(await Promise.all([first, second, third]), [{ ok: true, id: 'doc-1' }, { ok: true, id: 'doc-1' }, { ok: true, id: 'doc-1' }]);
  assert.equal(api.calls.filter((call) => call.path === '/api/documents').length, 1);
  assert.deepEqual(r.pushed, ['/d/doc-1']);

  const again = await createDocumentAndOpen(api as never, r as never);
  assert.equal(again.ok, true);
  assert.equal(api.calls.filter((call) => call.path === '/api/documents').length, 2);
});

test('a failed creation clears the guard so the next try runs', async () => {
  let fail = true;
  const api = fakeApi({
    '/api/drives/mine': () => (fail ? reply(500, { error: 'boom', code: 'X' }) : reply(200, { drive: { id: 'd1' } })),
    '/api/documents': () => reply(201, { document: { id: 'doc-2' } }),
  });
  assert.equal((await createDocumentAndOpen(api as never, router() as never)).ok, false);
  fail = false;
  assert.deepEqual(await createDocumentAndOpen(api as never, router() as never), { ok: true, id: 'doc-2' });
});

test('a thread composer\'s /note creates a document; other commands say they belong to the main chat; a failure throws its message', async () => {
  const api = fakeApi({ '/api/drives/mine': () => reply(200, { drive: { id: 'd1' } }), '/api/documents': () => reply(201, { document: { id: 'doc-7' } }) });
  const r = router();
  await runThreadSlashCommand('note', 'Retro', { api: api as never, router: r as never });
  assert.deepEqual(api.calls[1], { path: '/api/documents', body: { drive_id: 'd1', title: 'Retro' } });
  assert.deepEqual(r.pushed, ['/d/doc-7']);

  // Any other command is left alone, as before F16: no rejection, no request.
  const callsBefore = api.calls.length;
  await runThreadSlashCommand('task', 'x', { api: api as never, router: r as never });
  assert.equal(api.calls.length, callsBefore);

  const refused = fakeApi({ '/api/drives/mine': () => reply(503, { error: 'paused', code: 'PAUSED' }) });
  await assert.rejects(runThreadSlashCommand('note', '', { api: refused as never, router: router() as never }), /paused/);
});

// ── what a thread composer acts on ──

test('in a thread only /note is intercepted: /task x and the other commands still submit as before', () => {
  const only = THREAD_SLASH_COMMANDS;
  assert.equal(interceptsWithArgs('note', only), true);
  for (const name of ['task', 'status', 'remind', 'mute', 'unmute', 'dnd', 'search']) {
    assert.equal(interceptsWithArgs(name, only), false, `/${name} x`);
  }
  for (const name of ['mute', 'unmute', 'dnd', 'search']) assert.equal(interceptsBare(name, only), false, `/${name}`);
  assert.equal(interceptsBare('note', only), false);
  // The main chat (no restriction) still intercepts the whole set.
  for (const name of ['remind', 'task', 'status', 'note', 'mute', 'unmute', 'dnd', 'search']) assert.equal(interceptsWithArgs(name), true);
  for (const name of ['mute', 'unmute', 'dnd', 'search']) assert.equal(interceptsBare(name), true);
  assert.equal(interceptsWithArgs('unknown', only), false);
  // The thread shows a New note button but no task draft button.
  assert.equal(offersCommand('note', only), true);
  assert.equal(offersCommand('task', only), false);
  assert.equal(offersCommand('task'), true);
});

test('a slash-menu command in a thread: others are ignored without calling the handler; /note failures are shown, not unhandled', async () => {
  const seen: string[] = [];
  const errors: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const handler = async (command: string, args: string) => { seen.push(`${command}:${args}`); throw new Error('paused'); };
    for (const name of ['mute', 'dnd', 'search']) forwardMenuCommand(handler, THREAD_SLASH_COMMANDS, name, '', (m) => errors.push(m));
    assert.equal(seen.length, 0);
    assert.equal(errors.length, 0);

    forwardMenuCommand(handler, THREAD_SLASH_COMMANDS, 'note', 'x', (m) => errors.push(m));
    forwardMenuCommand(() => { throw new Error('sync boom'); }, undefined, 'dnd', '', (m) => errors.push(m));
    forwardMenuCommand(undefined, undefined, 'dnd', '', (m) => errors.push(m));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(seen, ['note:x']);
    assert.deepEqual([...errors].sort(), ['paused', 'sync boom']);
    assert.equal(unhandled.length, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
