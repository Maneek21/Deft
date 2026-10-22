import {and,eq,sql} from 'drizzle-orm';
import {appConnectionSessions} from '@deft/db/schema';
import {appConnectionForms} from '../../../../packages/db/src/schema/app-connection-forms.js';
import {validateFormCarrierPair} from './app-connection-form-carrier.js';
import type {AppRunTransaction} from './app-run-repository.js';
import type {FormLocator} from './app-connection-form-service.js';
/** OAuth and predecessor dispatch are never allowed to interpret a form
 * carrier. An absent form journal cannot satisfy an explicit form protocol. */
export async function validateStoredFormConnection(tx:AppRunTransaction,q:FormLocator,carrier:unknown,required=false){
 const [row]=await tx.select().from(appConnectionForms).where(and(eq(appConnectionForms.org_id,q.org_id),eq(appConnectionForms.owner_user_id,q.owner_user_id),eq(appConnectionForms.session_id,q.session_id))).limit(1).for('share');
 if(!row){if(required)throw new Error('APP_CONNECTION_FORM_JOURNAL_REQUIRED');return null;}
 return validateFormCarrierPair(row.record,carrier).form;
}
type FormSourceLocator={org_id:string;owner_user_id?:string;session_id?:string;resource_binding_id?:string};
const formSourceOwner=(input:FormSourceLocator)=>and(eq(appConnectionForms.org_id,input.org_id),
 input.owner_user_id?eq(appConnectionForms.owner_user_id,input.owner_user_id):undefined);
/** Shared predicates keep saved-read batching identical to effect admission. */
export const appConnectionFormCurrentSourceCondition=(input:FormSourceLocator)=>and(formSourceOwner(input),
 input.session_id?eq(appConnectionForms.session_id,input.session_id):sql`${appConnectionForms.record}->'scope'->>'resource_binding_id'=${input.resource_binding_id!}`);
export const appConnectionFormPendingSourceCondition=(input:FormSourceLocator)=>and(formSourceOwner(input),
 sql`${appConnectionForms.record}->'begin_consumed'='true'::jsonb`,
 sql`NOT (${appConnectionForms.record}->>'state'='not_connected' AND ${appConnectionForms.record}->'input_consumed'='false'::jsonb)`,
 input.session_id?sql`${appConnectionForms.record}->'source'->>'session_id'=${input.session_id}`:
  and(sql`${appConnectionForms.record}->'source'->'scope'->>'resource_binding_id'=${input.resource_binding_id!}`,sql`${appConnectionForms.record}->'receipt'='null'::jsonb`));
export const appConnectionFormCarrierJoin=()=>and(eq(appConnectionSessions.org_id,appConnectionForms.org_id),
 eq(appConnectionSessions.owner_user_id,appConnectionForms.owner_user_id),eq(appConnectionSessions.session_id,appConnectionForms.session_id));
export async function appConnectionFormSourceIsAvailable(tx:AppRunTransaction,input:FormSourceLocator){
 const current=await tx.select({form:appConnectionForms.record,carrier:appConnectionSessions.record}).from(appConnectionForms)
  .innerJoin(appConnectionSessions,appConnectionFormCarrierJoin()).where(appConnectionFormCurrentSourceCondition(input)).for('share');
 try{for(const row of current){const {form}=validateFormCarrierPair(row.form,row.carrier);if(form.state!=='connected'||!form.receipt)return false;}}catch{return false;}
 const [pending]=await tx.select({id:appConnectionForms.session_id}).from(appConnectionForms).where(appConnectionFormPendingSourceCondition(input)).limit(1);
 return !pending;
}
/** This narrower predicate is also used by form management, whose own state
 * can legitimately be checking. A consumed successor permanently fences its
 * predecessor; elapsed setup leases never restore the old custody authority. */
export async function appConnectionFormPredecessorIsAvailable(tx:AppRunTransaction,q:FormLocator){
 const [reserved]=await tx.select({id:appConnectionForms.session_id}).from(appConnectionForms).where(and(
  eq(appConnectionForms.org_id,q.org_id),eq(appConnectionForms.owner_user_id,q.owner_user_id),
  sql`${appConnectionForms.record}->'source'->>'session_id'=${q.session_id}`,
  sql`${appConnectionForms.record}->'begin_consumed'='true'::jsonb`,
  sql`NOT (${appConnectionForms.record}->>'state'='not_connected' AND ${appConnectionForms.record}->'input_consumed'='false'::jsonb)`)).limit(1);
 return !reserved;
}
