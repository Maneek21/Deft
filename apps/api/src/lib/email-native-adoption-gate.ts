import {sql} from 'drizzle-orm';
import {EmailMailboxError,type EmailScope} from './email-mailbox-service.js';
import type {EmailAccountConsentTransaction} from './email-account-consent-store.js';
import type {db} from './db.js';

/** This is a denial fence, never a grant. The proposed migration installs the
 * same function on direct native SQL writes. A missing migration fails closed.
 * Operator freeze additionally requires the coherent stopped-provider fence. */
export async function assertNativeAccountAvailable(tx:EmailAccountConsentTransaction,scope:EmailScope){
 try{await tx.execute(sql`SELECT public.native_email_assert_write(${scope.org_id},${scope.owner_user_id},${scope.account_id})`);}
 catch(error){
  const cause=(error as {cause?:{code?:string;message?:string}})?.cause??error as {code?:string;message?:string};
  if(cause?.code==='55000'&&cause.message?.includes('EMAIL_NATIVE_ACCOUNT_ADOPTED_READ_ONLY'))throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
  throw error;
 }
}
export async function currentNativeAccountAvailable(database:Pick<typeof db,'transaction'>,scope:EmailScope){return database.transaction(tx=>assertNativeAccountAvailable(tx,scope));}
