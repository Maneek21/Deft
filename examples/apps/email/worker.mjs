import {readTriageReceipt} from './triage-receipt-ui.mjs';
import {emailSearchInput} from './search-ui.mjs';
import {createSignatureState} from './signature-state.mjs';
import {workerTriageInput} from './triage-ui.mjs';
import {emailDocumentNode} from './document-ui.mjs';
import {currentWorkerMail,currentWorkerDocument,workerComposeParent,workerConversationCoverage,emailMetadataInFolder,emailMetadataRelated,EMAIL_METADATA_SEARCH_FIELDS} from './worker-mail.mjs';
import {createEmailComposeIntent,insertEmailSignature} from './compose-intents.mjs';
import {createDeftExperienceSdk} from '@deft/app-kit/experience';
import {createRequestJournal} from './request-journal.mjs';
import {createDraftController, createDraftId, draftSubjectValid} from './draft-controller.mjs';

self.onmessage = event => {
  if (event.data?.kind !== 'start' || !event.data.port) return;
  self.onmessage = null;
  const sdk = createDeftExperienceSdk(event.data.port, event.data.session_id);
  let busy = false, sequence = 0, items = [], cursor = null, selectedId = null;
  let mode = 'reader', mobilePane = 'list', query = '', searchedQuery = '', hits = [], searchCursor = null, searchComplete = false;
  let searchOpen=false, detailsOpen=false, conversationOpen=false, actionsOpen=false, selectionMode=false;
  let filtersOpen=false, searchFields={}, searchedFilters=null, triagePicker=null;
  const selectedRecords=new Set(),receipts=new Map();let expandedReceiptRun=null;
  let to = '', cc = '', bcc = '', body_html = '', reply_record_id = '', accountFilter = '', subject = '', body = '', status = '';
  const signature=createSignatureState(sdk,{uuid:createDraftId});
  const journal=createRequestJournal(sdk); const actions=journal.entries; let journalReady=false;
  let pageIndex = 0, folder = 'inbox', folderComplete = false;
  const browseAvailable=typeof sdk.browseResourceRecords==='function';
  let providerBrowse=browseAvailable,providerHistory=[null],providerHistoryIndex=0,providerHistoryStart=0,providerObservedAt='';
  let folderIndex = [];
  const folderIndexLimit = 100, pageSize = 10;
  let lastAction = null;
  let draftRows = [], draftListGeneration = 0, retainedDraftMode='compose', draftListState='ready', mailboxState='loading';
  const drafts = createDraftController(sdk,{snapshot:()=>({mode,to,cc,bcc,subject,body,body_html,reply_record_id}),onChange:()=>render()});
  const cache = new Map(), pendingReads = new Map();
  let conversation=null,retainedPresentation=null,documentGeneration=0;
  const conversationLimit=40,conversationPageLimit=10;
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
  const compactDate = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString(undefined, {month: 'short', day: 'numeric'}) : '';
  const folderLabel = () => folder[0].toUpperCase() + folder.slice(1);
  const messagePreview = mail => compact(mail?.document?.plain_text || scalar(mail, 'body'), 140) || (mail?.files_status==='lazy' ? 'Message with attachments' : '');
  const mailboxDisplay = value => {const name=singleMailbox(value)&&/^(.*?)\s*<[^<>]+>$/.exec(value)?.[1]?.trim().replace(/^"(.*)"$/,'$1');return name||value;};
  const rowSender = mail => scalar(mail, 'folder') === 'sent' ? `To: ${mailboxDisplay(scalar(mail, 'recipients')) || 'Not available'}` : mailboxDisplay(scalar(mail, 'sender')) || 'Sender unavailable';
  const rowMeta = mail => [compactDate(scalar(mail, 'date')), mail?.seen === false ? 'Unread' : '', mail?.flagged === true ? 'Starred' : ''].filter(Boolean).join(' · ');
  const text = (id, value, tone = 'default') => ({kind: 'text', id, text: String(value).slice(0, 4096), tone});
  const button = (id, label, variant = 'secondary', extra = {}) => ({kind: 'button', id,
    label: String(label).slice(0, 128), variant, disabled: busy, ...(['compose','refresh','search','reply','archive','back','discard','submit'].includes(id) ? {icon: ({discard:'close',submit:'send'})[id] || id} : {}), ...extra});
  const input = (id, label, value, placeholder, multiline = false) => ({kind: 'input', id, label,
    value: String(value).slice(0, 4096), placeholder, multiline, appearance: id === 'query' ? 'search' : id === 'body' ? 'body' : 'inline'});
  const stack = (id, children, extra = {}) => ({kind: 'stack', id, children, ...extra});
  const selected = () => cache.get(selectedId);
  // Presentation only. Logical identity never supplies a Reply/action handle.
  const retainedDocument=mail=>retainedPresentation&&mail?.account_id===retainedPresentation.mail.account_id
    &&mail.logical_message_id===retainedPresentation.mail.logical_message_id
    &&(!mail.source_revision||!retainedPresentation.mail.source_revision||mail.source_revision===retainedPresentation.mail.source_revision)
    &&['conversation_id','subject','sender','recipients','cc','date','message_id','references','in_reply_to','uidvalidity','subject_preview_truncated'].every(key=>mail[key]===retainedPresentation.mail[key])
    ?retainedPresentation.document:null;
  const rememberPage=page=>{for(const item of page.items){
    const previous=cache.get(item.record_id),mail=currentWorkerMail(item,item.record_id);
    // A repeated conversation header must not erase the just-read document.
    // Retain it only while the scoped message and reply-parent metadata agree.
    if(previous?.document&&['account_id','logical_message_id','conversation_id','subject','sender','recipients','cc','message_id','references','in_reply_to','subject_preview_truncated'].every(key=>previous[key]===mail[key])){
      mail.document=previous.document;mail.headers_complete=previous.headers_complete;
    }
    cache.set(item.record_id,mail);
  }
    while(cache.size>40){const oldest=[...cache.keys()].find(id=>id!==selectedId&&!page.items.some(item=>item.record_id===id)&&!actions.some(action=>action.sourceId===id));if(!oldest)break;cache.delete(oldest);}};
  const related = mail => conversation?.account_id===mail?.account_id&&conversation.conversation_id===mail?.conversation_id
    ? [...conversation.members.values()].sort((a,b)=>(Date.parse(a.date)||0)-(Date.parse(b.date)||0)||a.record_id.localeCompare(b.record_id))
    : emailMetadataRelated(mail,items.map(item=>cache.get(item.record_id)));

  async function readRecord(recordId) {
    if (cache.has(recordId)) return cache.get(recordId);
    if (pendingReads.has(recordId)) return pendingReads.get(recordId);
    const work = (async () => {
      if (activeReads >= 4) await new Promise(resolve => waitingReads.push(resolve));
      activeReads++;
      try {
        const mail = currentWorkerMail((await sdk.readResourceRecord('inbox', recordId)).item,recordId);
        cache.set(recordId, mail);
        if (cache.size > 40) {
          const oldest = [...cache.keys()].find(key => key !== selectedId && key !== recordId && !conversation?.members.has(key) && !actions.some(action => action.sourceId === key));
          if (oldest) cache.delete(oldest);
        }
        return mail;
      } finally { activeReads--; waitingReads.shift()?.(); }
    })();
    pendingReads.set(recordId, work);
    try { return await work; } finally { pendingReads.delete(recordId); }
  }

  const triageLabels={mark_read:'Mark read',mark_unread:'Mark unread',flag:'Star',unflag:'Unstar',archive:'Archive',trash:'Move to trash',restore:'Restore',spam:'Report spam',not_spam:'Not spam',move:'Move',labels:'Labels',permanent_delete:'Delete permanently'};
  function triageControls(prefix='') {return stack(prefix+'mail_actions',triagePicker&&triagePicker.bulk===Boolean(prefix)?[triagePickerView()]:[
    stack(prefix+'mail_action_buttons',[
    ...[...(prefix?['mark_read','mark_unread','flag','unflag','archive']:[selected()?.seen?'mark_unread':'mark_read',selected()?.flagged?'unflag':'flag']),...(folder==='trash'?['restore']:['trash']),...(folder==='spam'?['not_spam']:['spam'])].map(operation=>button(prefix+'triage_'+operation,triageLabels[operation],'ghost',{disabled:busy||!journalReady})),
    ...['move','labels'].map(operation=>button(prefix+'choose_'+operation,triageLabels[operation],'ghost',{disabled:busy||!journalReady})),
    ...(folder==='trash'?[button(prefix+'triage_permanent_delete','Delete permanently','secondary',{disabled:busy||!journalReady})]:[]),
    ],{layout:'horizontal'}),
  ],{layout:'list'});}
  function triagePickerView(){
    const p=triagePicker,rows=p.kind==='move'?p.options.destinations:p.options.labels;
    return stack('triage_picker',[
      text('triage_picker_title',p.kind==='move'?'Move to folder':'Change labels','heading'),
      ...(p.kind==='labels'?[text('triage_label_help','Choose once to add, twice to remove, three times to leave unchanged.','caption')]:[]),
      ...rows.slice(p.page*12,p.page*12+12).map((row,i)=>button(`triage_option_${p.page*12+i}`,`${p.labels.get(row.id)==='add'?'Add · ':p.labels.get(row.id)==='remove'?'Remove · ':''}${row.label}`,'ghost',{selected:p.labels.has(row.id)})),
      ...(!rows.length?[text('triage_options_empty',p.kind==='labels'&&!p.options.labels_supported?'Labels are unavailable with this account’s current access.':'No available destinations.','caption')]:[]),
      ...(!p.options.complete?[text('triage_options_partial','Only the first reviewed page of destinations is available.','caption')]:[]),
      stack('triage_picker_controls',[
        ...(p.page?[button('triage_options_previous','Previous','ghost')]:[]),
        ...((p.page+1)*12<rows.length?[button('triage_options_next','Next','ghost')]:[]),
        ...(p.kind==='labels'?[button('triage_labels_apply','Apply labels','primary',{disabled:busy||!p.labels.size})]:[]),
        button('triage_picker_close','Cancel','ghost'),
      ],{layout:'horizontal'}),
    ],{layout:'list'});
  }
  async function openTriagePicker(kind,bulk){
    const ids=bulk?[...selectedRecords]:selectedId?[selectedId]:[];
    if(!ids.length)return;
    const account=cache.get(ids[0])?.account_id;
    if(!account||ids.some(id=>cache.get(id)?.account_id!==account))throw Error('EMAIL_TRIAGE_SELECTION_INVALID');
    const options=await sdk.readTriageOptions('inbox',ids[0]);
    if(options.account_id!==account)throw Error('EMAIL_TRIAGE_SELECTION_INVALID');
    triagePicker={kind,bulk,ids,options,page:0,labels:new Map()};
  }
  async function confirmTriage(operation,bulk=false,options={},exactIds=null){
    if(!journalReady)throw Error('REQUEST_JOURNAL_UNAVAILABLE');
    const ids=exactIds||(bulk?[...selectedRecords]:selectedId?[selectedId]:[]);
    const {input,action_key:key,summary}=await workerTriageInput(operation,ids,id=>cache.get(id),options);
    if(actions.some(entry=>entry.actionKey===key&&entry.summary===summary)){status='This exact change already has a request. Check Activity; no automatic retry.';return;}
    const entry=await journal.reserve({actionKey:key,label:triageLabels[operation],summary,sourceId:ids[0]});
    try{const result=await sdk.request('dialog','confirm_action',{action_key:key,input});
      if(result?.cancelled===true){await journal.cancelUnsubmitted(entry);status='Cancelled. No mailbox change was submitted.';return;}
      if(!result?.run?.id){status='Mailbox change outcome unknown. Check Activity; do not retry automatically.';return;}
      await journal.update(entry,result.run);status=actionState(entry.state,key);
    }catch{status='Mailbox change outcome unknown. Check Activity; do not retry automatically.';}
  }

  async function loadActivity() {
    try{await journal.load();journalReady=true;return true;}
    catch{journalReady=false;status='Activity could not be loaded. Reading is available; Compose and Archive are paused. Refresh to retry.';return false;}
  }

  async function refreshActivity() {
    if (!await loadActivity()) return;
    let unavailable = false;
    for (const entry of actions.slice(0, 10)) {
      if (!entry.runId) continue;
      try {
        const run = await sdk.request('run_status', undefined, {run_id: entry.runId});
        if (run?.id !== entry.runId) throw Error('RUN_MISMATCH');
        await journal.update(entry, run);const receipt=readTriageReceipt(run);if(receipt)receipts.set(entry.runId,receipt);else receipts.delete(entry.runId);
      } catch { unavailable = true; }
    }
    if (unavailable) status = 'Some statuses are unavailable. Last known outcomes retained; no automatic retry.';
  }

  function displayDocument(mail){
    const document=mail.document,headers=document.metadata;
    const metadata=[['From',headers.reply_from],['To',headers.reply_to_list],['Cc',headers.reply_cc],['Date',scalar(mail,'date')],['Subject',headers.subject]].flatMap(([label,value])=>value?[{label,value:value.slice(0,2000)},...(value.length>2000?[{label:label+' (continued)',value:value.slice(2000,4000)}]:[])]:[]);
    const title=(headers.subject||scalar(mail,'subject')||'Message').slice(0,200);
    const printing={printable:actionsOpen,...(actionsOpen?{print_control_id:'print_message'}:{})};
    if(new TextEncoder().encode(document.content).byteLength<=16384)return emailDocumentNode(document,{title,metadata,...printing});
    let content='',bytes=0;for(const c of document.plain_text){const size=new TextEncoder().encode(c).byteLength;if(bytes+size>16384)break;content+=c;bytes+=size;}
    return emailDocumentNode({format:'plain',content,truncated:true},{title,metadata,...printing});
  }
  function render() {
    const mail = selected(), composing = ['compose','reply','reply_all','forward'].includes(mode);
    const currentDraft = composing || Boolean(drafts.current.id);
    const rows = searchedQuery ? hits.map(hit => ({record_id: hit.record_id, label: hit.label, snippet: hit.snippet})) : items;
    const navigation = ['inbox','sent','drafts','archive',...(browseAvailable?['spam','trash']:[])].map(key=>key==='drafts'
      ? button('drafts','Drafts','ghost',{selected:mode==='drafts'})
      : button('folder_'+key,key[0].toUpperCase()+key.slice(1),'ghost',{selected:folder===key&&!searchedQuery&&!['drafts','activity'].includes(mode)}));
    navigation.push(button('requests','Activity','ghost',{selected:mode==='activity'}));
    const headerActions=(withSearch=true)=>stack('inbox_actions',[
      ...(withSearch?[button('toggle_search','Search','ghost',{icon:'search',selected:searchOpen||Boolean(searchedQuery)})]:[]),
      button('refresh','Refresh','ghost'),...(withSearch?[button('select_messages',selectionMode?'Done selecting':'Select','ghost',{selected:selectionMode})]:[]),button('compose',currentDraft?'Resume draft':'Compose','primary',{disabled:busy||!journalReady}),
    ],{layout:'horizontal'});
    let list = [
      stack('inbox_heading', [stack('inbox_title',[text('list_heading', searchedQuery ? 'Search results' : folderLabel(),'heading'), text('loaded_count',mailboxState!=='ready'&&!rows.length?'':searchedQuery ? `${hits.length} matches · this page` : providerBrowse?`${items.length} ${items.length===1?'message':'messages'} · this page`:`${folderIndex.length} loaded ${folderIndex.length === 1 ? 'message' : 'messages'}${folderComplete?'':' · partial index'}`, 'caption')]),headerActions()], {layout: 'toolbar'}),
      ...(searchOpen&&!searchedQuery ? [text('folder_coverage',providerBrowse?`Current mailbox · Page ${pageIndex+1}${providerObservedAt?' · as of '+providerObservedAt:''}.`:'Showing loaded mail. More messages may be available.', 'caption')] : []),
      ...(!providerBrowse && !searchedQuery && !folderComplete && folderIndex.length ? [text('index_limit', `Newest first within the loaded set. Index limited to ${folderIndexLimit} records; more mail may exist.`, 'caption')] : []),
      ...(searchOpen?[
        stack('search_controls', [input('query', 'Search', query,providerBrowse?'Search mail':'Search loaded mail'),button('search', 'Search', 'secondary'),...(providerBrowse?[button('toggle_filters','Filters','ghost',{selected:filtersOpen})]:[])], {layout: 'horizontal'}),
        text('search_scope',providerBrowse?`Searches ${folderLabel()} in the current account. Unsupported filters are reported without broadening the search.`:'Searches subject and people in loaded mail across folders. Message text is not searched.','caption'),
        ...(providerBrowse&&filtersOpen?[stack('search_filters',[
          ...[['from','From'],['to','To'],['cc','Cc'],['bcc','Bcc'],['subject','Subject'],['filename','Attachment name'],['received_on','On date'],['after','After'],['before','Before']].map(([key,label])=>input('filter_'+key,label,searchFields[key]||'', ['received_on','after','before'].includes(key)?'YYYY-MM-DD':label)),
          stack('search_flags',[...['has_attachments','unread','flagged'].map(key=>button('filter_'+key,({has_attachments:'Has attachments',unread:'Unread',flagged:'Starred'})[key],'ghost',{selected:searchFields[key]===true})),button('clear_filters','Clear filters','ghost')],{layout:'horizontal'}),
        ],{layout:'list'})]:[]),
        ...(browseAvailable?[stack('mail_source',[button('browse_mailbox','Current mailbox','ghost',{selected:providerBrowse}),button('loaded_mail','Loaded mail','ghost',{selected:!providerBrowse})],{layout:'horizontal'})]:[]),
        button('close_search','Close search','ghost',{icon:'close'}),
      ]:[]),
      ...(!searchOpen&&searchedQuery?[text('search_query',`“${compact(searchedQuery,200)}” · ${providerBrowse?folderLabel()+' mailbox':'loaded mail across folders'}`,'caption')]:[]),
      stack('message_rows', rows.length ? rows.map((item, index) => {
        const data = cache.get(item.record_id);
        const row=button(`${searchedQuery ? 'hit' : 'mail'}_${index}`, scalar(data, 'subject') || item.label || '(No subject)', 'list', {
          eyebrow: compact(rowSender(data), 128), meta: rowMeta(data), description: searchedQuery ? compact(item.snippet || data?.document?.plain_text || scalar(data, 'body'), 140) : messagePreview(data), selected: selectedId === item.record_id,
        });
        return selectionMode?stack(`select_row_${index}`,[button(`select_record_${index}`,selectedRecords.has(item.record_id)?'Selected':'Select','ghost',{selected:selectedRecords.has(item.record_id)}),row],{layout:'horizontal'}):row;
      }) : [text('empty_inbox', busy ? (status||'Loading messages…') : mailboxState==='failed'?(status||'Messages are unavailable. Refresh to retry.'):searchedQuery ? searchComplete ? `No matches in ${providerBrowse?'this mailbox search':'loaded mail'}.` : 'No matches on this search page. Continue searching for more.' : providerBrowse?'No messages on this mailbox page.':`No loaded messages in ${folderLabel()}.`, 'muted'),...(!busy&&!searchedQuery&&mailboxState!=='failed'?[text('empty_inbox_help',folder==='sent'?'Sent messages appear after they are available from your account. Refresh to check again.':folder==='archive'?'Archived messages appear here when reported by your account.': 'Refresh to check for mail, or compose a message.','caption')]:[])], {layout: 'list'}),
      ...(selectionMode&&selectedRecords.size?[text('selection_count',`${selectedRecords.size} selected`,'caption'),triageControls('bulk_')]:[]),
      ...(searchedQuery && searchCursor ? [button('more_search', 'Continue search', 'ghost')] : []),
      ...(!searchedQuery && (pageIndex || cursor) ? [stack('page_controls', [...((providerBrowse?providerHistoryIndex>0:pageIndex>0) ? [button('previous_page', 'Previous', 'ghost')] : []),...(providerBrowse&&pageIndex?[button('first_page','First page','ghost')]:[]), text('page_number', `Page ${pageIndex + 1}`, 'caption'), ...(cursor ? [button('more', 'Next', 'ghost')] : [])], {layout: 'horizontal'})] : []),
      ...(searchedQuery ? [button('clear_search', `Back to ${folder}`, 'ghost')] : [])];
    if (mode==='drafts') list=[
      stack('drafts_list_heading',[stack('inbox_title',[text('draft_list_title','Drafts','heading'),text('draft_count',`${draftRows.length} saved ${draftRows.length===1?'draft':'drafts'}`,'caption')]),headerActions(false)],{layout:'toolbar'}),
      stack('draft_rows',draftRows.length?draftRows.map((row,index)=>button(`draft_open_${index}`,compact(row.subject,200)||'(No subject)','list',{eyebrow:compact(row.to,128)||'No recipient yet',meta:compactDate(row.updated_at),description:compact(row.body,140)||'Empty draft',selected:row.record_id===drafts.current.id})):[text('drafts_empty',draftListState==='loading'?'Loading saved drafts…':draftListState==='failed'?'Saved drafts are unavailable. Refresh to retry.':'No saved drafts.','muted')],{layout:'list'}),
      ...(currentDraft?[button('resume_local','Resume current draft','ghost')]:[]),
    ];
    const detail = [stack('mobile_back', [button('back', mode==='drafts'?'Back to drafts':'Back to '+folderLabel(), 'ghost')], {mobile: 'only'})];
    if (mode === 'drafts') {
      detail.push(text('drafts_heading','Choose a saved draft','heading'),text('drafts_limits','Saved drafts remain private and expire after 30 days.','caption'),
        ...(drafts.current.id?[text('drafts_current_status',drafts.current.status,'caption')]:[]));
    } else if (mode === 'activity') {
      detail.push(stack('activity_heading', [text('requests_heading', 'Activity', 'heading'),button('close_requests',currentDraft?'Back to draft':mail?'Back to message':'Back to '+folderLabel(),'ghost',{icon:'back'})],{layout:'toolbar'}), text('activity_help','Check outcomes; nothing is retried automatically. Removal permanently deletes this saved Activity copy and its unshared submitted draft. Run receipts and mail remain; inaccessible drafts are kept.','caption'));
      if (!actions.length) detail.push(text('requests_empty', journalReady?'No activity yet.':'Activity is unavailable. Refresh to retry.', 'muted'));
      const activityRows=[];
      for (const [index, action] of actions.entries()) activityRows.push(stack(`action_${index}`, [
        text(`action_summary_${index}`, ['triage_message','permanent_delete_message'].includes(action.actionKey)?action.summary.replace(/ · [a-f0-9]{64}$/i,''):action.summary, 'caption'),
        ...(expandedReceiptRun===(action.runId||action.id)&&['triage_message','permanent_delete_message'].includes(action.actionKey)?[text(`action_identity_${index}`,action.summary,'caption')]:[]),
        text(`action_state_${index}`, actionState(action.state, action.actionKey), 'muted'),
        ...(action.draftPreserved?[text(`action_draft_kept_${index}`,'Older saved draft kept because this version cannot access it.','caption')]:[]),
        ...(receipts.has(action.runId)?[text(`action_items_${index}`,receipts.get(action.runId).summary,'caption'),...(expandedReceiptRun===action.runId?receipts.get(action.runId).items.map((item,i)=>text(`action_item_${index}_${i}`,`${compact(scalar(cache.get(item.recordId),'subject'),128)||'Message '+(i+1)} · ${({succeeded:'Completed',failed:'Failed',unknown:'Outcome unknown'})[item.state]}${item.code?' · '+item.code.toLowerCase().replaceAll('_',' '):''}`,'caption')):[])]:[]),
        stack(`action_controls_${index}`,[
        button(`run_check_${index}`, 'Check status', 'ghost'),
          ...(receipts.has(action.runId)||['triage_message','permanent_delete_message'].includes(action.actionKey)?[button(`run_details_${index}`,expandedReceiptRun===(action.runId||action.id)?'Hide details':'Show details','ghost')]:[]),
          ...(receipts.get(action.runId)?.undoAvailable?[button(`run_undo_${index}`,'Undo completed items','ghost')]:[]),
          ...(action.runId ? [button(`run_review_${index}`,['pending_approval','approval_pending'].includes(action.state)?'Review request':'View outcome','secondary')] : []),
          ...(action.sourceId ? [button(`run_source_${index}`, 'Open message', 'ghost')] : []),
          ...(['succeeded','failed','denied','cancelled','expired'].includes(action.state)&&action.runId ? [button(`run_remove_${index}`,'Remove from activity','ghost')] : []),
        ], {layout:'horizontal'}),
      ], {title:action.label,layout:'list'}));
      if(activityRows.length)detail.push(stack('activity_rows',activityRows,{layout:'list'}));
    } else if (composing) {
      detail.push(stack('compose_heading',[text('compose_title', mode === 'reply' ? 'Reply draft' : mode === 'reply_all' ? 'Reply all draft' : 'Message draft', 'heading'),button('discard', 'Close draft', 'ghost')],{layout:'toolbar'}),
        text('compose_subject',subject || '(No subject)'),
        text('compose_recipient',to ? `To: ${to}` : 'No recipient yet','caption'),
        text('compose_notice', 'Continue in the composer. Your saved copy stays available in Drafts.', 'caption'),
        text('draft_save_status',drafts.current.status,'caption'),
        stack('compose_controls', [...(signature.current.available&&signature.current.value.trim()?[button('insert_signature','Insert signature','ghost')]:[]),button('open_composer','Continue draft','primary'),
          ...(drafts.current.id?[button('delete_draft','Delete saved copy','ghost')]:[]),
          ...(drafts.current.blocked?[button('copy_draft','Save separate copy','ghost')]:[])], {layout: 'horizontal'}));
    } else if (mail) {
      const thread = related(mail);
      const coverage=workerConversationCoverage(conversation?.coverage,{count:conversation?.members.size||1,complete:conversation?.complete===true,failed:conversation?.failed===true||conversation?.documentFailed===true,limited:conversation?.limited===true});
      const canReply=!busy&&journalReady&&Boolean(mail.document?.reply_context)&&!mail.document.truncated;
      const canForward=!busy&&journalReady&&Boolean(mail.document?.forward_context)&&!mail.document.truncated;
      detail.push(stack('reader_heading',[
        text('mail_subject', scalar(mail, 'subject') || '(No subject)', 'heading'),
        stack('reader_heading_actions',[
          button('triage_archive','Archive','ghost',{icon:'archive',disabled:busy||!journalReady||scalar(mail,'folder')==='archive'}),
          button('toggle_actions','More','ghost',{selected:actionsOpen}),
          button('toggle_details',detailsOpen?'Hide details':'Details','ghost',{selected:detailsOpen}),
        ],{layout:'horizontal'}),
      ],{layout:'toolbar'}),
        ...(detailsOpen||conversationOpen?[text('conversation_coverage',conversation?.provider?`${thread.length} headers on conversation page ${conversation.historyStart+conversation.historyIndex+1}${conversation.observed_at?' · as of '+conversation.observed_at:''}${conversation.failed?' · some headers unavailable':''}${conversation.documentFailed?' · message text needs reload':''}`:coverage.notice,'caption')]:[]),
        ...(detailsOpen&&coverage.mailbox_notice?[text('mailbox_coverage',coverage.mailbox_notice,'caption')]:[]),
        ...(conversation?[
          ...(thread.length>1||conversation.failed||conversation.documentFailed||!conversation.complete&&!conversation.limited&&(!conversation.provider||conversation.cursor)?[button('toggle_conversation',conversationOpen?'Hide conversation':coverage.confirmed?`Conversation · ${thread.length} messages`:thread.length>1?`Conversation · ${thread.length} loaded headers`:'Conversation details','ghost',{selected:conversationOpen})]:[]),
          ...(conversationOpen?[stack('conversation_headers',thread.map((other,index)=>button(`conversation_${index}`,compact(scalar(other,'subject')||'(No subject)',96),'list',{selected:other.record_id===selectedId,eyebrow:compact(rowSender(other),80),meta:compact(rowMeta(other),80)})),{layout:'list'}),
          ...(conversation.provider&&conversation.historyIndex>0?[button('previous_conversation','Previous headers','secondary')]:[]),
          ...(conversation.provider&&(conversation.historyStart+conversation.historyIndex)>0?[button('first_conversation','First headers','secondary')]:[]),
          ...(!conversation.complete&&!conversation.limited&&(!conversation.provider||conversation.cursor)?[button('more_conversation',conversation.provider?'Next headers':'Load more conversation headers','ghost')]:[])]:[])]:[]),
        stack('sender_summary',[stack('sender_identity',[text('sender_name',mailboxDisplay(scalar(mail,'sender'))||'Sender unavailable'),...(scalar(mail,'recipients')?[text('recipient_summary',`To: ${compact(mailboxDisplay(scalar(mail,'recipients')),160)}`,'caption')]:[])]),text('message_date',displayDate(mail)||'Date unavailable','caption')],{layout:'horizontal'}),
        ...(detailsOpen?[stack('mail_metadata', [text('mail_sender', `From: ${scalar(mail, 'sender') || 'Not available'}`, 'caption'),
          text('mail_recipients', `To: ${scalar(mail, 'recipients') || 'Not available'}`, 'caption'),
          ...(scalar(mail,'cc')?[text('mail_cc',`Cc: ${scalar(mail,'cc')}`,'caption')]:[]),
          text('mail_date_flags',[displayDate(mail),typeof mail.seen==='boolean'?(mail.seen?'Read':'Unread')+(mail.answered?' · Answered':'')+(mail.flagged?' · Starred':''):'Read status unavailable'].filter(Boolean).join(' · '),'caption'),
          ...(mail.document?[button('load_document','Reload message text','ghost')]:[]),
          button('files_followups','Saved files and follow-ups','ghost'),
          button('original_source','Download original (.eml)','ghost'),
        ], {layout: 'list'})]:[]),
        ...(actionsOpen?[triageControls(),...(mail.document?[button('print_message','Print','ghost')]:[])]:[]),
        mail.document ? displayDocument(mail) : retainedDocument(mail) ? displayDocument({...mail,document:retainedDocument(mail)}) : text('mail_body','Message text has not been loaded.','body'),
        ...(!mail.document&&retainedDocument(mail)?[text('retained_body_notice','Previously loaded message · checking latest text…','caption')]:[]),
        ...(mail.document&&new TextEncoder().encode(mail.document.content).byteLength>16384?[text('display_limit','Message text display limit reached.','caption')]:[]),
        ...(mail.document?.truncated ? [text('body_limit',mail.full_body_status==='available'?'More message text is available as a file in Saved files.':'Only part of this message text is available.','caption')] : []),
        ...(!mail.document&&!retainedDocument(mail)?[button('load_document','Load message text','secondary')]:[]),
        ...(mail.attachment_metadata_complete!==true || mail.attachment_count>0 ? [stack('attachments',[
          ...(mail.attachment_metadata_complete===true||detailsOpen?[text('attachment_summary',mail.attachment_metadata_complete===true?`${mail.attachment_count} ${mail.attachment_count===1?'attachment':'attachments'} · ${mail.downloadable_attachment_count} available in Saved files${mail.skipped_attachment_count?` · ${mail.skipped_attachment_count} skipped`:''}`:'Attachment details have not been loaded. Check Saved files for available downloads.','caption')]:[]),
          button('open_attachments','View attachments','ghost'),
        ],{layout:'horizontal'})]:[]),
        stack('reader_controls', [button('reply', 'Reply', 'secondary', {disabled: !canReply}),button('reply_all','Reply all','ghost',{disabled:!canReply}),button('forward','Forward','ghost',{disabled:!canForward})], {layout: 'horizontal'}),
        ...(!canReply&&!busy?[text('reply_help',!journalReady?'Refresh to restore Activity before replying.':!mail.document?'Load the message text to reply.':mail.document.truncated?'Reply is unavailable for partial message text.':!mail.document.reply_context?'Reply is unavailable because complete reply headers are missing.':'','caption')]:[]),
        ...(!conversation&&thread.length > 1 ? [text('thread_scope', `${thread.length} related messages on this page`, 'caption'),stack('related_messages',thread.filter(other => other !== mail).slice(0, 10).map((other, index) => button(`thread_${index}`, scalar(other, 'subject') || '(No subject)', 'list', {eyebrow: compact(rowSender(other), 128), meta: rowMeta(other), description: messagePreview(other)})),{layout:'list'})] : []));
    } else if(mailboxState!=='loading')detail.push(text('reader_empty',rows.length ? 'Choose a message to read.' : 'No message selected.', 'muted'),text('reader_empty_help','Choose a folder, search your mail, or compose a message.','caption'));
    if(status&&!(mode==='reader'&&!rows.length&&['loading','failed'].includes(mailboxState)))(mobilePane==='reader'?detail:list).push(stack('activity',[text('status',status,'muted')]));
    const view={preferences:stack('email_preferences',[input('signature_value','Signature',signature.current.value,'Your signature',true),text('signature_status',signature.current.status,'caption'),stack('signature_buttons',[button('signature_save','Save signature','primary',{disabled:busy||!signature.current.available}),button('signature_reload','Reload saved signature','ghost')],{layout:'horizontal'})]),navigation, root: stack('email', [
      stack('workspace', [stack('inbox_panel', list, {surface: 'sidebar', ...(mobilePane === 'reader' ? {mobile: 'hidden'} : {})}),
        stack('reader_panel', detail, {surface: 'document', ...(mobilePane === 'list' ? {mobile: 'hidden'} : {})})], {layout: 'split'}),
    ], {layout: 'workspace'})};
    // The wire limit counts UTF-8 bytes, including header labels and JSON.
    // Clip display text only; the governed document and Reply parent stay exact.
    const renderBytes=()=>new TextEncoder().encode(JSON.stringify(view)).byteLength;
    if(conversation&&renderBytes()>60*1024){
      const headers=detail.find(node=>node.id==='conversation_headers');
      for(const node of headers?.children||[])for(const key of ['label','eyebrow','meta'])if(node[key])node[key]=compact(node[key],32);
      for(const node of detail.find(node=>node.id==='mail_metadata')?.children||[])if(node.kind==='text')node.text=node.text.slice(0,256);
      let excess=renderBytes()-(60*1024-256),clipped=false;
      for(const node of detail.filter(node=>node.id==='mail_body').reverse()){
        if(excess<=0)break;const original=new TextEncoder().encode(JSON.stringify(node)).byteLength;
        const budget=Math.max(0,original-excess-256);let kept='',bytes=0;
        for(const character of mail?.document?.plain_text||node.text||''){const size=new TextEncoder().encode(character).byteLength;if(bytes+size>budget)break;kept+=character;bytes+=size;}
        if(node.kind==='document'){node.format='plain';node.content=kept;node.truncated=true;}else node.text=kept;
        excess-=original-new TextEncoder().encode(JSON.stringify(node)).byteLength;clipped=true;
      }
      if(clipped&&!detail.some(node=>node.id==='display_limit'))detail.push(text('display_limit','Message text display limit reached.','caption'));
    }
    sdk.render(view);
  }

  async function loadDocument(){
    const id=selectedId,mail=selected(),generation=++documentGeneration;if(!mail)return;
    for(const other of cache.values())if(other!==mail){other.document=null;other.headers_complete=false;}
    try{const document=currentWorkerDocument(await sdk.readResourceDocument('inbox',id),mail);if(generation!==documentGeneration||selectedId!==id||cache.get(id)!==mail)return;retainedPresentation=null;mail.document=document;mail.headers_complete=Boolean(document.reply_context);if(conversation?.account_id===mail.account_id&&conversation.conversation_id===mail.conversation_id){conversation.coverage=document.coverage;conversation.documentFailed=false;}status='';}
    catch{if(generation!==documentGeneration||selectedId!==id||cache.get(id)!==mail)return;retainedPresentation=null;mail.document=null;mail.headers_complete=false;if(conversation)conversation.documentFailed=true;status=providerBrowse?'Message text is unavailable. Refresh the mailbox, select the message, then load its text again.':'Message text is unavailable. Check account access, then retry.';}
  }
  async function loadConversation(direction='next'){
    const mail=selected();if(!mail)return;
    if(providerBrowse){
      if(!conversation?.provider||conversation.account_id!==mail.account_id||conversation.conversation_id!==mail.conversation_id){
        conversation={provider:true,account_id:mail.account_id,conversation_id:mail.conversation_id,source_record_id:mail.record_id,members:new Map(),history:[null],historyIndex:0,historyStart:0,cursor:null,complete:false,failed:false,limited:false,documentFailed:!mail.document,coverage:mail.document?.coverage};direction='first';
      }
      const current=conversation;
      let history=current.history.slice(),index=current.historyIndex,start=current.historyStart;
      if(direction==='first'){history=[null];index=0;start=0;}
      else if(direction==='previous')index=Math.max(0,index-1);
      else{if(!current.cursor)return;history=history.slice(0,index+1);history.push(current.cursor);index++;if(history.length>32){history.shift();index--;start++;}}
      try{const page=await sdk.browseResourceRecords('inbox',{operation:'conversation',folder:'all',record_id:current.source_record_id,...(history[index]?{cursor:history[index]}:{})});
        rememberPage(page);const members=new Map();for(const item of page.items){const other=cache.get(item.record_id);if(other.account_id!==current.account_id||other.conversation_id!==current.conversation_id)throw Error('EMAIL_CONVERSATION_SCOPE_CHANGED');members.set(other.record_id,other);}
        current.members=members;current.history=history;current.historyIndex=index;current.historyStart=start;current.cursor=page.next_cursor;current.complete=page.complete;current.failed=page.failure_count>0;current.observed_at=page.observed_at;current.documentFailed=!selected()?.document;
        status=page.failure_count?'Some conversation headers are unavailable. Refresh the message to retry.':'';
      }catch{current.failed=true;status='Conversation headers are unavailable. Refresh the mailbox, then try again.';}
      return;
    }
    if(!conversation||conversation.account_id!==mail.account_id||conversation.conversation_id!==mail.conversation_id){
      conversation={account_id:mail.account_id,conversation_id:mail.conversation_id,members:new Map([[mail.record_id,mail]]),cursor:null,cursors:new Set(),pages:0,scanned:0,complete:false,failed:false,documentFailed:!mail.document,limited:false,coverage:mail.document?.coverage};
    }
    const current=conversation;if(current.complete||current.limited)return;
    try{
      const page=await sdk.searchResourceRecords('inbox',{query:current.conversation_id,field_keys:['conversation_id'],...(current.cursor?{cursor:current.cursor}:{})});
      current.pages++;
      const records=page.items.slice(0,conversationLimit-current.scanned);current.scanned+=records.length;
      const results=await Promise.allSettled(records.map(item=>readRecord(item.record_id)));
      for(const result of results){
        if(result.status!=='fulfilled'){current.failed=true;continue;}
        const other=result.value;
        if(other.account_id!==current.account_id||other.conversation_id!==current.conversation_id){current.failed=true;continue;}
        if(current.members.size<conversationLimit||current.members.has(other.record_id))current.members.set(other.record_id,other);else current.limited=true;
      }
      const next=page.next_cursor;
      if(!next){current.complete=page.scan.complete===true&&records.length===page.items.length;current.cursor=null;}
      else if(!records.length||current.cursors.has(next)){current.failed=true;current.limited=true;current.cursor=null;}
      else{current.cursors.add(next);current.cursor=next;}
      if(records.length<page.items.length||!current.complete&&(current.scanned>=conversationLimit||current.pages>=conversationPageLimit))current.limited=true;
    }catch{current.failed=true;status='Some conversation headers are unavailable. Load more to retry.';}
  }

  async function openHostComposer() {
    if (!journalReady) throw Error('REQUEST_JOURNAL_UNAVAILABLE');
    if(subject!==''&&!draftSubjectValid(subject)){status='Use a subject of up to 200 characters without line breaks or null characters.';return;}
    const key='send_message';
    if(!drafts.current.id) drafts.use(createDraftId());
    await drafts.save();
    if(drafts.current.blocked||drafts.current.dirty>drafts.current.written)throw Error('DRAFT_SAVE_UNCONFIRMED');
    const prior=actions.find(entry=>entry.draftId===drafts.current.id);
    if(prior){status=prior.runId?'This draft has an existing request. Check Activity for its outcome.':'This draft has a request with an unknown outcome. Check Activity; do not resend.';return;}
    const mail=selected();
    if(['reply','reply_all'].includes(mode)&&(!mail?.document||mail.document.truncated||reply_record_id!==selectedId))throw Error('REPLY_PARENT_UNAVAILABLE');
    const data={to,cc,bcc,subject,body,body_html,parent_record_id:['reply','reply_all'].includes(mode)?reply_record_id:''};
    const entry=prior||await journal.reserve({actionKey:key,label:mode==='reply'?'Reply':'Send',summary:`${to} · ${subject}`.slice(0,400),sourceId:['reply','reply_all'].includes(mode)?selectedId:null,draftId:drafts.current.id});
    try{
      const result=await sdk.request('dialog','compose_action',{action_key:key,input:data,draft_state_key:'drafts',draft_id:drafts.current.id});
      if(result?.cancelled===true){await journal.cancelUnsubmitted(entry);try{const saved=await drafts.read(drafts.current.id);to=saved.value.to;cc=saved.value.cc||'';bcc=saved.value.bcc||'';body_html=saved.value.body_html||'';reply_record_id=saved.value.reply_record_id||'';subject=saved.value.subject;body=saved.value.body;drafts.use(saved.record_id,saved.revision);}catch{}status='Draft kept. No action was submitted.';return;}
      if(!result?.run?.id){try{const saved=await drafts.read(drafts.current.id);to=saved.value.to;cc=saved.value.cc||'';bcc=saved.value.bcc||'';body_html=saved.value.body_html||'';reply_record_id=saved.value.reply_record_id||'';subject=saved.value.subject;body=saved.value.body;drafts.use(saved.record_id,saved.revision);}catch{}status='Action outcome unknown. Check history; do not resend.';return;}
      const submitted = result.run.submitted_input;
      entry.summary=typeof submitted?.to==='string'&&typeof submitted?.subject==='string'
        ? `${submitted.to} · ${submitted.subject}`.slice(0,400)
        : 'Submitted message details unavailable.';
      // A known Run must survive a later unavailable draft read.
      await journal.update(entry,result.run);
      try{const saved=await drafts.read(drafts.current.id);to=saved.value.to;cc=saved.value.cc||'';bcc=saved.value.bcc||'';body_html=saved.value.body_html||'';reply_record_id=saved.value.reply_record_id||'';subject=saved.value.subject;body=saved.value.body;drafts.use(saved.record_id,saved.revision);}catch{}
      drafts.close();mode='reader';to='';cc='';bcc='';body_html='';reply_record_id='';subject='';body='';drafts.use();status=actionState(entry.state,entry.actionKey);
    }catch{status='Action outcome unknown. Your saved draft remains available. Do not resend automatically.';}
  }

  function actionState(state, actionKey) {
    if (['pending_approval', 'approval_pending'].includes(state)) return 'Waiting for your approval.';
    if (state === 'succeeded') return ['archive_message','triage_message','permanent_delete_message'].includes(actionKey) ? 'Mailbox request completed. View outcome for each item; partial or unknown results are not retried automatically.' : 'Send completed. View outcome for the provider result. Mail server acceptance does not confirm delivery.';
    if (['failed', 'denied', 'cancelled', 'expired'].includes(state)) return `${state[0].toUpperCase() + state.slice(1)}. No automatic retry.`;
    if (['pending', 'queued', 'running', 'claimed', 'started'].includes(state)) return 'In progress. Waiting for the provider outcome.';
    return 'Outcome unknown. Check approval or its receipt; do not resend automatically.';
  }
  function selectedIdentity(){const mail=selected();return mail?{account_id:mail.account_id,logical_message_id:mail.logical_message_id,loaded:Boolean(mail.document),mail:{...mail},document:mail.document}:null;}
  async function restoreRefreshedSelection(previousIdentity,rows){
    // Logical identity reconciles presentation only. Every document/action still
    // uses a newly governed record reference and freshly checked metadata.
    const matches=previousIdentity?rows.filter(item=>{const mail=cache.get(item.record_id);return mail?.account_id===previousIdentity.account_id&&mail?.logical_message_id===previousIdentity.logical_message_id;}):[];
    selectedId=matches.length===1?matches[0].record_id:rows[0]?.record_id||null;
    retainedPresentation=matches.length===1&&previousIdentity.loaded?previousIdentity:null;
    if(matches.length===1&&previousIdentity.loaded){status='Refreshing message…';render();await loadDocument();}
  }
  async function refreshSearch(){
    const previousIdentity=selectedIdentity(),committedQuery=searchedQuery,filters=searchedFilters,currentAccountFilter=accountFilter;
    retainedPresentation=null;
    selectedRecords.clear();actionsOpen=false;triagePicker=null;
    mailboxState='loading';status='Refreshing search results…';render();
    try{
      const page=providerBrowse?await sdk.browseResourceRecords('inbox',{operation:'search',folder,filters}):await sdk.searchResourceRecords('inbox',{query:committedQuery,field_keys:EMAIL_METADATA_SEARCH_FIELDS});
      if(accountFilter!==currentAccountFilter)return;
      conversation=null;conversationOpen=false;detailsOpen=false;
      for(const mail of cache.values()){mail.document=null;mail.headers_complete=false;}
      if(providerBrowse)rememberPage(page);
      hits=page.items;searchCursor=page.next_cursor;searchComplete=providerBrowse?page.complete:page.scan.complete;
      await Promise.all(hits.map(hit=>readRecord(hit.record_id)));
      if(accountFilter!==currentAccountFilter)return;
      mailboxState='ready';status='';await restoreRefreshedSelection(previousIdentity,hits);
      if(!status&&page.failure_count)status='Some search results are unavailable. Refresh to retry.';
    }catch(error){retainedPresentation=null;hits=[];selectedId=null;conversation=null;conversationOpen=false;cache.clear();mailboxState='failed';throw error;}
  }
  async function loadInbox(reset, backwards = false, retain = false) {
    const previousIdentity=retain?selectedIdentity():null,currentAccountFilter=accountFilter;
    retainedPresentation=null;
    selectedRecords.clear();actionsOpen=false;triagePicker=null;searchedFilters=null;
    if(!retain){conversation=null;conversationOpen=false;detailsOpen=false;for(const mail of cache.values()){mail.document=null;mail.headers_complete=false;}}
    if(reset&&!retain){items=[];folderIndex=[];selectedId=null;cursor=null;hits=[];searchedQuery='';searchCursor=null;searchComplete=false;}
    mailboxState='loading';
    status = retain?'Refreshing messages…':''; render();
    try{
    if(providerBrowse){
      let history=reset?[null]:providerHistory.slice(),index=reset?0:providerHistoryIndex,start=reset?0:providerHistoryStart;
      if(!reset&&backwards)index=Math.max(0,index-1);
      else if(!reset){if(!cursor)return;history=history.slice(0,index+1);history.push(cursor);index++;if(history.length>32){history.shift();index--;start++;}}
      const page=await sdk.browseResourceRecords('inbox',{operation:'list',folder,...(history[index]?{cursor:history[index]}:{})});
      if(accountFilter!==currentAccountFilter)return;
      // Retained content is presentation only until the fresh scoped page arrives.
      // Never reuse its expired document as authorization for Reply or Forward.
      if(retain){conversation=null;conversationOpen=false;detailsOpen=false;for(const mail of cache.values()){mail.document=null;mail.headers_complete=false;}}
      rememberPage(page);items=page.items;folderIndex=items;cursor=page.next_cursor;folderComplete=page.complete;providerObservedAt=page.observed_at;
      providerHistory=history;providerHistoryIndex=index;providerHistoryStart=start;pageIndex=start+index;
      hits=[];searchedQuery='';searchCursor=null;searchComplete=false;mode='reader';
      mailboxState='ready';status='';await restoreRefreshedSelection(previousIdentity,items);
      if(!status&&page.failure_count)status='Some messages are unavailable. Use Refresh to restart browsing.';return;
    }
    if (reset) {
      conversation=null;
      cache.clear();
      const indexed = new Map(), seenCursors = new Set();
      let next = null, scanned = 0;
      folderComplete = false;
      do {
        const page = await sdk.searchResourceRecords('inbox', {query:'true',field_keys:['in_'+folder],...(next ? {cursor:next}:{})});
        const bounded = page.items.slice(0, folderIndexLimit - scanned);
        scanned += bounded.length;
        const records = await Promise.all(bounded.map(async item => ({item,mail:await readRecord(item.record_id)})));
        for (const {item,mail} of records) if (emailMetadataInFolder(mail,folder)&&(!accountFilter||mail.account_id===accountFilter)) indexed.set(item.record_id, {...item,date:Date.parse(scalar(mail,'date'))||0});
        next = page.next_cursor;
        if (!next) { folderComplete = bounded.length === page.items.length && page.scan.complete === true; break; }
        if (seenCursors.has(next)) break;
        seenCursors.add(next);
      } while (scanned < folderIndexLimit && seenCursors.size < 10);
      folderIndex = [...indexed.values()].sort((a,b)=>b.date-a.date||a.record_id.localeCompare(b.record_id));
      pageIndex = 0;
    } else if (backwards) pageIndex = Math.max(0,pageIndex-1);
    else if ((pageIndex+1)*pageSize < folderIndex.length) pageIndex++;
    items = folderIndex.slice(pageIndex*pageSize,(pageIndex+1)*pageSize);
    await Promise.all(items.map(item=>readRecord(item.record_id)));
    if(accountFilter!==currentAccountFilter)return;
    cursor = (pageIndex+1)*pageSize < folderIndex.length ? 'local-next' : null;
    hits = []; searchedQuery = ''; searchCursor = null; searchComplete = false;
    mode = 'reader'; status = '';mailboxState='ready';await restoreRefreshedSelection(previousIdentity,items);
    }catch(error){retainedPresentation=null;items=[];folderIndex=[];selectedId=null;hits=[];conversation=null;conversationOpen=false;cache.clear();mailboxState='failed';throw error;}
  }
  async function select(recordId) {
    retainedPresentation=null;triagePicker=null;actionsOpen=false;
    await readRecord(recordId);
    const next=cache.get(recordId);
    if(!conversation||conversation.account_id!==next.account_id||conversation.conversation_id!==next.conversation_id)conversationOpen=false;
    detailsOpen=false;selectedId = recordId; mode = 'reader'; mobilePane = 'reader';
    status='Loading message…';render();
    await loadDocument();
    if(!conversation||conversation.account_id!==selected().account_id||conversation.conversation_id!==selected().conversation_id)await loadConversation();
  }
  async function loadDrafts(){
    if(['compose','reply','reply_all','forward'].includes(mode)){retainedDraftMode=mode;await drafts.save();}
    const request=++draftListGeneration;
    mode='drafts';mobilePane='list';draftRows=[];draftListState='loading';status='Loading drafts…';render();
    try{
    if(!await loadActivity()){draftListState='failed';return;}
    const submitted=new Set(actions.filter(entry=>entry.runId&&entry.draftId).map(entry=>entry.draftId));
    const rows=await drafts.list(),loaded=[];
    for(const row of rows.slice(0,32)){
      if(submitted.has(row.record_id))continue;
      const saved=await drafts.read(row.record_id);
      if(saved.value?.mode==='submitted')continue;
      loaded.push({...row,subject:typeof saved.value?.subject==='string'?saved.value.subject:'',to:typeof saved.value?.to==='string'?saved.value.to:'',body:typeof saved.value?.body==='string'?saved.value.body:''});
    }
    if(request!==draftListGeneration)return;draftRows=loaded;draftListState='ready';status='';
    }catch(error){draftListState='failed';throw error;}
  }
  sdk.onEvent(async ui => {
    if (ui.kind === 'input') {
      if (ui.node_id === 'query') { query = ui.value.slice(0,200); searchCursor = null; }
      if(/^filter_(from|to|cc|bcc|subject|filename|received_on|after|before)$/.test(ui.node_id)){searchFields[ui.node_id.slice(7)]=ui.value.slice(0,500);searchCursor=null;}
      if(ui.node_id==='account'){const next=ui.value.slice(0,200);if(next!==accountFilter){accountFilter=next;documentGeneration++;retainedPresentation=null;selectedId=null;conversation=null;conversationOpen=false;for(const mail of cache.values()){mail.document=null;mail.headers_complete=false;}render();}return;}
      if(ui.node_id==='cc')cc=ui.value;
      if (ui.node_id === 'to') to = ui.value;
      if (ui.node_id === 'subject') subject = ui.value;
      if (ui.node_id === 'body') body = ui.value;
      if(ui.node_id==='signature_value')signature.edit(ui.value);
      if (['to','cc','subject','body'].includes(ui.node_id) && ['compose','reply','reply_all','forward'].includes(mode)) drafts.change();
      return;
    }
    if (busy) return;
    if (['compose','reply','reply_all','forward'].includes(mode) && (to || subject || body) && !['compose','open_composer', 'discard', 'back','save_draft','delete_draft','copy_draft','drafts','requests','insert_signature','signature_save','signature_reload'].includes(ui.node_id) && !/^run_check_\d+$/.test(ui.node_id)) {
      mobilePane = 'reader';
        status = 'Your draft is kept. Close it before switching messages.'; render(); return;
    }
    busy = true;
    try {
      if(ui.node_id==='toggle_search'){searchOpen=!searchOpen;}
      else if(ui.node_id==='close_search'){searchOpen=false;}
      else if(ui.node_id==='toggle_filters'){filtersOpen=!filtersOpen;}
      else if(ui.node_id==='clear_filters'){searchFields={};searchCursor=null;}
      else if(/^filter_(has_attachments|unread|flagged)$/.test(ui.node_id)){const key=ui.node_id.slice(7);if(searchFields[key])delete searchFields[key];else searchFields[key]=true;searchCursor=null;}
      else if(ui.node_id==='toggle_details'){detailsOpen=!detailsOpen;}
      else if(ui.node_id==='toggle_conversation'){conversationOpen=!conversationOpen;}
      else if(ui.node_id==='browse_mailbox'||ui.node_id==='loaded_mail'){providerBrowse=ui.node_id==='browse_mailbox';mobilePane='list';await loadInbox(true);}
      else if(ui.node_id==='apply_account'){await loadInbox(true);mobilePane='list';}
      else if (/^folder_(inbox|sent|archive|spam|trash)$/.test(ui.node_id)) { folder=ui.node_id.slice(7);if(['spam','trash'].includes(folder))providerBrowse=true;query='';searchOpen=false;mobilePane='list';await loadInbox(true); }
      else if(ui.node_id==='refresh'&&mode==='drafts')await loadDrafts();
      else if(ui.node_id==='refresh'&&mode==='activity'){status='';await refreshActivity();}
      else if(ui.node_id==='refresh'&&searchedQuery){if(!journalReady)await loadActivity();await refreshSearch();if(!journalReady)status='Activity could not be loaded. Reading is available; Compose and Archive are paused. Refresh to retry.';}
      else if (ui.node_id === 'refresh' || ui.node_id === 'first_page' || ui.node_id === 'more' || ui.node_id === 'previous_page') {if(ui.node_id==='refresh'&&!journalReady)await loadActivity();await loadInbox(['refresh','first_page'].includes(ui.node_id), ui.node_id === 'previous_page',ui.node_id==='refresh'&&!searchedQuery);if(!journalReady)status='Activity could not be loaded. Reading is available; Compose and Archive are paused. Refresh to retry.';}
      else if (ui.node_id === 'search' || ui.node_id === 'more_search') {
        let filters=null;
        if(providerBrowse){try{filters=ui.node_id==='more_search'&&searchedFilters?searchedFilters:emailSearchInput({...searchFields,...(query.trim()?{text:query.trim()}:{})});}catch{status='Enter search text or a valid filter. Use plain text and YYYY-MM-DD dates.';return;}}
        else if (!query.trim() || query.length > 200) { status = 'Enter up to 200 characters to search loaded mail.'; return; }
        conversation=null;conversationOpen=false;detailsOpen=false;mobilePane='list';for(const mail of cache.values()){mail.document=null;mail.headers_complete=false;}
        selectedRecords.clear();triagePicker=null;
        status = 'Searching mail…'; render();
        const page = providerBrowse?await sdk.browseResourceRecords('inbox',{operation:'search',folder,filters,...(ui.node_id==='more_search'&&searchCursor?{cursor:searchCursor}:{})}):await sdk.searchResourceRecords('inbox', {query, field_keys: EMAIL_METADATA_SEARCH_FIELDS,
          ...(ui.node_id === 'more_search' && searchCursor ? {cursor: searchCursor} : {})});
        if(providerBrowse)rememberPage(page);
        hits = page.items; searchedFilters=filters;searchedQuery = filters?Object.entries(filters).map(([key,value])=>key==='text'?value:`${key.replaceAll('_',' ')}: ${value}`).join(' · '):query; searchCursor = page.next_cursor; searchComplete = providerBrowse?page.complete:page.scan.complete; selectedId = null; mode = 'reader';searchOpen=false;filtersOpen=false;
        await Promise.all(hits.map(hit => readRecord(hit.record_id)));
        if (hits.length) selectedId = hits[0].record_id;
        status = providerBrowse?`${hits.length} matches on this page. ${page.failure_count?'Some search results are unavailable. Search again to retry.':searchComplete?'End of mailbox search pages as of '+page.observed_at+'.':'Continue search for more mailbox results.'}`:`${hits.length} matches. ${searchComplete?'Search of loaded mail complete.':'Continue searching for more.'}`;
      } else if (/^mail_\d+$/.test(ui.node_id)) await select(items[Number(ui.node_id.slice(5))].record_id);
      else if (/^hit_\d+$/.test(ui.node_id)) await select(hits[Number(ui.node_id.slice(4))].record_id);
      else if (/^thread_\d+$/.test(ui.node_id)) {
        const mail = selected(), other = related(mail).filter(row => row !== mail)[Number(ui.node_id.slice(7))];
        const recordId = [...cache.entries()].find(([, row]) => row === other)?.[0];
        if (recordId) await select(recordId);
      }
      else if (ui.node_id === 'clear_search') { conversation=null;conversationOpen=false;detailsOpen=false;searchOpen=false;for(const mail of cache.values()){mail.document=null;mail.headers_complete=false;}status = ''; query = ''; searchedQuery = ''; hits = []; searchCursor = null; searchComplete = false; selectedId = items[0]?.record_id || null; mobilePane = 'list'; }
      else if (ui.node_id === 'back') { if(mode==='activity')mode='reader';mobilePane = 'list'; }
      else if (ui.node_id === 'requests') { if(['compose','reply','reply_all','forward'].includes(mode)){retainedDraftMode=mode;await drafts.save();}mode = 'activity'; mobilePane = 'reader'; status = '';await refreshActivity(); }
      else if (ui.node_id === 'close_requests') { mode = drafts.current.id ? retainedDraftMode : 'reader'; mobilePane = selected()||drafts.current.id?'reader':'list'; status = ''; }
      else if (ui.node_id === 'compose') { if(!['compose','reply','reply_all','forward'].includes(mode)){if(drafts.current.id)mode=retainedDraftMode;else{drafts.use();mode='compose';to='';cc='';bcc='';body_html='';reply_record_id='';subject='';body='';}}retainedDraftMode=mode;mobilePane='reader';status='';await openHostComposer(); }
      else if (ui.node_id === 'load_document') {await loadDocument();if(!conversation)await loadConversation();}
      else if(ui.node_id==='more_conversation')await loadConversation();
      else if(ui.node_id==='previous_conversation'||ui.node_id==='first_conversation')await loadConversation(ui.node_id==='previous_conversation'?'previous':'first');
      else if(/^conversation_\d+$/.test(ui.node_id)){const other=related(selected())[Number(ui.node_id.slice(13))];if(other)await select(other.record_id);}
      else if (ui.node_id === 'open_composer') await openHostComposer();
      else if (['reply','reply_all','forward'].includes(ui.node_id)) {
        if(!selected()?.document)await loadDocument();
        const mail=selected();
        const intent=createEmailComposeIntent({mode:ui.node_id,parent:workerComposeParent(mail,ui.node_id),verifiedOwnAliases:mail.document.account.verified_sender_identities});
        drafts.use();mode=retainedDraftMode=intent.mode;mobilePane='reader';to=intent.to;cc=intent.cc;bcc='';body_html='';subject=intent.subject;body=intent.body;reply_record_id=intent.reply_record_id;
        status='';await openHostComposer();
      } else if (ui.node_id === 'discard') { drafts.close(); mode = 'reader';mobilePane='list'; to = ''; subject = ''; body = ''; drafts.use();status = 'Draft closed. Any saved copy remains.'; }
      else if(ui.node_id==='signature_save'){await signature.save();}
      else if(ui.node_id==='signature_reload'){await signature.load();}
      else if(ui.node_id==='insert_signature'){const edited=insertEmailSignature({body,body_html,signature_text:signature.current.value});body=edited.body;body_html=edited.body_html;drafts.change();await drafts.save();await openHostComposer();}
      else if (ui.node_id === 'save_draft') await drafts.save();
      else if (ui.node_id === 'copy_draft') await drafts.copy();
      else if (ui.node_id === 'delete_draft') { await drafts.remove(); status='Saved draft copy deleted.'; }
      else if (ui.node_id === 'drafts')await loadDrafts();
      else if (ui.node_id === 'resume_local') { mode=retainedDraftMode; mobilePane='reader'; }
      else if (/^draft_open_\d+$/.test(ui.node_id)) {
        const row=draftRows[Number(ui.node_id.slice(11))];if(!row)return;
        if(drafts.current.blocked&&drafts.current.dirty>drafts.current.written&&row.record_id!==drafts.current.id){status='Current draft has unsaved changes. Resume it and save a separate copy or close it before opening another.';return;}
        const saved=await drafts.read(row.record_id),value=saved.value;
        if(!value||!['body,cc,mode,reply_record_id,subject,to','bcc,body,body_html,cc,mode,reply_record_id,subject,to'].includes(Object.keys(value).sort().join(','))||!['compose','reply','reply_all','forward'].includes(value.mode)||!['to','subject','body','reply_record_id'].every(key=>typeof value[key]==='string')||value.to.length>2048||typeof value.cc!=='string'||value.cc.length>2048||value.bcc!==undefined&&(typeof value.bcc!=='string'||value.bcc.length>2048)||value.body_html!==undefined&&(typeof value.body_html!=='string'||value.body_html.length>16384)||(value.subject!==''&&!draftSubjectValid(value.subject))||value.body.length>4096||value.reply_record_id.length>36)throw Error('DRAFT_INVALID');
        mode=retainedDraftMode=value.mode;to=value.to;cc=value.cc;bcc=value.bcc||'';body_html=value.body_html||'';reply_record_id=value.reply_record_id;subject=value.subject;body=value.body;selectedId=null;drafts.use(saved.record_id,saved.revision);mobilePane='reader';
        if(['reply','reply_all'].includes(mode)&&value.reply_record_id){try{await readRecord(value.reply_record_id);selectedId=value.reply_record_id;await loadDocument();}catch{status='Original message unavailable. Reply cannot be submitted until its parent is current.';}}
        await openHostComposer();
      }
      else if (ui.node_id === 'files_followups'||ui.node_id==='open_attachments') { if(selectedId)await sdk.openResource('inbox',selectedId);
      } else if (ui.node_id === 'original_source') {if(selectedId)await sdk.openOriginalSource('inbox',selectedId);
      } else if(ui.node_id==='toggle_actions'){actionsOpen=!actionsOpen;
      } else if(ui.node_id==='select_messages'){selectionMode=!selectionMode;selectedRecords.clear();triagePicker=null;
      } else if(/^select_record_\d+$/.test(ui.node_id)){triagePicker=null;const rows=searchedQuery?hits:items,id=rows[Number(ui.node_id.slice(14))]?.record_id;if(id){if(selectedRecords.has(id))selectedRecords.delete(id);else if(selectedRecords.size<25)selectedRecords.add(id);else status='Select up to 25 messages per request.';}
      } else if(/^(bulk_)?choose_(move|labels)$/.test(ui.node_id)){await openTriagePicker(ui.node_id.endsWith('move')?'move':'labels',ui.node_id.startsWith('bulk_'));
      } else if(ui.node_id==='triage_picker_close'){triagePicker=null;
      } else if(ui.node_id==='triage_options_next'||ui.node_id==='triage_options_previous'){if(triagePicker)triagePicker.page=Math.max(0,triagePicker.page+(ui.node_id==='triage_options_next'?1:-1));
      } else if(/^triage_option_\d+$/.test(ui.node_id)){const p=triagePicker;if(p){const row=(p.kind==='move'?p.options.destinations:p.options.labels)[Number(ui.node_id.slice(14))];if(row){if(p.kind==='move'){triagePicker=null;await confirmTriage('move',p.bulk,{destination:row.id},p.ids);}else{const previous=p.labels.get(row.id);if(previous==='remove')p.labels.delete(row.id);else if(previous||p.labels.size<16)p.labels.set(row.id,previous==='add'?'remove':'add');else status='Choose up to 16 labels per change.';}}}
      } else if(ui.node_id==='triage_labels_apply'){const p=triagePicker;if(p?.kind==='labels'&&p.labels.size){triagePicker=null;await confirmTriage('labels',p.bulk,{add_labels:[...p.labels].filter(([,change])=>change==='add').map(([id])=>id),remove_labels:[...p.labels].filter(([,change])=>change==='remove').map(([id])=>id)},p.ids);}
      } else if(/^(bulk_)?triage_/.test(ui.node_id)){await confirmTriage(ui.node_id.replace(/^(bulk_)?triage_/,''),ui.node_id.startsWith('bulk_'));
      } else if (/^run_check_\d+$/.test(ui.node_id)) {
        const entry = actions[Number(ui.node_id.slice(10))];
        if (!entry?.runId) { status = 'Request outcome unknown. Check Deft Approvals; do not resend automatically.'; return; }
        try { const run = await sdk.request('run_status', undefined, {run_id: entry.runId}); if(run?.id!==entry.runId)throw Error('RUN_MISMATCH');await journal.update(entry,run);const receipt=readTriageReceipt(run);if(receipt)receipts.set(entry.runId,receipt);else receipts.delete(entry.runId);status = ''; }
        catch { status = 'Status unavailable. Last known outcome retained; no automatic retry.'; }
      } else if(/^run_details_\d+$/.test(ui.node_id)){
        const entry=actions[Number(ui.node_id.slice(12))],receipt=receipts.get(entry?.runId);if(entry&&(receipt||['triage_message','permanent_delete_message'].includes(entry.actionKey))){const identity=entry.runId||entry.id;expandedReceiptRun=expandedReceiptRun===identity?null:identity;if(expandedReceiptRun&&receipt)await Promise.allSettled(receipt.recordIds.map(id=>readRecord(id)));}
      } else if(/^run_undo_\d+$/.test(ui.node_id)){
        const original=actions[Number(ui.node_id.slice(9))],receipt=receipts.get(original?.runId);if(!receipt?.undoAvailable)return;
        await Promise.all(receipt.recordIds.map(id=>readRecord(id)));
        const {input,action_key:key,summary}=await workerTriageInput('undo',receipt.recordIds,id=>cache.get(id),{undo_of:receipt.operationId});
        if(actions.some(entry=>entry.actionKey===key&&entry.summary===summary)){status='This undo already has a request. Check Activity.';return;}
        const entry=await journal.reserve({actionKey:key,label:'Undo mailbox change',summary,sourceId:receipt.recordIds[0]});
        try{const result=await sdk.request('dialog','confirm_action',{action_key:key,input});if(result?.cancelled===true){await journal.cancelUnsubmitted(entry);return;}if(result?.run?.id)await journal.update(entry,result.run);status=actionState(entry.state,key);}catch{status='Undo outcome unknown. Check Activity before another change.';}
      } else if (/^run_review_\d+$/.test(ui.node_id)) { const entry=actions[Number(ui.node_id.slice(11))];if(entry?.runId)await sdk.request('dialog','review_run',{run_id:entry.runId});
      } else if (/^run_remove_\d+$/.test(ui.node_id)) { const entry=actions[Number(ui.node_id.slice(11))];if(entry){const result=await journal.remove(entry);status=result.draftPreserved?'Saved Activity copy removed. The inaccessible draft, Run receipt and mail are kept.':'Saved Activity copy removed. Run receipt and mail are kept.';}
      } else if (/^run_source_\d+$/.test(ui.node_id)) {
        const entry = actions[Number(ui.node_id.slice(11))]; if (entry?.sourceId) await select(entry.sourceId);

      }
    } catch (error) { status = error?.message==='REQUEST_JOURNAL_CAP'?'Activity history is full for this app and owner, including other accounts or previous versions. Open Activity to remove a completed item. If none is visible, keep the draft and ask the workspace administrator to review retained history. Pending or unknown items are kept; your saved draft remains available.': mailboxState==='failed'?'Messages are unavailable. Check your access, then use Refresh to retry.':'This request is unavailable. Check your access or approval, then try again.'; }
    finally { busy = false; render(); }
  });
  busy = true; render();
  void (async()=>{await loadActivity();await signature.load();await loadInbox(true);if(!journalReady)status='Activity could not be loaded. Reading is available; Compose and Archive are paused.';})().catch(() => { status = 'Messages are unavailable. Check your access, then refresh.'; })
    .finally(() => { busy = false; render(); });
};
