import {createHash} from 'node:crypto';import {z} from 'zod';
import {canonicalConnectionReattachmentJson} from '@deft/app-kit';
import type {AppConnectionSessionRecord} from './app-connection-session-service.js';
export const UNSTARTED_REVIEW_CLOSURE_ACTION='app.connection_review_unstarted_closed';
export const UnstartedReviewClosureSchema=z.strictObject({schema_version:z.literal('deft.app_connection_unstarted_review_closure.v1'),org_id:z.string().uuid(),owner_user_id:z.string().uuid(),request_id:z.string().uuid(),resource_binding_id:z.string().uuid(),scope_digest:z.string().regex(/^sha256:[a-f0-9]{64}$/),closed_at:z.iso.datetime()});
export type UnstartedReviewClosure=z.infer<typeof UnstartedReviewClosureSchema>;
export function unstartedReviewClosure(record:AppConnectionSessionRecord):UnstartedReviewClosure|null{
 if(record.state!=='not_connected'||record.revision!==1||record.account!==null||record.runtime_session_ref!==null||record.callback_consumed||record.reattachment||record.upgrade||record.credential_repair||record.created_at!==record.updated_at)return null;
 return UnstartedReviewClosureSchema.parse({schema_version:'deft.app_connection_unstarted_review_closure.v1',org_id:record.scope.org_id,owner_user_id:record.scope.owner_user_id,request_id:record.session_id,resource_binding_id:record.scope.resource_binding_id,scope_digest:'sha256:'+createHash('sha256').update(canonicalConnectionReattachmentJson(record.scope)).digest('hex'),closed_at:record.created_at});
}
export function matchesUnstartedReviewClosure(raw:unknown,record:AppConnectionSessionRecord):boolean{
 const parsed=UnstartedReviewClosureSchema.safeParse(raw),expected=unstartedReviewClosure(record);return !!expected&&parsed.success&&canonicalConnectionReattachmentJson(parsed.data)===canonicalConnectionReattachmentJson(expected);
}
