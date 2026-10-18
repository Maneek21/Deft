import { createHash } from 'node:crypto';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { db, withDbAdvisoryLock } from './db.js';
import { emailAgentGrants, agentActions, agentEmployees, spaces, spaceMembers, users, mcpTokens } from '@deft/db/schema';
import { isCanonicalDeftyEmployee } from './defty-identity.js';
import { getEmailMailboxAuthority } from './email-account-authority-router.js';
import { EmailAgentToolService, emailReviewDigest, type EmailToolCaller, type EmailToolPorts } from './email-agent-tools.js';
import { EmailAgentActorSchema, EmailHumanActorSchema, type EmailAgentActor } from './email-agent-actor.js';
import type { EmailScope } from './email-mailbox-service.js';
import { getEmailDraftRuntime } from './email-draft-runtime.js';
import { getEmailMailboxReadService, getEmailMailboxSearchService, getEmailMessageContentService, getEmailMailboxConversationService, getEmailNativeTriageService } from './email-mailbox-runtime.js';
import { getEmailNativeSendService, getEmailNativeSendComponents } from './email-send-runtime.js';
import { selectVerifiedDraftFromAddress } from './email-draft-service.js';
const deny=():never=>{throw Error('EMAIL_ACCESS_DENIED');};
type NativeSendComponents=Awaited<ReturnType<typeof getEmailNativeSendComponents>>;
let testPorts:EmailToolPorts|undefined;
let testSendComponents:((actor:EmailAgentActor)=>Promise<Pick<NativeSendComponents,'authority'|'sender'>>)|undefined;
let testSendService:((actor:EmailAgentActor)=>Promise<ReturnType<typeof getEmailNativeSendService> extends Promise<infer S>?S:never>)|undefined;
/** Fixture-only dependency seam: tests replace provider custody, never actors,
 * native admission, draft stores, sender state machine or mounted MCP auth. */
export function setEmailAgentRuntimeForTest(value?:{ports:EmailToolPorts;components:NonNullable<typeof testSendComponents>;sender:NonNullable<typeof testSendService>}){
 if(process.env.NODE_ENV!=='test')throw Error('EMAIL_TEST_RUNTIME_FORBIDDEN');testPorts=value?.ports;testSendComponents=value?.components;testSendService=value?.sender;
}
const draftRuntime=(actor:EmailAgentActor)=>testPorts?testPorts.drafts(actor):getEmailDraftRuntime(actor);
async function audience(caller:EmailToolCaller){
 if(caller.kind!=='defty')return;
 if(caller.employee_id){const [employee]=await db.select().from(agentEmployees).where(and(eq(agentEmployees.id,caller.employee_id),eq(agentEmployees.org_id,caller.org_id))).limit(1);if(!isCanonicalDeftyEmployee(employee)||!employee?.is_active)return deny();}
 if(!caller.conversation_id)return deny();
 const [space]=await db.select().from(spaces).where(and(eq(spaces.id,caller.conversation_id),eq(spaces.org_id,caller.org_id),eq(spaces.type,'dm'),eq(spaces.is_archived,false))).limit(1);if(!space)return deny();
 const members=await db.select({user_id:spaceMembers.user_id,is_agent:users.is_agent,kind:users.kind}).from(spaceMembers).innerJoin(users,eq(users.id,spaceMembers.user_id)).where(eq(spaceMembers.space_id,space.id));
 if(!members.some(m=>m.user_id===caller.user_id)||members.some(m=>m.user_id!==caller.user_id&&!m.is_agent))return deny();
}
export async function authorizeEmailToolCaller(caller:EmailToolCaller,accountId:string,operation:'read'|'draft'|'triage'|'send'){
 if(process.env.DEFT_NATIVE_EMAIL_ENABLED!=='true')return deny();
 await audience(caller);
 if(caller.kind==='personal_mcp'&&!caller.token_id)return deny();
 const principal_id=caller.kind==='defty'?caller.user_id:caller.token_id!;
 const [grant]=await db.select().from(emailAgentGrants).where(and(eq(emailAgentGrants.org_id,caller.org_id),eq(emailAgentGrants.owner_user_id,caller.user_id),eq(emailAgentGrants.account_id,accountId),eq(emailAgentGrants.principal_kind,caller.kind),eq(emailAgentGrants.principal_id,principal_id),isNull(emailAgentGrants.revoked_at))).limit(1);
 if(!grant||!grant.operations.includes(operation))return deny();
 const [token]=caller.kind==='personal_mcp'?await db.select().from(mcpTokens).where(and(eq(mcpTokens.id,principal_id),eq(mcpTokens.org_id,caller.org_id),eq(mcpTokens.user_id,caller.user_id),eq(mcpTokens.principal_kind,'human'),isNull(mcpTokens.revoked_at))).limit(1):[];
 if(caller.kind==='personal_mcp'&&!token)return deny();
 const actor:EmailAgentActor={user_id:caller.user_id,agent_grant_id:grant.id,principal_kind:caller.kind,principal_id,access_expires_at:Date.now()+5*60_000,
   ...(token?{token_authorization_version:token.app_run_authorization_version}:{}),...(caller.conversation_id?{conversation_id:caller.conversation_id}:{}),...(caller.employee_id?{employee_id:caller.employee_id}:{})};
 const scope={org_id:caller.org_id,owner_user_id:caller.user_id,account_id:accountId},authority=await getEmailMailboxAuthority(db);
 const op=operation==='send'?'human_send':operation==='triage'?'human_modify':operation==='draft'?'human_draft':'human_read';
 const expected=await authority.current(actor,scope,op);
 const recheck=async()=>{await audience(caller);const current=await authority.current(actor,scope,op);if(current.authority_version!==expected.authority_version)return deny();};
 return {actor,scope,recheck};
}
const authorize=authorizeEmailToolCaller;
export async function proposeEmailSend(actor:EmailAgentActor,scope:EmailScope,draftId:string,expectedRevision:number){
 return withDbAdvisoryLock(`email-review:${scope.org_id}:${scope.owner_user_id}:${scope.account_id}:${draftId}`,()=>proposeEmailSendLocked(actor,scope,draftId,expectedRevision));
}
async function proposeEmailSendLocked(actor:EmailAgentActor,scope:EmailScope,draftId:string,expectedRevision:number){
 const drafts=await draftRuntime(actor);let draft=await drafts.read(actor,scope,draftId);
 if(draft.status!=='draft'||draft.revision!==expectedRevision)throw Error('EMAIL_SEND_REVIEW_STALE');
 const {authority,sender}=await(testSendComponents?testSendComponents(actor):getEmailNativeSendComponents(actor)),cap=await authority.current(actor,scope,'human_send');
 const recheck=async()=>{const current=await authority.current(actor,scope,'human_send');if(current.authority_version!==cap.authority_version)return deny();};
 const identity=await sender.getSendIdentity(scope,cap,recheck);
 const address=selectVerifiedDraftFromAddress(draft.content,identity.primary_address,identity.verified_sender_identities);if(!address)throw Error('EMAIL_SEND_SENDER_UNAVAILABLE');
 // Persist the explicit reviewed sender before proposal. Changing a provider's
 // primary address later cannot silently alter this review.
 if((draft.content.from_identity as any)?.address!==address)draft=await drafts.update(actor,scope,draftId,draft.revision,{...draft.content,from_identity:{address}});
 await recheck();
 const content_digest=emailReviewDigest(draft);
 const params={account_id:scope.account_id,draft_id:draftId,draft_revision:draft.revision,content_digest,actor:{...actor},review_url:`/email?account=${encodeURIComponent(scope.account_id)}&draft=${encodeURIComponent(draftId)}`};
 const existing=await db.select().from(agentActions).where(and(eq(agentActions.org_id,scope.org_id),eq(agentActions.user_id,actor.user_id),eq(agentActions.action,'email_send'),eq(agentActions.approval_status,'pending')));
 const previous=existing.find(a=>(a.params as any)?.draft_id===draftId&&(a.params as any)?.account_id===scope.account_id&&(a.params as any)?.draft_revision===draft.revision&&(a.params as any)?.content_digest===content_digest&&(a.params as any)?.actor?.agent_grant_id===actor.agent_grant_id);
 const row=previous??(await db.insert(agentActions).values({org_id:scope.org_id,user_id:actor.user_id,conversation_id:actor.conversation_id??null,agent_employee_id:actor.employee_id??null,action:'email_send',params,approval_tier:'full',approval_status:'pending',source:'native_email'}).returning())[0]!;
 await recheck();return {state:'pending_review',action_id:row.id,account_id:scope.account_id,draft_id:draftId,draft_revision:draft.revision,content_digest,review_url:params.review_url};
}
export async function executeReviewedEmailSend(actionId:string,orgId:string,ownerId:string,rawReviewer?:import('./email-mailbox-service.js').EmailActor){
 const reviewer=EmailHumanActorSchema.parse(rawReviewer);if(reviewer.user_id!==ownerId)return deny();
 const [row]=await db.select().from(agentActions).where(and(eq(agentActions.id,actionId),eq(agentActions.org_id,orgId),eq(agentActions.user_id,ownerId),eq(agentActions.action,'email_send'))).limit(1);
 if(!row||row.approval_status!=='approved'||row.approved_by_user_id!==ownerId)return deny();
 const p=row.params as any,actor=EmailAgentActorSchema.parse({...p.actor,access_expires_at:Date.now()+5*60_000,review_session_id:reviewer.web_session_id,review_expires_at:reviewer.access_expires_at}),scope={org_id:orgId,owner_user_id:ownerId,account_id:p.account_id};
 const drafts=await draftRuntime(actor),draft=await drafts.read(actor,scope,p.draft_id);
 if(draft.revision!==p.draft_revision||emailReviewDigest(draft)!==p.content_digest)throw Error('EMAIL_SEND_REVIEW_STALE');
 return (await(testSendService?testSendService(actor):getEmailNativeSendService(actor))).send(actor,scope,p.draft_id,p.draft_revision);
}
export async function emailSendReviewPreview(actionId:string,orgId:string,ownerId:string){
 const [row]=await db.select().from(agentActions).where(and(eq(agentActions.id,actionId),eq(agentActions.org_id,orgId),eq(agentActions.user_id,ownerId),eq(agentActions.action,'email_send'))).limit(1);if(!row)return deny();
 const p=row.params as any,actor=EmailAgentActorSchema.parse({...p.actor,access_expires_at:Date.now()+5*60_000}),scope={org_id:orgId,owner_user_id:ownerId,account_id:p.account_id};
 await(await getEmailMailboxAuthority(db)).current(actor,scope,'human_send');
 const draft=await(await draftRuntime(actor)).read(actor,scope,p.draft_id);
 if(row.approval_status!=='pending'||draft.status!=='draft'||draft.revision!==p.draft_revision||emailReviewDigest(draft)!==p.content_digest)throw Error('EMAIL_SEND_REVIEW_STALE');
 return {action_id:row.id,account_id:p.account_id,draft_id:draft.draft_id,draft_revision:draft.revision,content_digest:p.content_digest,valid:true,content:draft.content};
}
export function getEmailAgentToolService(){if(testPorts)return new EmailAgentToolService(testPorts);return new EmailAgentToolService({
 authorize,accounts:async caller=>{await audience(caller);const rows=await db.select().from(emailAgentGrants).where(and(eq(emailAgentGrants.org_id,caller.org_id),eq(emailAgentGrants.owner_user_id,caller.user_id),eq(emailAgentGrants.principal_kind,caller.kind),eq(emailAgentGrants.principal_id,caller.kind==='defty'?caller.user_id:caller.token_id??''),isNull(emailAgentGrants.revoked_at)));const accounts=[];for(const row of rows){try{const authorized=await authorize(caller,row.account_id,'read');await authorized.recheck();accounts.push({account_id:row.account_id,operations:row.operations});}catch{}}return {accounts};},
 mailbox:getEmailMailboxReadService,content:getEmailMessageContentService,search:getEmailMailboxSearchService,thread:getEmailMailboxConversationService,drafts:getEmailDraftRuntime,triage:getEmailNativeTriageService,send:getEmailNativeSendService,proposeSend:proposeEmailSend,
});}
/** Discovery is permission-aware; enabling mailbox OAuth cannot add AI tools. */
export async function emailToolCatalogNames(caller:EmailToolCaller):Promise<Set<string>>{
 if(process.env.DEFT_NATIVE_EMAIL_ENABLED!=='true')return new Set();
 const {EMAIL_TOOL_NAMES}=await import('./email-agent-tools.js');
 await audience(caller);
 const rows=await db.select().from(emailAgentGrants).where(and(eq(emailAgentGrants.org_id,caller.org_id),eq(emailAgentGrants.owner_user_id,caller.user_id),eq(emailAgentGrants.principal_kind,caller.kind),eq(emailAgentGrants.principal_id,caller.kind==='defty'?caller.user_id:caller.token_id??''),isNull(emailAgentGrants.revoked_at)));
 const granted=new Set<string>();for(const row of rows)for(const op of row.operations){try{const a=await authorize(caller,row.account_id,op);await a.recheck();granted.add(op);}catch{}}
 return new Set(EMAIL_TOOL_NAMES.filter(name=>name==='email_accounts'?granted.has('read'):name==='email_send'||name==='email_send_status'?granted.has('send'):name==='email_triage'?granted.has('triage'):name.startsWith('email_draft_')?granted.has('draft'):granted.has('read')));
}
