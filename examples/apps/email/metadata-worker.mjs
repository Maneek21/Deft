import {createDeftExperienceSdk} from '@deft/app-kit/experience';
import {createEmailMetadataReader, emailMetadataInFolder, emailMetadataRelated} from './metadata-ui.mjs';

// This separate experience reads saved metadata only. Provider access and the
// selected account binding stay behind the current scoped host resource route.
self.onmessage = event => {
  if (event.data?.kind !== 'start' || !event.data.port) return;
  self.onmessage = null;
  const sdk = createDeftExperienceSdk(event.data.port, event.data.session_id);
  const reader = createEmailMetadataReader(sdk);
  const cache = new Map(), cursors = new Set();
  const indexLimit = 100, pageSize = 10;
  let busy = true, folder = 'inbox', mobilePane = 'list', selectedId = null;
  let nextCursor = null, examined = 0, pagesRead = 0, ended = false, limited = false, unavailable = 0;
  let listPage = 0, conversationPage = 0, status = '';

  const compact = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const text = (id, value, tone = 'default') => ({kind: 'text', id, text: String(value).slice(0, 4096), tone});
  const stack = (id, children, options = {}) => ({kind: 'stack', id, children, ...options});
  const button = (id, label, variant = 'secondary', options = {}) => ({kind: 'button', id,
    label: compact(label, 128), variant, disabled: busy,
    ...(['refresh', 'back'].includes(id) ? {icon: id} : {}), ...options});
  const title = () => ({all: 'All mail', inbox: 'Inbox', sent: 'Sent', archive: 'Archive'})[folder];
  const dateValid = mail => Number.isFinite(Date.parse(mail.date));
  const dateNumber = mail => dateValid(mail) ? Date.parse(mail.date) : -Infinity;
  const shortDate = mail => dateValid(mail) ? new Date(mail.date).toLocaleDateString(undefined, {month: 'short', day: 'numeric'}) : '';
  const mailboxDisplay = value => {
    const name = /^(?:"([^"]*)"|([^<>,]+))\s*<[^<>\s]+@[^<>\s]+>$/.exec(value || '');
    return compact(name?.[1] || name?.[2] || value, 128);
  };
  const sender = mail => folder === 'sent' ? `To: ${mailboxDisplay(mail.recipients) || 'Recipient unavailable'}` : mailboxDisplay(mail.sender) || 'Sender unavailable';
  const allRows = () => [...cache.values()];
  const conversation = row => emailMetadataRelated(row.mail, allRows().map(item => item.mail))
    .map(mail => allRows().find(item => item.mail === mail))
    .sort((a, b) => dateNumber(a.mail) - dateNumber(b.mail) || a.record_id.localeCompare(b.record_id));
  const groups = () => {
    const result = new Map();
    for (const row of allRows()) {
      if (folder !== 'all' && !emailMetadataInFolder(row.mail, folder)) continue;
      const key = JSON.stringify([row.mail.account_id, row.mail.conversation_id]);
      const prior = result.get(key);
      if (!prior || dateNumber(row.mail) > dateNumber(prior.mail)) result.set(key, row);
    }
    return [...result.values()].sort((a, b) => dateNumber(b.mail) - dateNumber(a.mail) || a.record_id.localeCompare(b.record_id));
  };
  const selectFirst = () => { selectedId = groups()[0]?.record_id ?? null; conversationPage = 0; };

  function render() {
    const indexedGroups = groups(), rows = indexedGroups.slice(listPage * pageSize, (listPage + 1) * pageSize);
    const selected = cache.get(selectedId), related = selected ? conversation(selected) : [];
    const navigation = ['all', 'inbox', 'sent', 'archive'].map(key => button(`folder_${key}`,
      ({all: 'All mail', inbox: 'Inbox', sent: 'Sent', archive: 'Archive'})[key], 'ghost', {selected: folder === key}));
    const list = [
      stack('list_heading', [text('folder_title', title()), text('list_count', `${indexedGroups.length} loaded ${indexedGroups.length === 1 ? 'conversation' : 'conversations'}`, 'caption')], {layout: 'toolbar'}),
      text('index_coverage', `${cache.size} loaded ${cache.size === 1 ? 'message' : 'messages'} · ${ended ? 'End of saved index' : limited ? 'Loaded index limit reached' : 'More saved metadata may be available'}. Mailbox coverage is not confirmed.`, 'caption'),
      ...([...cache.values()].some(row => !row.mail.folder_membership_complete) ? [text('folder_coverage', 'Folder information is incomplete. All mail includes every loaded record.', 'caption')] : []),
      stack('conversation_rows', rows.length ? rows.map((row, index) => {
        const thread = conversation(row), unread = thread.some(item => item.mail.seen === false);
        const starred = thread.some(item => item.mail.flagged === true);
        const sent = thread.some(item => item.mail.in_sent), inbox = thread.some(item => item.mail.in_inbox);
        return button(`conversation_${index}`, row.mail.subject || '(No subject)', 'list', {
          eyebrow: sender(row.mail),
          meta: compact([shortDate(row.mail), unread ? 'Unread' : '', starred ? 'Starred' : ''].filter(Boolean).join(' · '), 80),
          description: `${thread.length} loaded ${thread.length === 1 ? 'message' : 'messages'}${sent && inbox ? ' · Inbox and Sent' : ''} · Text not loaded`,
          selected: !!selected && row.mail.account_id === selected.mail.account_id && row.mail.conversation_id === selected.mail.conversation_id,
        });
      }) : [text('empty_list', busy ? 'Loading saved metadata…' : folder === 'all' ? 'No readable metadata in the loaded index.' : `No loaded conversations in ${title()}. Other messages may exist.`, 'muted')], {layout: 'list'}),
      ...(indexedGroups.length > pageSize ? [stack('list_pages', [
        ...(listPage > 0 ? [button('previous_list', 'Previous', 'ghost')] : []),
        text('list_page_number', `Page ${listPage + 1} of loaded conversations`, 'caption'),
        ...((listPage + 1) * pageSize < indexedGroups.length ? [button('next_list', 'Next', 'ghost')] : []),
      ], {layout: 'horizontal'})] : []),
      ...(nextCursor && !limited ? [button('load_more', 'Load more saved messages', 'ghost')] : []),
      ...(limited ? [text('index_limit', `This view reads at most ${indexLimit} saved records across 10 pages. Additional mail may exist.`, 'caption')] : []),
    ];
    const detail = [stack('mobile_back', [button('back', `Back to ${title()}`, 'ghost')], {mobile: 'only'})];
    if (selected) {
      const visible = related.slice(conversationPage * pageSize, (conversationPage + 1) * pageSize);
      detail.push(text('conversation_subject', selected.mail.subject || '(No subject)', 'heading'),
        text('conversation_coverage', `${related.length} loaded ${related.length === 1 ? 'message' : 'messages'} in this conversation. Complete conversation coverage is not confirmed.`, 'caption'));
      for (const [index, row] of visible.entries()) {
        const mail = row.mail;
        detail.push(stack(`message_header_${index}`, [
          text(`message_subject_${index}`, mail.subject || '(No subject)'),
          text(`message_sender_${index}`, `From: ${mail.sender || 'Not available'}`, 'caption'),
          text(`message_recipients_${index}`, `To: ${mail.recipients || 'Not available'}`, 'caption'),
          ...(mail.cc ? [text(`message_cc_${index}`, `Cc: ${mail.cc}`, 'caption')] : []),
          text(`message_date_${index}`, [dateValid(mail) ? new Date(mail.date).toLocaleString() : 'Date unavailable',
            typeof mail.seen === 'boolean' ? mail.seen ? 'Read' : 'Unread' : 'Read status unavailable',
            mail.answered === true ? 'Answered' : '', mail.flagged === true ? 'Starred' : '',
            [mail.in_inbox ? 'Inbox' : '', mail.in_sent ? 'Sent' : '', mail.in_archive ? 'Archive' : ''].filter(Boolean).join(', ') || 'Folder unavailable',
          ].filter(Boolean).join(' · '), 'caption'),
        ], {layout: 'list'}), text(`message_body_notice_${index}`, mail.body_notice, 'muted'),
        text(`message_files_notice_${index}`, mail.files_notice, 'caption'));
      }
      if (related.length > pageSize) detail.push(stack('conversation_pages', [
        ...(conversationPage > 0 ? [button('previous_conversation', 'Previous messages', 'ghost')] : []),
        text('conversation_page_number', `Messages ${conversationPage * pageSize + 1}–${Math.min((conversationPage + 1) * pageSize, related.length)} of ${related.length} loaded`, 'caption'),
        ...((conversationPage + 1) * pageSize < related.length ? [button('next_conversation', 'Next messages', 'ghost')] : []),
      ], {layout: 'horizontal'}));
    } else detail.push(text('empty_reader', 'Choose a loaded conversation', 'heading'),
      text('empty_reader_help', 'This read-only preview shows saved headers and availability. Message text and files are not available here.', 'muted'));
    sdk.render({navigation, root: stack('email_metadata', [
      stack('toolbar', [stack('toolbar_title', [text('brand', 'Email', 'heading')], {mobile: 'hidden'}),
        stack('toolbar_actions', [text('read_only', 'Indexed preview · Read only', 'caption'), button('refresh', 'Refresh', 'ghost')], {layout: 'horizontal'})], {layout: 'toolbar'}),
      stack('workspace', [stack('list_panel', list, {surface: 'sidebar', ...(mobilePane === 'reader' ? {mobile: 'hidden'} : {})}),
        stack('reader_panel', detail, {surface: 'document', ...(mobilePane === 'list' ? {mobile: 'hidden'} : {})})], {layout: 'split'}),
      ...(status ? [text('status', status, 'muted')] : []),
    ], {layout: 'workspace'})});
  }

  async function load(reset) {
    if (reset) { cache.clear(); cursors.clear(); nextCursor = null; examined = 0; pagesRead = 0; ended = false; limited = false; unavailable = 0; listPage = 0; selectedId = null; conversationPage = 0; }
    status = ''; render();
    const cursor = nextCursor;
    if (cursor && cursors.has(cursor)) { limited = true; status = 'Saved metadata pagination could not advance. Refresh to start a new read.'; return; }
    const page = await sdk.listResourceSummaries('mail_index', {limit: pageSize, ...(cursor ? {cursor} : {})});
    const candidates = page.items.slice(0, indexLimit - examined);
    // At most four resource reads are outstanding, below the public SDK limit.
    for (let offset = 0; offset < candidates.length; offset += 4) {
      await Promise.all(candidates.slice(offset, offset + 4).map(async item => {
        if (cache.has(item.record_id)) return;
        try { cache.set(item.record_id, {record_id: item.record_id, mail: await reader.read(item.record_id)}); }
        catch { unavailable++; }
      }));
    }
    examined += candidates.length;
    pagesRead++;
    if (cursor) cursors.add(cursor);
    nextCursor = page.next_cursor; ended = nextCursor === null;
    limited = !ended && (examined >= indexLimit || pagesRead >= 10 || !!nextCursor && cursors.has(nextCursor));
    if (!selectedId || !groups().some(row => conversation(row).some(item => item.record_id === selectedId))) selectFirst();
    if (unavailable) status = `${unavailable} saved metadata ${unavailable === 1 ? 'record is' : 'records are'} unavailable. Refresh to try again.`;
  }

  sdk.onEvent(async event => {
    if (busy || event?.kind !== 'click' || typeof event.node_id !== 'string') return;
    const id = event.node_id;
    if (id === 'back') { mobilePane = 'list'; render(); return; }
    if (id.startsWith('folder_') && ['all', 'inbox', 'sent', 'archive'].includes(id.slice(7))) {
      folder = id.slice(7); listPage = 0; mobilePane = 'list'; selectFirst(); render(); return;
    }
    if (/^conversation_\d+$/.test(id)) {
      const row = groups()[listPage * pageSize + Number(id.slice(13))];
      if (row) { selectedId = row.record_id; conversationPage = 0; mobilePane = 'reader'; render(); }
      return;
    }
    if (id === 'previous_list' && listPage > 0) { listPage--; render(); return; }
    if (id === 'next_list' && (listPage + 1) * pageSize < groups().length) { listPage++; render(); return; }
    if (id === 'previous_conversation' && conversationPage > 0) { conversationPage--; render(); return; }
    if (id === 'next_conversation' && cache.has(selectedId) && (conversationPage + 1) * pageSize < conversation(cache.get(selectedId)).length) { conversationPage++; render(); return; }
    if (id !== 'refresh' && !(id === 'load_more' && nextCursor && !limited)) return;
    busy = true;
    try { await load(id === 'refresh'); }
    catch { status = 'Saved metadata could not be loaded. Refresh to try again.'; }
    finally { busy = false; render(); }
  });
  render();
  load(true).catch(() => { status = 'Saved metadata could not be loaded. Refresh to try again.'; })
    .finally(() => { busy = false; render(); });
};
