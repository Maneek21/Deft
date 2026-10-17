import {z} from 'zod';
import {AppConnectionReattachAnyReviewViewSchema} from './connection-session-reattach.js';
import {AppConnectionSessionScopeSchema,AppConnectionSessionViewSchema} from './connection-session.js';
import {AppConnectionUpgradeReviewViewSchema} from './connection-session-upgrade.js';
import {AppConnectionCredentialRepairReviewViewSchema} from './connection-session-credential-repair.js';
const id=z.string().uuid(),revision=z.number().int().min(0).max(2147483646);
const profile=z.strictObject({key:AppConnectionSessionScopeSchema.shape.target_key,
 label:z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f<>]+$/u),authorization_origin:z.string().max(512).url().refine(value=>{
  const url=new URL(value);return url.protocol==='https:'&&url.origin===value&&!url.username&&!url.password;
 })});
export const AppConnectionUpgradePendingSchema=z.strictObject({session_id:id,
 state:z.enum(['starting','upgrade_reviewed','upgrade_starting','awaiting_callback','connecting','upgrade_checking','indeterminate']),
 begin_consumed:z.boolean(),callback_consumed:z.boolean(),review:AppConnectionUpgradeReviewViewSchema.nullable()})
 .refine(row=>!row.callback_consumed||row.begin_consumed)
 .refine(row=>!row.review||row.state==='upgrade_reviewed'&&!row.begin_consumed&&!row.callback_consumed
  &&row.review.session_id===row.session_id);
export const AppConnectionUpgradeContextSchema=z.strictObject({schema_version:z.literal('deft.app_connection_upgrade_context.v1'),
 installation_id:id,org_id:id,owner_user_id:id,targets:z.array(z.strictObject({
  target_key:AppConnectionSessionScopeSchema.shape.target_key,scope:AppConnectionSessionScopeSchema,profile,
  runtime_ready:z.boolean(),session:AppConnectionSessionViewSchema.nullable(),upgrade:z.strictObject({
   candidate:z.strictObject({source_session_id:id,source_revision:revision,account:AppConnectionSessionViewSchema.shape.account.unwrap()}).nullable(),
   pending:AppConnectionUpgradePendingSchema.nullable()}),
  credential_repair:z.strictObject({candidate:z.strictObject({source_session_id:id,source_revision:revision,account:AppConnectionSessionViewSchema.shape.account.unwrap()}).nullable(),
   pending:z.strictObject({session_id:id,state:z.enum(['starting','repair_reviewed','repair_starting','awaiting_callback','connecting','repair_checking','indeterminate','connected','not_connected']),begin_consumed:z.boolean(),callback_consumed:z.boolean(),review:AppConnectionCredentialRepairReviewViewSchema.nullable()}).nullable()}).optional(),
  reattachment:z.strictObject({candidate:z.strictObject({source_session_id:id,source_revision:revision,account:AppConnectionSessionViewSchema.shape.account.unwrap()}).nullable(),
   pending:z.strictObject({session_id:id,state:z.enum(['starting','reattach_reviewed','reattaching','reattach_checking','indeterminate']),activation_started:z.boolean(),review:AppConnectionReattachAnyReviewViewSchema.nullable()}).nullable()}).optional()})).max(32)})
 .refine(row=>new Set(row.targets.map(target=>target.target_key)).size===row.targets.length&&row.targets.every(target=>
  target.scope.org_id===row.org_id&&target.scope.owner_user_id===row.owner_user_id&&target.scope.installation_id===row.installation_id
  &&target.scope.target_key===target.target_key&&(!target.session||JSON.stringify(target.session.scope)===JSON.stringify(target.scope))
  &&!(target.upgrade.candidate&&target.upgrade.pending)
  &&!(target.credential_repair?.candidate&&target.credential_repair.pending)
  &&(!target.credential_repair?.pending||target.session?.session_id===target.credential_repair.pending.session_id)
  &&(!target.credential_repair?.pending?.review||target.credential_repair.pending.state==='repair_reviewed'
    &&!target.credential_repair.pending.begin_consumed&&!target.credential_repair.pending.callback_consumed
    &&target.credential_repair.pending.review.session_id===target.credential_repair.pending.session_id
    &&JSON.stringify(target.credential_repair.pending.review.scope)===JSON.stringify(target.scope))
  &&!(target.reattachment?.candidate&&target.reattachment.pending)
  &&(!target.reattachment?.pending||target.session?.session_id===target.reattachment.pending.session_id)
  &&(!target.reattachment?.pending?.review||!target.reattachment.pending.activation_started&&target.reattachment.pending.state==='reattach_reviewed'
    &&target.reattachment.pending.review.session_id===target.reattachment.pending.session_id
    &&JSON.stringify(target.reattachment.pending.review.scope)===JSON.stringify(target.scope))
  &&(!target.upgrade.pending||target.session?.session_id===target.upgrade.pending.session_id)
  &&(!target.upgrade.pending?.review||JSON.stringify(target.upgrade.pending.review.scope)===JSON.stringify(target.scope))));
export type AppConnectionUpgradeContext=z.infer<typeof AppConnectionUpgradeContextSchema>;
