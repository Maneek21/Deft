import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createEmailMetadataReader, emailMetadataInFolder, emailMetadataRelated} from './metadata-ui.mjs';

const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const metadata = (number, extra = {}) => ({record_id: uuid(number), data: {
  metadata_version: 'deft.email_message_metadata.v1', account_id: 'work', logical_message_id: `logical-${number}`,
  conversation_id: `thread-${number}`, label: `Subject ${number}`, subject: `Subject ${number}`,
  sender: 'Marigold Patel <marigold@example.test>', recipients: 'Diego Vargas <diego@example.test>', cc: '',
  date: new Date(2026, 0, number).toISOString(), seen: false, answered: false, flagged: false,
  in_inbox: true, in_sent: false, in_archive: false, folder_membership_complete: true,
  body_status: 'lazy', files_status: 'unknown', ...extra,
}});

async function start({records = [], read, list} = {}) {
  const views = [], calls = [], active = {count: 0, max: 0};
  let handler, finishOpening;
  const opened = new Promise(resolve => { finishOpening = resolve; });
  const sdk = {
    render(view) {
      const ids = new Set();
      const walk = node => { assert.ok(!ids.has(node.id), `Duplicate UI ID ${node.id}`); ids.add(node.id); node.children?.forEach(walk); };
      walk(view.root); view.navigation.forEach(walk); views.push(view);
      const nodes = collect(view);
      if (nodes.find(node => node.id === 'refresh')?.disabled === false) finishOpening();
    },
    onEvent(value) { handler = value; },
    async listResourceSummaries(key, options) {
      calls.push({kind: 'list', key, options});
      if (list) return list(options);
      const offset = Number(options.cursor || 0);
      return {items: records.slice(offset, offset + options.limit).map(row => ({record_id: row.record_id, label: row.data.subject.slice(0, 200)})), next_cursor: offset + options.limit < records.length ? String(offset + options.limit) : null};
    },
    async readResourceRecord(key, recordId) {
      calls.push({kind: 'read', key, recordId}); active.count++; active.max = Math.max(active.max, active.count);
      try { await Promise.resolve(); return read ? await read(recordId) : {item: records.find(row => row.record_id === recordId)}; }
      finally { active.count--; }
    },
  };
  const self = {};
  const code = readFileSync(new URL('./metadata-worker.mjs', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
  vm.runInNewContext(code, {self, createDeftExperienceSdk: () => sdk, createEmailMetadataReader,
    emailMetadataInFolder, emailMetadataRelated, Map, Set, Promise, Date, JSON});
  self.onmessage({data: {kind: 'start', port: {}, session_id: 'metadata-test'}});
  await opened;
  return {calls, active, view: () => views.at(-1), nodes: () => collect(views.at(-1)),
    node: id => collect(views.at(-1)).find(node => node.id === id), click: async node_id => handler({kind: 'click', node_id})};
}
function collect(view) { const nodes = []; const walk = node => { nodes.push(node); node.children?.forEach(walk); }; walk(view.root); return nodes; }

test('reads only scoped mail_index metadata and offers no legacy action or body/file locator', async () => {
  const ui = await start({records: [metadata(1, {body: '<script>active body</script>', resource_id: 'provider-locator', message_id: 'provider-parent', files_status: 'lazy'})]});
  assert.deepEqual(ui.calls.map(call => [call.kind, call.key]), [['list', 'mail_index'], ['read', 'mail_index']]);
  assert.equal(ui.calls[1].recordId, uuid(1));
  assert.match(ui.node('message_body_notice_0').text, /text has not been loaded.*unavailable/);
  assert.match(ui.node('message_files_notice_0').text, /Files have not been loaded.*unavailable/);
  assert.doesNotMatch(JSON.stringify(ui.view()), /active body|provider-locator|provider-parent/);
  assert.ok(ui.nodes().every(node => ['stack', 'text', 'button'].includes(node.kind)));
  assert.ok(ui.nodes().filter(node => node.kind === 'button').every(node => !/Reply|Archive|Compose|Download|Open files/.test(node.label)));
  assert.ok(ui.active.max <= 4);
});

test('record identity mismatch and a legacy metadata record fail closed with safe copy', async () => {
  const records = [metadata(1), metadata(2, {metadata_version: 'legacy'})];
  const ui = await start({records, read: id => ({item: id === uuid(1) ? {...records[0], record_id: uuid(99)} : records[1]})});
  assert.equal(ui.node('conversation_0'), undefined);
  assert.match(ui.node('status').text, /2 saved metadata records are unavailable/);
  assert.match(ui.node('empty_reader_help').text, /read-only preview/);
});

test('conversation includes loaded Sent metadata and isolates exact accounts and conversation IDs', async () => {
  const records = [metadata(6, {subject: 'Launch', conversation_id: 'launch'}),
    metadata(7, {subject: 'Re: Launch', conversation_id: 'launch', in_inbox: false, in_sent: true, sender: 'Diego Vargas <diego@example.test>', recipients: 'Marigold Patel <marigold@example.test>', seen: true}),
    metadata(1, {subject: 'Same provider conversation, different account', account_id: 'personal', conversation_id: 'launch'}),
    metadata(2, {subject: 'Launch', conversation_id: 'unrelated'})];
  const ui = await start({records});
  assert.match(ui.node('list_count').text, /3 loaded conversations/);
  assert.match(ui.node('conversation_0').description, /2 loaded messages.*Inbox and Sent/);
  assert.equal(ui.node('message_subject_0').text, 'Launch');
  assert.equal(ui.node('message_subject_1').text, 'Re: Launch');
  assert.equal(ui.node('message_subject_2'), undefined);
  assert.match(ui.node('conversation_coverage').text, /Complete conversation coverage is not confirmed/);
  await ui.click('folder_sent');
  assert.equal(ui.node('conversation_0').eyebrow, 'To: Marigold Patel');
  assert.match(ui.node('conversation_coverage').text, /2 loaded messages/);
});

test('unknown folder membership remains visible in All mail and does not imply an empty mailbox', async () => {
  const ui = await start({records: [metadata(1, {in_inbox: false, folder_membership_complete: false, date: 'not-a-date', seen: true, files_status: 'unknown'})]});
  assert.match(ui.node('empty_list').text, /No loaded conversations.*Other messages may exist/);
  assert.match(ui.node('folder_coverage').text, /Folder information is incomplete/);
  await ui.click('folder_all');
  assert.equal(ui.node('conversation_0').meta, '');
  assert.match(ui.node('message_date_0').text, /Date unavailable.*Read.*Folder unavailable/);
  assert.match(ui.node('message_files_notice_0').text, /Files have not been loaded.*unavailable/);
  assert.match(ui.node('index_coverage').text, /End of saved index.*Mailbox coverage is not confirmed/);
});

test('incremental index and list pagination are bounded and preserve honest loaded counts', async () => {
  const ui = await start({records: Array.from({length: 126}, (_, index) => metadata(index + 1))});
  assert.match(ui.node('list_count').text, /10 loaded conversations/);
  await ui.click('load_more');
  assert.match(ui.node('list_count').text, /20 loaded conversations/);
  assert.equal(ui.node('conversation_0').label, 'Subject 20');
  await ui.click('next_list'); assert.equal(ui.node('conversation_0').label, 'Subject 10');
  for (let index = 0; index < 8; index++) await ui.click('load_more');
  assert.equal(ui.calls.filter(call => call.kind === 'list').length, 10);
  assert.equal(ui.calls.filter(call => call.kind === 'read').length, 100);
  assert.equal(ui.node('load_more'), undefined);
  assert.match(ui.node('index_limit').text, /100 saved records across 10 pages.*Additional mail may exist/);
  assert.doesNotMatch(ui.node('index_coverage').text, /End of saved index/);
  assert.equal(ui.active.max, 4);
});

test('loaded conversation pagination keeps reader views bounded', async () => {
  const ui = await start({records: Array.from({length: 23}, (_, index) => metadata(index + 1, {conversation_id: 'large-conversation'}))});
  await ui.click('load_more'); await ui.click('load_more');
  assert.match(ui.node('conversation_coverage').text, /23 loaded messages/);
  assert.equal(ui.nodes().filter(node => node.id.startsWith('message_header_')).length, 10);
  await ui.click('next_conversation'); assert.equal(ui.node('message_subject_0').text, 'Subject 11');
  assert.match(ui.node('conversation_page_number').text, /Messages 11–20 of 23 loaded/);
  await ui.click('next_conversation'); assert.equal(ui.node('message_subject_0').text, 'Subject 21');
  assert.equal(ui.nodes().filter(node => node.id.startsWith('message_header_')).length, 3);
  assert.equal(ui.node('next_conversation'), undefined);
});

test('mobile selection and Back show one pane while folder changes preserve read-only metadata', async () => {
  const ui = await start({records: [metadata(1)]});
  assert.equal(ui.node('reader_panel').mobile, 'hidden'); assert.equal(ui.node('list_panel').mobile, undefined);
  await ui.click('conversation_0');
  assert.equal(ui.node('list_panel').mobile, 'hidden'); assert.equal(ui.node('reader_panel').mobile, undefined);
  await ui.click('back');
  assert.equal(ui.node('reader_panel').mobile, 'hidden'); assert.equal(ui.node('list_panel').mobile, undefined);
  await ui.click('folder_sent'); assert.match(ui.node('empty_list').text, /No loaded conversations in Sent/);
  await ui.click('folder_inbox'); assert.equal(ui.node('conversation_0').label, 'Subject 1');
  assert.equal(ui.calls.length, 2);
});

test('pagination cycles and empty advancing pages stop without pretending coverage is complete', async () => {
  const ui = await start({list: () => ({items: [], next_cursor: 'same-cursor'})});
  await ui.click('load_more');
  assert.equal(ui.node('load_more'), undefined); assert.match(ui.node('index_limit').text, /Additional mail may exist/);
  assert.doesNotMatch(ui.node('index_coverage').text, /End of saved index/);
  const empty = await start({list: ({cursor}) => ({items: [], next_cursor: String(Number(cursor || 0) + 1)})});
  for (let index = 0; index < 9; index++) await empty.click('load_more');
  assert.equal(empty.calls.length, 10); assert.equal(empty.node('load_more'), undefined);
});

test('resource failures disclose safe status and retry only on explicit Refresh', async () => {
  let requests = 0;
  const ui = await start({list: () => { requests++; throw Error('secret provider token and stack'); }});
  assert.equal(requests, 1); assert.match(ui.node('status').text, /Saved metadata could not be loaded/);
  assert.doesNotMatch(JSON.stringify(ui.view()), /secret provider token and stack/);
  await ui.click('refresh'); assert.equal(requests, 2);
});
