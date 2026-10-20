import {AppDataConsentSnapshotSchema,appConsentDeadline} from '@deft/app-kit/core';
import {humanRecordSaveReceipt} from './app-data-human-save.js';
import {and,eq,inArray,sql} from 'drizzle-orm';
import {appDataConsents,appDataInvocations} from '@deft/db/schema';
import {db} from './db.js';
import type {ExperienceCaller} from './app-experience-service.js';
export class PostgresAppDataStore {
  constructor(readonly caller:Pick<ExperienceCaller,'org_id'|'user_id'>,readonly database:typeof db=db){}
  private owner(table:typeof appDataConsents|typeof appDataInvocations){return and(eq(table.org_id,this.caller.org_id),eq(table.owner_user_id,this.caller.user_id));}
  async consent(id:string){const [row]=await this.database.select().from(appDataConsents).where(and(this.owner(appDataConsents),eq(appDataConsents.consent_id,id)));return row??null;}
  async activeConsent(session:string|string[],store:string){const rows=await this.database.select().from(appDataConsents).where(and(this.owner(appDataConsents),inArray(appDataConsents.connection_session_id,typeof session==='string'?[session]:session),eq(appDataConsents.store_key,store),eq(appDataConsents.state,'active')));return rows.filter(row=>appConsentDeadline(row.expires_at,AppDataConsentSnapshotSchema.parse(row.snapshot).consent_lifetime)>Date.now());}
  async activeConsents(sessions:string[],stores:string[]){if(!sessions.length||!stores.length)return [];const rows=await this.database.select().from(appDataConsents).where(and(this.owner(appDataConsents),inArray(appDataConsents.connection_session_id,sessions),inArray(appDataConsents.store_key,stores),eq(appDataConsents.state,'active')));return rows.filter(row=>appConsentDeadline(row.expires_at,AppDataConsentSnapshotSchema.parse(row.snapshot).consent_lifetime)>Date.now());}
  async propose(values:typeof appDataConsents.$inferInsert){await this.database.insert(appDataConsents).values(values);}
  async activate(id:string,digest:string,connectionIds?:string[]){return this.database.transaction(async tx=>{
    const [row]=await tx.select().from(appDataConsents).where(and(this.owner(appDataConsents),eq(appDataConsents.consent_id,id))).for('update');
    if(!row||row.state!=='proposed'||row.consent_digest!==digest||appConsentDeadline(row.expires_at,AppDataConsentSnapshotSchema.parse(row.snapshot).consent_lifetime)<=Date.now()||AppDataConsentSnapshotSchema.parse(row.snapshot).review_expires_at!==undefined&&Date.parse(AppDataConsentSnapshotSchema.parse(row.snapshot).review_expires_at!)<=Date.now())return false;
    await tx.update(appDataConsents).set({state:'revoked',updated_at:new Date()}).where(and(this.owner(appDataConsents),inArray(appDataConsents.connection_session_id,connectionIds??[row.connection_session_id]),eq(appDataConsents.store_key,row.store_key),eq(appDataConsents.state,'active')));
    await tx.update(appDataConsents).set({state:'active',updated_at:new Date()}).where(and(this.owner(appDataConsents),eq(appDataConsents.consent_id,id)));return true;
  });}
  async revoke(id:string){await this.database.update(appDataConsents).set({state:'revoked',updated_at:new Date()}).where(and(this.owner(appDataConsents),eq(appDataConsents.consent_id,id)));}
  async invocation(id:string){const [row]=await this.database.select().from(appDataInvocations).where(and(this.owner(appDataInvocations),eq(appDataInvocations.request_id,id)));return row??null;}
  async humanSave(authority:{scope:{org_id:string;owner_user_id:string;installation_id:string;target_key:string;resource_key:string};connection:{account_ref:string}},record:{store_key:string;record_id:string;revision:number;content_digest:string}){
    const rows=await this.database.select().from(appDataInvocations).where(and(this.owner(appDataInvocations),eq(appDataInvocations.operation,'record_save'),eq(appDataInvocations.state,'completed'),eq(appDataInvocations.revision,1),
     sql`${appDataInvocations.context}->'scope'->>'installation_id' = ${authority.scope.installation_id}`,sql`${appDataInvocations.context}->'scope'->>'target_key' = ${authority.scope.target_key}`,sql`${appDataInvocations.context}->'scope'->>'resource_key' = ${authority.scope.resource_key}`,
     sql`${appDataInvocations.context}->'connection'->>'account_ref' = ${authority.connection.account_ref}`,
     sql`${appDataInvocations.result}->>'outcome' = 'completed'`,sql`${appDataInvocations.result}->>'store_key' = ${record.store_key}`,sql`${appDataInvocations.result}->>'record_id' = ${record.record_id}`,
     sql`${appDataInvocations.result}->>'revision' = ${String(record.revision)}`,sql`${appDataInvocations.result}->>'content_digest' = ${record.content_digest}`)).limit(2);
    return humanRecordSaveReceipt(authority,record,rows);
  }
  async begin(values:typeof appDataInvocations.$inferInsert){return (await this.database.insert(appDataInvocations).values(values).onConflictDoNothing().returning({id:appDataInvocations.request_id})).length===1;}
  async finish(id:string,state:'completed'|'indeterminate',result:Record<string,unknown>|null){return (await this.database.update(appDataInvocations).set({state,result,revision:1,updated_at:new Date()}).where(and(this.owner(appDataInvocations),eq(appDataInvocations.request_id,id),eq(appDataInvocations.state,'inflight'),eq(appDataInvocations.revision,0))).returning({id:appDataInvocations.request_id})).length===1;}
}
