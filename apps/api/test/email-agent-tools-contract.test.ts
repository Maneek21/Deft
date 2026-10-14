import test from 'node:test';
import assert from 'node:assert/strict';
import {EMAIL_TOOL_INPUTS,EMAIL_TOOL_SCHEMAS,EMAIL_AGENT_GUIDANCE,nativeEmailSendPendingAction,emailDraftInputDiagnostics} from '../src/lib/email-agent-tools.js';
import {ACTION_TOOLS} from '../src/lib/agent-tools.js';
import {validateRegisteredProposalAction,persistAgentReplyWithActions} from '../src/lib/agent-action-proposals.js';

test('model-facing new Email drafts omit technical IDs and empty fields while retaining native validation',()=>{
 const schema=EMAIL_TOOL_SCHEMAS.find(v=>v.name==='email_draft_save')!.inputSchema as any;
 assert.deepEqual(schema.required,['account_id','content']);
 assert.deepEqual(schema.properties.content.required,['to','subject','body']);
 const input=EMAIL_TOOL_INPUTS.email_draft_save.parse({account_id:'sender',content:{to:'recipient@example.test',subject:'Synthetic reply',body:'Preserved text'}});
 assert.equal(input.draft_id,undefined);assert.equal(input.expected_revision,0);assert.deepEqual(input.content,{mode:'compose',to:'recipient@example.test',cc:'',bcc:'',subject:'Synthetic reply',body:'Preserved text',body_html:'',reply_record_id:'',attachments:[]});
 assert.equal(EMAIL_TOOL_INPUTS.email_draft_save.safeParse({account_id:'sender',expected_revision:1,content:{to:'recipient@example.test',subject:'Synthetic reply',body:'Preserved text'}}).success,false,'updates still require actual saved ID');
 assert.equal(EMAIL_TOOL_INPUTS.email_draft_save.safeParse({account_id:'sender',content:{to:'recipient@example.test\r\nBcc:evil@example.test',subject:'Synthetic reply',body:'text'}}).success,false,'native header validation is retained');
});

test('draft validation diagnostics identify rejected field types without leaking values or unknown-key names',()=>{
 const privateValue='private-value-do-not-expose@example.test';
 const raw={account_id:'sender',content:{to:[privateValue],subject:'Synthetic',body:'Private body must never appear',attachments:null,[privateValue]:'Private unknown field'}};
 const parsed=EMAIL_TOOL_INPUTS.email_draft_save.safeParse(raw);assert.equal(parsed.success,false);if(parsed.success)return;
 const diagnostics=emailDraftInputDiagnostics(parsed.error,raw),text=JSON.stringify(diagnostics);
 assert.ok(diagnostics.some(v=>v.field==='content.to'&&v.code==='invalid_type'&&v.expected==='string'&&v.received==='array'));
 assert.ok(diagnostics.some(v=>v.field==='content.attachments'&&v.expected==='array'&&v.received==='null'));
 assert.ok(diagnostics.some(v=>v.code==='unrecognized_keys'));
 assert.equal(text.includes(privateValue),false);assert.equal(text.includes('Private body'),false);assert.equal(text.includes('Private unknown field'),false);
 assert.ok(diagnostics.length<=8);assert.equal(EMAIL_TOOL_INPUTS.email_draft_save.safeParse({...raw,content:{to:'recipient@example.test',subject:'Synthetic',body:'Preserved',owner_user_id:'foreign-owner'}}).success,false,'diagnostics do not relax strict owner/content boundaries');
});

test('retired native Send cannot create or persist an executable proposal',async()=>{
 assert.equal(ACTION_TOOLS.has('email_send'),false);
 const proposal=validateRegisteredProposalAction({action:'email_send',params:{account_id:'sender',draft_id:'saved',expected_revision:1}});
 assert.equal(proposal.ok,false);if(!proposal.ok)assert.match(proposal.message,/built-in mailbox action is retired/);
 assert.match(EMAIL_AGENT_GUIDANCE,/post_message\/post_thread_reply.*never satisfy an Email draft request/);
 assert.match(EMAIL_AGENT_GUIDANCE,/do not wrap it in request_human_approval/);
 const native=nativeEmailSendPendingAction({state:'pending_review',action_id:'19f2d660-1286-4d99-a234-c655bdb961c1',account_id:'sender',draft_id:'d1a27247-ca69-487e-aee8-96fb3951a2fe',draft_revision:2,content_digest:'a'.repeat(64),review_url:'/email?account=sender&draft=saved'},'tool-use-1');
 assert.equal(native.existing_action_id,native.id,'historical reference serialization remains stable');assert.equal(validateRegisteredProposalAction(native).ok,false,'a historical service reference cannot reactivate retired Send');
 assert.equal(validateRegisteredProposalAction({...native,existing_action_id:'wrong-row'}).ok,false,'mismatched references remain rejected');
 for(const action of [native,{...native,source:'agent',action:'email_send'},{...native,action:'app_runtime'}]){
  await assert.rejects(persistAgentReplyWithActions({orgId:'org',spaceId:'space',userId:'owner',agentUserId:'agent',content:'Retained proposal',metadata:{},pendingActions:[action]}),/RETIRED_NATIVE_ACTION/,'native source or action is denied before persistence');
 }
});
