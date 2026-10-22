import {and,eq} from 'drizzle-orm';
import {appConnectionSessions} from '@deft/db/schema';
import {appConnectionForms} from '../../../../packages/db/src/schema/app-connection-forms.js';
import {db} from './db.js';
import {AppConnectionSessionRecordSchema,type AppConnectionSessionLocator} from './app-connection-session-service.js';
import {validateStoredFormConnection} from './app-connection-form-fence.js';

/** Read-only data admission. The nullable journal locator is observed afresh on
 * every read, including the final revision fence. OAuth's common absent-journal
 * case needs no transaction; a present journal retains its existing share lock
 * and exact carrier validation. This reader never authorizes provider I/O or a
 * mutation and never caches a presence/absence decision. */
export async function readSavedAppDataConnection(locator:AppConnectionSessionLocator){
 const [row]=await db.select({record:appConnectionSessions.record,form_session_id:appConnectionForms.session_id})
  .from(appConnectionSessions).leftJoin(appConnectionForms,and(
   eq(appConnectionForms.org_id,appConnectionSessions.org_id),
   eq(appConnectionForms.owner_user_id,appConnectionSessions.owner_user_id),
   eq(appConnectionForms.session_id,appConnectionSessions.session_id)))
  .where(and(eq(appConnectionSessions.org_id,locator.org_id),
   eq(appConnectionSessions.owner_user_id,locator.owner_user_id),eq(appConnectionSessions.session_id,locator.session_id))).limit(1);
 if(!row)return null;
 const record=AppConnectionSessionRecordSchema.parse(row.record);
 if(row.form_session_id!==null)await db.transaction(tx=>validateStoredFormConnection(tx,locator,record));
 return record;
}
