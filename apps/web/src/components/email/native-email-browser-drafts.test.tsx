import test from 'node:test';import assert from 'node:assert/strict';import {createElement} from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {readFileSync} from 'node:fs';
import {NativeEmailBrowserDraftRows,type BrowserDraftRow} from './native-email-browser-drafts';
const row:BrowserDraftRow={accountId:'account',metadata:{draftId:'11111111-1111-4111-8111-111111111111',branchId:null,localRevision:1,baseServerRevision:0,dirty:true,sendOutcome:'none',updatedAt:1}};
const render=(rows=[row],busy=false)=>renderToStaticMarkup(createElement(NativeEmailBrowserDraftRows,{rows,accounts:[{account_id:'account',primary_address:'owner@example.test',display_label:''}],busy,onOpen:()=>{},onSaved:()=>{}}));
test('browser recovery list identifies orphan and conflict copies without plaintext subject, body, recipients or Bcc',()=>{
 const html=render([row,{...row,metadata:{...row.metadata,branchId:'22222222-2222-4222-8222-222222222222',baseServerRevision:4}}]);assert.match(html,/Browser drafts/);assert.match(html,/Open browser text as new draft/);assert.match(html,/Another tab/);assert.match(html,/Open saved draft/);assert.doesNotMatch(html,/11111111|bcc|Bcc|Subject|<pre/);assert.match(html,/attachments added again/);assert.equal(render([]),'');
});
test('uncertain sending copies offer no fresh-copy action and busy recovery disables all opens',()=>{
 const html=render([{...row,metadata:{...row.metadata,sendOutcome:'unknown',baseServerRevision:4}}]);assert.match(html,/Sending outcome needs checking/);assert.match(html,/Open saved draft/);assert.doesNotMatch(html,/Open browser text as new draft/);assert.match(render([row],true),/disabled=""/);
});
test('Drafts mount passes owner identity and refreshes discovered metadata after server saves and manual refresh',()=>{
 const drafts=readFileSync(new URL('./native-email-drafts.tsx',import.meta.url),'utf8'),page=readFileSync(new URL('../../app/(app)/email/page.tsx',import.meta.url),'utf8');assert.match(drafts,/NativeEmailBrowserDrafts accounts=\{accounts\} sessionScope=\{sessionScope\} owner=\{recoveryOwner\} refreshKey=\{`\$\{revision\}\/\$\{reload\}`\}/);assert.match(page,/NativeEmailDrafts[^\n]+recoveryOwner=\{recoveryOwner\}/);
});
