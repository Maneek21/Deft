import {createHash} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {users,orgMembers,webSessions} from '@deft/db/schema';
import {canonicalCapabilityJson} from '@deft/shared';
import {z} from 'zod';
import type {db} from './db.js';
import type {EmailActor} from './email-mailbox-service.js';
import type {NativeEmailConnectionScope,NativeEmailConnectionOwner} from './email-native-connection-contract.js';
import type {NativeEmailConnectionTransaction} from './email-native-connection-store.js';
const id=z.string().min(1).max(256),actorSchema=z.strictObject({user_id:id,web_session_id:id,access_expires_at:z.number().finite()}),scopeSchema=z.strictObject({org_id:id,owner_user_id:id});
const denied=():never=>{throw Error('EMAIL_ACCESS_DENIED');};
/** Setup management only. Current real human SID and owner membership admit a
 * connect request without fabricating an account, App grant or service lease. */
export class PostgresNativeEmailConnectionOwner{
 constructor(private readonly database:Pick<typeof db,'transaction'>,private readonly now=Date.now){}
 async current(rawActor:EmailActor,rawScope:NativeEmailConnectionScope,transaction?:unknown,signal?:AbortSignal):Promise<NativeEmailConnectionOwner>{
  const actor=actorSchema.parse(rawActor),scope=scopeSchema.parse(rawScope);if(actor.user_id!==scope.owner_user_id)return denied();
  const work=async(tx:NativeEmailConnectionTransaction)=>{signal?.throwIfAborted();
   const [user]=await tx.select({kind:users.kind,agent:users.is_agent}).from(users).where(eq(users.id,scope.owner_user_id)).for('share').limit(1);
   const [member]=await tx.select({role:orgMembers.role,active:orgMembers.is_active,version:orgMembers.app_run_authorization_version}).from(orgMembers).where(and(eq(orgMembers.org_id,scope.org_id),eq(orgMembers.user_id,scope.owner_user_id))).for('share').limit(1);
   const [session]=await tx.select().from(webSessions).where(and(eq(webSessions.id,actor.web_session_id),eq(webSessions.org_id,scope.org_id),eq(webSessions.user_id,scope.owner_user_id))).for('share').limit(1);
   signal?.throwIfAborted();const expires=Math.min(actor.access_expires_at,session?.expires_at.getTime()??0);
   if(!user||user.kind!=='human'||user.agent||!member||!member.active||!['owner','admin','member'].includes(member.role)||!Number.isSafeInteger(member.version)||member.version<1||!session||session.revoked_at||!Number.isFinite(expires)||expires<=this.now())return denied();
   return {scope,session_id:actor.web_session_id,expires_at:expires,authority_version:createHash('sha256').update(canonicalCapabilityJson({scope,session:actor.web_session_id,user,member})).digest('hex')};
  };return transaction?work(transaction as NativeEmailConnectionTransaction):this.database.transaction(work);
 }
}
