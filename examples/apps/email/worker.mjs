import {createDeftExperienceSdk} from '@deft/app-kit/experience';
import {createRequestJournal} from './request-journal.mjs';
import {createDraftController, createDraftId} from './draft-controller.mjs';

self.onmessage = event => {
  if (event.data?.kind !== 'start' || !event.data.port) return;
  self.onmessage = null;
  const sdk = createDeftExperienceSdk(event.data.port, event.data.session_id);
  let busy = false, sequence = 0, items = [], cursor = null, selectedId = null;
  let mode = 'reader', mobilePane = 'list', query = '', searchedQuery = '', hits = [], searchCursor = null, searchComplete = false;
  let to = '', subject = '', body = '', status = 'Loading messages…';
  const journal=createRequestJournal(sdk); const actions=journal.entries; let journalReady=false;
  let pageIndex = 0, pageCursor = null, folder = 'inbox', folderComplete = false;
  const previousPages = [];
  let lastAction = null;
  let draftRows = [], draftListGeneration = 0, retainedDraftMode='compose';
  const drafts = createDraftController(sdk,{snapshot:()=>({mode,to,subject,body,reply_record_id:mode==='reply'?selectedId||'':''}),onChange:()=>render()});
  const cache = new Map(), pendingReads = new Map();
  let activeReads = 0;
  const waitingReads = [];
  const scalar = (mail, field) => typeof mail?.[field] === 'string' ? mail[field] : '';
  const compact = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const singleMailbox = value => {
    const raw = String(value || '').trim();
    if (!raw || raw.length > 200 || /[;\r\n]/.test(raw)) return '';
    const address = raw.includes('<') ? /^(?:"[^"]*"|[^<>,"]+)?\s*<([^<>]+)>$/.exec(raw)?.[1]?.trim() : raw;
    return address && /^[^\s<>,;"@]+@[^\s<>,;"@]+$/.test(address) ? address : '';
  };
  const replyTarget = mail => {
    const sender = singleMailbox(scalar(mail, 'sender'));
    const target = scalar(mail, 'folder') === 'sent' ? singleMailbox(scalar(mail, 'recipients')) : sender;
    return scalar(mail, 'folder') === 'sent' && target.toLowerCase() === sender.toLowerCase() ? '' : target;
  };
  const displayDate = mail => {
    const value = scalar(mail, 'date');
    return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '';
  };
  const text = (id, value, tone = 'default') => ({kind: 'text', id, text: String(value).slice(0, 4096), tone});
  const button = (id, label, variant = 'secondary', extra = {}) => ({kind: 'button', id,
    label: String(label).slice(0, 128), variant, disabled: busy, ...(['compose','refresh','search','reply','archive','back','discard','submit'].includes(id) ? {icon: ({discard:'close',submit:'send'})[id] || id} : {}), ...extra});
  const input = (id, label, value, placeholder, multiline = false) => ({kind: 'input', id, label,
    value: String(value).slice(0, 4096), placeholder, multiline, appearance: id === 'query' ? 'search' : id === 'body' ? 'body' : 'inline'});
  const stack = (id, children, extra = {}) => ({kind: 'stack', id, children, ...extra});
  const selected = () => cache.get(selectedId);
  const related = mail => items.map(item => cache.get(item.record_id)).filter(other => other && (
    (scalar(mail, 'message_id') && scalar(other, 'message_id') === scalar(mail, 'message_id'))
    || (scalar(mail, 'message_id') && scalar(other, 'in_reply_to') === scalar(mail, 'message_id'))
    || (scalar(mail, 'in_reply_to') && scalar(other, 'message_id') === scalar(mail, 'in_reply_to'))));

  async function readRecord(recordId) {
    if (cache.has(recordId)) return cache.get(recordId);
    if (pendingReads.has(recordId)) return pendingReads.get(recordId);
    const work = (async () => {
      if (activeReads >= 4) await new Promise(resolve => waitingReads.push(resolve));
      activeReads++;
      try {
        const mail = (await sdk.readResourceRecord('inbox', recordId)).item.data;
        cache.set(recordId, mail);
        if (cache.size > 40) {
          const oldest = [...cache.keys()].find(key => key !== selectedId && key !== recordId && !actions.some(action => action.sourceId === key));
          if (oldest) cache.delete(oldest);
        }
        return mail;
      } finally { activeReads--; waitingReads.shift()?.(); }
    })();
    pendingReads.set(recordId, work);
    try { return await work; } finally { pendingReads.delete(recordId); }
  }

  async function loadActivity() {
    try{await journal.load();journalReady=true;return true;}
    catch{journalReady=false;status='Activity could not be loaded. Reading is available; Compose and Archive are paused.';return false;}
  }

  function render() {
    const mail = selected(), composing = mode === 'compose' || mode === 'reply';
    const rows = searchedQuery ? hits.map(hit => ({record_id: hit.record_id, label: hit.label, snippet: hit.snippet})) : items;
    const navigation = ['inbox','sent','drafts','archive'].map(key=>key==='drafts'
      ? button('drafts','Drafts','ghost',{selected:mode==='drafts'})
      : button('folder_'+key,key[0].toUpperCase()+key.slice(1),'ghost',{selected:folder===key&&!searchedQuery&&!['drafts','activity'].includes(mode)}));
    let list = [
      stack('inbox_heading', [text('list_heading', searchedQuery ? 'Search results' : folder[0].toUpperCase()+folder.slice(1), 'default'), text('loaded_count', `${searchedQuery ? hits.length : items.length} messages`, 'caption')], {layout: 'toolbar'}),
      stack('search_controls', [input('query', 'Search', query, 'Search mail'),
        button('search', 'Search', 'secondary')], {layout: 'horizontal'}),
      stack('message_rows', rows.length ? rows.map((item, index) => {
        const data = cache.get(item.record_id);
        return button(`${searchedQuery ? 'hit' : 'mail'}_${index}`, scalar(data, 'subject') || item.label || '(No subject)', 'list', {
          eyebrow: compact(scalar(data, 'folder') === 'sent' ? `To: ${scalar(data, 'recipients') || 'Not available'}` : scalar(data, 'sender'), 128), description: compact(searchedQuery?(item.snippet || scalar(data,'body')):scalar(data,'body'),140), selected: selectedId === item.record_id,
        });
      }) : [text('empty_inbox', busy ? 'Loading messages…' : searchedQuery ? searchComplete ? 'No messages found.' : 'No matches on this page. Continue searching.' : folderComplete ? 'No messages in this folder.' : 'No messages on this page. Continue to the next page.', 'muted')], {layout: 'list'}),
      ...(searchedQuery && searchCursor ? [button('more_search', 'Continue search', 'ghost')] : []),
      ...(!searchedQuery && (previousPages.length || cursor) ? [stack('page_controls', [...(previousPages.length ? [button('previous_page', 'Previous', 'ghost')] : []), text('page_number', `Page ${pageIndex + 1}`, 'caption'), ...(cursor ? [button('more', 'Next', 'ghost')] : [])], {layout: 'horizontal'})] : []),
      ...(searchedQuery ? [button('clear_search', `Back to ${folder}`, 'ghost')] : [])];
    if (mode==='drafts') list=[
      stack('drafts_list_heading',[text('draft_list_title','Drafts'),text('draft_count',String(draftRows.length),'caption')],{layout:'toolbar'}),
      stack('draft_rows',draftRows.length?draftRows.map((row,index)=>button(`draft_open_${index}`,`Draft ${index+1}`,'list',{description:`Updated ${new Date(row.updated_at).toLocaleString()}`})):[text('drafts_empty','No saved drafts.','muted')],{layout:'list'}),
    ];
    if (mode==='activity') list=[text('activity_list_title','Activity'),text('activity_list_help','Send and archive status. Your mailbox stays in the sidebar.','caption')];
    const detail = [stack('mobile_back', [button('back', mode==='drafts'?'Back to drafts':'Back to '+folder, 'ghost')], {mobile: 'only'})];
    if (mode === 'drafts') {
      detail.push(text('drafts_heading','Choose a saved draft','heading'),text('drafts_limits','Saved drafts remain private and expire after 30 days.','caption'),
        ...(drafts.current.id?[button('resume_local','Resume current draft','ghost'),text('drafts_current_status',drafts.current.status,'caption')]:[]));
    } else if (mode === 'activity') {
      detail.push(text('requests_heading', 'Activity', 'heading'), text('activity_help','Check sending and archive outcomes here. Nothing is retried automatically.','caption'), button('close_requests', 'Back to message', 'ghost'));
      if (!actions.length) detail.push(text('requests_empty', 'No activity yet.', 'muted'));
      for (const [index, action] of actions.entries()) detail.push(stack(`action_${index}`, [
        text(`action_summary_${index}`, `${action.label} · ${action.summary}`, 'caption'),
        text(`action_state_${index}`, actionState(action.state), 'muted'),
        button(`run_check_${index}`, 'Check status', 'ghost'),
        ...(action.runId ? [button(`run_review_${index}`,['pending_approval','approval_pending'].includes(action.state)?'Review request':'View outcome','secondary')] : []),
        ...(['succeeded','failed','denied','cancelled','expired'].includes(action.state)&&action.runId ? [button(`run_remove_${index}`,'Remove from activity','ghost')] : []),
        ...(action.sourceId ? [button(`run_source_${index}`, 'Open message', 'ghost')] : []),
      ], {layout: 'list'}));
    } else if (composing) {
      detail.push(text('compose_heading', mode === 'reply' ? 'Reply draft' : 'Message draft', 'heading'),
        text('compose_notice', 'Continue writing your message.', 'caption'),
        text('draft_save_status',drafts.current.status,'caption'),
        stack('compose_controls', [button('open_composer','Continue draft','primary'),button('discard', 'Close draft', 'ghost'),
          ...(drafts.current.id?[button('delete_draft','Delete saved copy','ghost')]:[]),
          ...(drafts.current.blocked?[button('copy_draft','Save separate copy','ghost')]:[])], {layout: 'horizontal'}));
    } else if (mail) {
      const thread = related(mail);
      detail.push(text('mail_subject', scalar(mail, 'subject') || '(No subject)', 'heading'),
        stack('mail_metadata', [text('mail_sender', `From: ${scalar(mail, 'sender') || 'Not available'}`, 'caption'),
          text('mail_recipients', `To: ${scalar(mail, 'recipients') || 'Not available'}`, 'caption'),
          text('mail_date_flags',[displayDate(mail),typeof mail.seen==='boolean'?(mail.seen?'Read':'Unread')+(mail.answered?' · Answered':'')+(mail.flagged?' · Starred':''):'Read status unavailable'].filter(Boolean).join(' · '),'caption')], {layout: 'list'}),
        stack('reader_controls', [button('reply', 'Reply', 'secondary', {disabled: busy || !journalReady || !scalar(mail, 'message_id') || !replyTarget(mail)}),
          button('archive', 'Archive', 'secondary', {disabled: busy || !journalReady || !scalar(mail, 'resource_id') || scalar(mail,'folder')==='archive'}),button('files_followups','Files and follow-ups','secondary')], {layout: 'horizontal'}),
        text('mail_body', typeof mail.body === 'string' ? mail.body || 'No message text.' : 'Message text is not available.', 'body'),
        ...['body_2','body_3','body_4'].filter(key=>scalar(mail,key)).map(key=>text('mail_'+key,mail[key],'body')),
        ...(mail.body_truncated ? [text('body_limit',mail.full_body_status==='available'?'More message text is available as a file in Saved files.':'Only part of this message text is available.','caption')] : []),
        ...(mail.attachment_metadata_complete!==true || mail.attachment_count>0 ? [text('attachment_summary',mail.attachment_metadata_complete===true?`${mail.attachment_count} attachments · ${mail.downloadable_attachment_count} available in Saved files${mail.skipped_attachment_count?` · ${mail.skipped_attachment_count} skipped`:''}`:'Attachment information incomplete. Check Saved files.','caption')]:[]),
        ...(thread.length > 1 ? [text('thread_scope', `${thread.length} related messages on this page`, 'caption')] : []),
        ...thread.filter(other => other !== mail).slice(0, 10).map((other, index) => button(`thread_${index}`, scalar(other, 'subject') || '(No subject)', 'ghost', {description: compact(scalar(other, 'sender'), 128)})));
    } else if (rows.length) detail.push(text('reader_empty', busy ? 'Loading message…' : 'Choose a message to read.', 'muted'));
    sdk.render({navigation, root: stack('email', [
      stack('toolbar', [text('brand', 'Email', 'default'),
        ...(composing && mobilePane === 'reader' ? [text('draft_heading', 'Draft', 'caption')] : [button('refresh', 'Refresh', 'secondary'), button('requests','Activity','secondary',{selected:mode==='activity'}), button('compose', composing && mobilePane === 'list' ? 'Resume draft' : 'Compose', 'primary',{disabled:busy||!journalReady})])], {layout: 'toolbar', ...(composing && mobilePane === 'reader' ? {mobile: 'hidden'} : {})}),
      stack('workspace', [stack('inbox_panel', list, {surface: 'sidebar', ...(mobilePane === 'reader' ? {mobile: 'hidden'} : {})}),
        stack('reader_panel', detail, {surface: 'document', ...(mobilePane === 'list' ? {mobile: 'hidden'} : {})})], {layout: 'split'}),
      ...(status ? [stack('activity', [text('status', status, 'muted')])] : []),
    ], {layout: 'workspace'})});
  }

  async function openHostComposer() {
    if (!journalReady) throw Error('REQUEST_JOURNAL_UNAVAILABLE');
    const key=mode==='reply'?'reply_message':'send_message';
    if(!drafts.current.id) drafts.use(createDraftId());
    await drafts.save();
    if(drafts.current.blocked||drafts.current.dirty>drafts.current.written)throw Error('DRAFT_SAVE_UNCONFIRMED');
    const prior=actions.find(entry=>entry.draftId===drafts.current.id);
    if(prior?.runId){status='This draft has an existing request. Check its outcome before creating a separate copy.';return;}
    const mail=selected();
    if(mode==='reply'&&!scalar(mail,'message_id'))throw Error('REPLY_PARENT_UNAVAILABLE');
    const data={to,subject,body,...(mode==='reply'?{parent_resource_id:mail.resource_id}:{})};
    const entry=prior||await journal.reserve({actionKey:key,label:mode==='reply'?'Reply':'Send',summary:`${to} · ${subject}`.slice(0,400),sourceId:mode==='reply'?selectedId:null,draftId:drafts.current.id});
    try{
      const result=await sdk.request('dialog','compose_action',{action_key:key,input:data,draft_state_key:'drafts',draft_id:drafts.current.id});
      if(result?.cancelled===true){await journal.cancelUnsubmitted(entry);try{const saved=await drafts.read(drafts.current.id);to=saved.value.to;subject=saved.value.subject;body=saved.value.body;drafts.use(saved.record_id,saved.revision);}catch{}status='Draft kept. No action was submitted.';return;}
      if(!result?.run?.id){try{const saved=await drafts.read(drafts.current.id);to=saved.value.to;subject=saved.value.subject;body=saved.value.body;drafts.use(saved.record_id,saved.revision);}catch{}status='Action outcome unknown. Check history; do not resend.';return;}
      await journal.update(entry,result.run);
      // A known Run must survive a later unavailable draft read.
      try{const saved=await drafts.read(drafts.current.id);to=saved.value.to;subject=saved.value.subject;body=saved.value.body;drafts.use(saved.record_id,saved.revision);}catch{}
      drafts.close();mode='reader';to='';subject='';body='';status=actionState(entry.state);
    }catch{status='Action outcome unknown. Your saved draft remains available. Do not resend automatically.';}
  }

  function actionState(state) {
    if (['pending_approval', 'approval_pending'].includes(state)) return 'Waiting for your approval.';
    if (state === 'succeeded') return 'Completed. View result for the provider outcome. Mail server acceptance does not confirm delivery.';
    if (['failed', 'denied', 'cancelled', 'expired'].includes(state)) return `${state[0].toUpperCase() + state.slice(1)}. No automatic retry.`;
    if (['pending', 'queued', 'running', 'claimed', 'started'].includes(state)) return 'In progress. Waiting for the provider outcome.';
    return 'Outcome unknown. Check approval or its receipt; do not resend automatically.';
  }
  async function loadInbox(reset, backwards = false) {
    let targetCursor = pageCursor, targetIndex = pageIndex;
    if (reset) { targetCursor = null; targetIndex = 0; }
    else if (backwards) { const previous = previousPages.at(-1); if (!previous) return; targetCursor = previous.cursor; targetIndex = previous.index; }
    else { if (!cursor) return; targetCursor = cursor; targetIndex = pageIndex + 1; }
    status = 'Loading messages…'; render();
    const page = await sdk.searchResourceRecords('inbox', {query:folder,field_keys:['folder'],...(targetCursor ? {cursor:targetCursor}:{})});
    folderComplete=page.scan.complete;
    const newItems = page.items;
    if (reset) cache.clear();
    await Promise.all(newItems.map(item => readRecord(item.record_id)));
    if (reset) previousPages.length = 0;
    else if (backwards) previousPages.pop();
    else { previousPages.push({cursor: pageCursor, index: pageIndex}); if (previousPages.length > 10) previousPages.shift(); }
    items = newItems; cursor = page.next_cursor; pageCursor = targetCursor; pageIndex = targetIndex;
    selectedId = items[0]?.record_id || null; hits = []; searchedQuery = ''; searchCursor = null; searchComplete = false;
    mode = 'reader'; status = '';
  }
  async function select(recordId) {
    await readRecord(recordId); selectedId = recordId; mode = 'reader'; mobilePane = 'reader';
    status = '';
  }
  sdk.onEvent(async ui => {
    if (ui.kind === 'input') {
      if (ui.node_id === 'query') { query = ui.value; searchCursor = null; }
      if (ui.node_id === 'to') to = ui.value;
      if (ui.node_id === 'subject') subject = ui.value;
      if (ui.node_id === 'body') body = ui.value;
      if (['to','subject','body'].includes(ui.node_id) && ['compose','reply'].includes(mode)) drafts.change();
      return;
    }
    if (busy) return;
    if (['compose', 'reply'].includes(mode) && (to || subject || body) && !['compose','open_composer', 'discard', 'back','save_draft','delete_draft','copy_draft','drafts'].includes(ui.node_id) && !/^run_check_\d+$/.test(ui.node_id)) {
      mobilePane = 'reader';
        status = 'Your draft is kept. Close it before switching messages.'; render(); return;
    }
    busy = true;
    try {
      if (/^folder_(inbox|sent|archive)$/.test(ui.node_id)) { folder=ui.node_id.slice(7);query='';await loadInbox(true);mobilePane='list'; }
      else if (ui.node_id === 'refresh' || ui.node_id === 'more' || ui.node_id === 'previous_page') {if(ui.node_id==='refresh'&&!journalReady)await loadActivity();await loadInbox(ui.node_id === 'refresh', ui.node_id === 'previous_page');if(!journalReady)status='Activity could not be loaded. Reading is available; Compose and Archive are paused.';}
      else if (ui.node_id === 'search' || ui.node_id === 'more_search') {
        if (!query.trim() || query.length > 200) { status = 'Enter up to 200 characters to search.'; return; }
        status = 'Searching mail…'; render();
        const page = await sdk.searchResourceRecords('inbox', {query, field_keys: ['subject', 'body'],
          ...(ui.node_id === 'more_search' && searchCursor ? {cursor: searchCursor} : {})});
        hits = page.items; searchedQuery = query; searchCursor = page.next_cursor; searchComplete = page.scan.complete; selectedId = null; mode = 'reader';
        await Promise.all(hits.map(hit => readRecord(hit.record_id)));
        if (hits.length) selectedId = hits[0].record_id;
        status = `${hits.length} matches. ${page.scan.complete ? 'Search complete.' : 'Continue searching for more.'}`;
      } else if (/^mail_\d+$/.test(ui.node_id)) await select(items[Number(ui.node_id.slice(5))].record_id);
      else if (/^hit_\d+$/.test(ui.node_id)) await select(hits[Number(ui.node_id.slice(4))].record_id);
      else if (/^thread_\d+$/.test(ui.node_id)) {
        const mail = selected(), other = related(mail).filter(row => row !== mail)[Number(ui.node_id.slice(7))];
        const recordId = [...cache.entries()].find(([, row]) => row === other)?.[0];
        if (recordId) await select(recordId);
      }
      else if (ui.node_id === 'clear_search') { status = ''; query = ''; searchedQuery = ''; hits = []; searchCursor = null; searchComplete = false; selectedId = items[0]?.record_id || null; mobilePane = 'list'; }
      else if (ui.node_id === 'back') mobilePane = 'list';
      else if (ui.node_id === 'requests') { mode = 'activity'; mobilePane = 'reader'; status = '';if(!journalReady)await loadActivity(); }
      else if (ui.node_id === 'close_requests') { mode = 'reader'; mobilePane = 'reader'; status = ''; }
      else if (ui.node_id === 'compose') { if(!['compose','reply'].includes(mode)){drafts.use();mode='compose';to='';subject='';body='';}mobilePane='reader';status='';await openHostComposer(); }
      else if (ui.node_id === 'open_composer') await openHostComposer();
      else if (ui.node_id === 'reply') {
        const mail = selected(); if (!mail || !scalar(mail, 'message_id')) return;
        const recipient = replyTarget(mail);
        if (!recipient) { status = 'This message has no single other recipient. Use Compose to choose a recipient.'; return; }
        drafts.use(); mode = 'reply'; mobilePane = 'reader'; to = recipient; subject = (/^re:/i.test(scalar(mail, 'subject')) ? scalar(mail, 'subject') : `Re: ${scalar(mail, 'subject')}`).slice(0, 200); body = '';
        status = '';
        await openHostComposer();
      } else if (ui.node_id === 'discard') { drafts.close(); mode = 'reader'; to = ''; subject = ''; body = ''; status = 'Draft closed. Any saved copy remains.'; }
      else if (ui.node_id === 'save_draft') await drafts.save();
      else if (ui.node_id === 'copy_draft') await drafts.copy();
      else if (ui.node_id === 'delete_draft') { await drafts.remove(); status='Saved draft copy deleted.'; }
      else if (ui.node_id === 'drafts') {
        if(['compose','reply'].includes(mode)){retainedDraftMode=mode;await drafts.save();}
        const request=++draftListGeneration;const rows=await drafts.list();if(request!==draftListGeneration)return;draftRows=rows;mode='drafts';mobilePane='list';status='';
      }
      else if (ui.node_id === 'resume_local') { mode=retainedDraftMode; mobilePane='reader'; }
      else if (/^draft_open_\d+$/.test(ui.node_id)) {
        const row=draftRows[Number(ui.node_id.slice(11))];if(!row)return;
        if(drafts.current.blocked&&drafts.current.dirty>drafts.current.written&&row.record_id!==drafts.current.id){status='Current draft has unsaved changes. Resume it and save a separate copy or close it before opening another.';return;}
        const saved=await drafts.read(row.record_id),value=saved.value;
        if(!value||Object.keys(value).sort().join(',')!=='body,mode,reply_record_id,subject,to'||!['compose','reply'].includes(value.mode)||!['to','subject','body','reply_record_id'].every(key=>typeof value[key]==='string')||value.to.length>200||value.subject.length>200||value.body.length>4096||value.reply_record_id.length>36)throw Error('DRAFT_INVALID');
        mode=value.mode;to=value.to;subject=value.subject;body=value.body;selectedId=null;drafts.use(saved.record_id,saved.revision);mobilePane='reader';
        if(mode==='reply'&&value.reply_record_id){try{await readRecord(value.reply_record_id);selectedId=value.reply_record_id;}catch{status='Original message unavailable. Reply cannot be submitted until its parent is current.';}}
        await openHostComposer();
      }
      else if (ui.node_id === 'files_followups') { if(selectedId)await sdk.openResource('inbox',selectedId);
      } else if (ui.node_id === 'archive') {
        if(!journalReady)throw Error('REQUEST_JOURNAL_UNAVAILABLE');
        const mail = selected(); if (!scalar(mail, 'resource_id') || scalar(mail,'folder')==='archive') return;
        lastAction = 'archive_message';
        const intent = JSON.stringify({action: lastAction, resource_id: mail.resource_id, uidvalidity: mail.uidvalidity});
        if (actions.some(entry => entry.intent === intent || (entry.actionKey === lastAction && entry.sourceId === selectedId))) { status = 'This message already has an archive request. Check its outcome.'; return; }
        status = 'Requesting approval…'; render();
        const entry = await journal.reserve({actionKey:lastAction,label: 'Archive', summary: scalar(mail, 'subject').slice(0, 200), sourceId: selectedId, intent});
        try { const run = await sdk.request('action', lastAction, {resource_id: mail.resource_id}); entry.runId=run?.id||null;entry.state=run?.state||'unknown';await journal.update(entry,run); } catch { status = 'Request outcome unknown. Do not resend automatically.'; return; }
        status = actionState(entry.state);
      } else if (/^run_check_\d+$/.test(ui.node_id)) {
        const entry = actions[Number(ui.node_id.slice(10))];
        if (!entry?.runId) { status = 'Request outcome unknown. Check Deft Approvals; do not resend automatically.'; return; }
        try { const run = await sdk.request('run_status', undefined, {run_id: entry.runId}); await journal.update(entry,{...run,id:entry.runId}); status = ''; }
        catch { status = 'Status unavailable. Last known outcome retained; no automatic retry.'; }
      } else if (/^run_review_\d+$/.test(ui.node_id)) { const entry=actions[Number(ui.node_id.slice(11))];if(entry?.runId)await sdk.request('dialog','review_run',{run_id:entry.runId});
      } else if (/^run_remove_\d+$/.test(ui.node_id)) { const entry=actions[Number(ui.node_id.slice(11))];if(entry)await journal.remove(entry);
      } else if (/^run_source_\d+$/.test(ui.node_id)) {
        const entry = actions[Number(ui.node_id.slice(11))]; if (entry?.sourceId) await select(entry.sourceId);

      }
    } catch (error) { status = error?.message==='REQUEST_JOURNAL_CAP'?'Activity is full. Open Activity to check existing items; pending or unknown items are kept.': 'This request is unavailable. Check your access or approval, then try again.'; }
    finally { busy = false; render(); }
  });
  busy = true; render();
  void (async()=>{await loadActivity();await loadInbox(true);if(!journalReady)status='Activity could not be loaded. Reading is available; Compose and Archive are paused.';})().catch(() => { status = 'Messages are unavailable. Check your access, then refresh.'; })
    .finally(() => { busy = false; render(); });
};
