import {and,eq} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import {emailAccounts,emailSignatures} from '@deft/db/schema';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import type {EmailScope} from './email-mailbox-service.js';
import {SignaturePreferencesSchema,type SignaturePreferences} from './email-signature-types.js';

const schema={emailAccounts,emailSignatures};
export type EmailSignatureDatabase=Pick<NodePgDatabase<typeof schema>,'transaction'>;
export type EmailSignatureGuard=(tx:unknown)=>Promise<void>;
const context=(scope:EmailScope,revision:number)=>({...scope,kind:'signature' as const,record_id:'signature-preferences',revision});
const where=(scope:EmailScope)=>and(eq(emailSignatures.org_id,scope.org_id),eq(emailSignatures.owner_user_id,scope.owner_user_id),eq(emailSignatures.account_id,scope.account_id));
/** Account-scoped encrypted preferences with revision CAS. */
export class EmailSignatureStore{
 constructor(private readonly db:EmailSignatureDatabase,private readonly crypto:EmailMailboxCrypto,private readonly now=()=>new Date()){}
 async read(scope:EmailScope,guard:EmailSignatureGuard,signal?:AbortSignal){
  signal?.throwIfAborted();return this.db.transaction(async tx=>{await guard(tx);signal?.throwIfAborted();
   const [row]=await tx.select().from(emailSignatures).where(where(scope)).limit(1);
   await guard(tx);signal?.throwIfAborted();return row?{revision:row.revision,preferences:SignaturePreferencesSchema.parse(this.crypto.open(row.preferences_envelope,context(scope,row.revision)))}:{revision:0,preferences:{identities:[]}};
  },{isolationLevel:'repeatable read'});
 }
 async replace(scope:EmailScope,expected:number,raw:unknown,guard:EmailSignatureGuard,signal?:AbortSignal){
  const preferences=SignaturePreferencesSchema.parse(raw);if(!Number.isSafeInteger(expected)||expected<0||expected>2147483646)throw Error('EMAIL_SIGNATURE_INVALID');
  signal?.throwIfAborted();return this.db.transaction(async tx=>{await guard(tx);signal?.throwIfAborted();
   const [row]=await tx.select().from(emailSignatures).where(where(scope)).limit(1).for('update');
   if((row?.revision??0)!==expected)throw Error('EMAIL_SIGNATURE_CONFLICT');const revision=expected+1,now=this.now();
   const envelope=this.crypto.seal(preferences,context(scope,revision));let result;
   if(row){[result]=await tx.update(emailSignatures).set({revision,preferences_envelope:envelope,updated_at:now}).where(where(scope)).returning();}
   else [result]=await tx.insert(emailSignatures).values({...scope,revision,preferences_envelope:envelope,created_at:now,updated_at:now}).onConflictDoNothing().returning();
   if(!result)throw Error('EMAIL_SIGNATURE_CONFLICT');await guard(tx);signal?.throwIfAborted();
   return {revision,preferences:SignaturePreferencesSchema.parse(this.crypto.open(result.preferences_envelope,context(scope,revision)))};
  });
 }
}
export type {SignaturePreferences};
