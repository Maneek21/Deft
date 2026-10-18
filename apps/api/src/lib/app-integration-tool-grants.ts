import {randomUUID} from 'node:crypto';
import {and,eq,isNull,sql} from 'drizzle-orm';
import {mcpTokens} from '@deft/db/schema';
import {db} from './db.js';
import {AppIntegrationToolGrantInputSchema} from '../../../../packages/app-kit/src/app-integration-tools.js';
import {appDataRetainedGuard} from './app-data-authority.js';
import {getAppIntegrationDataGateway} from './app-integration-runtime-gateway.js';
import type {ExperienceCaller} from './app-experience-service.js';
const denied=()=>Error('APP_INTEGRATION_TOOL_GRANT_DENIED');
/** Real owner-only review writes independent grants; token scopes and browser
 * consent are not imported as delegation. Regrant after revoke gets a new UUID. */
export async function writeIntegrationToolGrant(caller:ExperienceCaller,raw:unknown){
 const input=AppIntegrationToolGrantInputSchema.parse(raw);if(Date.parse(input.expires_at)<=Date.now())throw denied();
 const guard=appDataRetainedGuard(caller);
 const account=await getAppIntegrationDataGateway().currentAccount({org_id:caller.org_id,user_id:caller.user_id,kind:'human',principal_id:caller.sid,access_expires_at:caller.access_expires_at},input,'read');
 if(account.resource_binding_id!==input.resource_binding_id)throw denied();
 return db.transaction(async tx=>{
  await guard(tx);
  if(input.principal_kind==='defty'){if(input.principal_id!==caller.user_id)throw denied();}
  else{const [token]=await tx.select().from(mcpTokens).where(and(eq(mcpTokens.org_id,caller.org_id),eq(mcpTokens.user_id,caller.user_id),eq(mcpTokens.id,input.principal_id),eq(mcpTokens.principal_kind,'human'),isNull(mcpTokens.revoked_at))).for('share');
   if(!token||token.agent_employee_id)throw denied();}
  const current=await getAppIntegrationDataGateway().currentAccount({org_id:caller.org_id,user_id:caller.user_id,kind:'human',principal_id:caller.sid,access_expires_at:caller.access_expires_at},input,'read',tx);
  if(current.identity!==account.identity||current.resource_binding_id!==input.resource_binding_id)throw denied();
  const existing=await tx.execute(sql`SELECT id,revision FROM app_integration_principal_grants WHERE org_id=${caller.org_id} AND owner_user_id=${caller.user_id} AND installation_id=${input.installation_id} AND resource_binding_id=${input.resource_binding_id} AND account_ref=${input.account_ref} AND store_key=${input.store_key} AND principal_kind=${input.principal_kind} AND principal_id=${input.principal_id} AND revoked_at IS NULL FOR UPDATE`);
  const row=existing.rows[0];if(existing.rows.length>1||Number(row?.revision??0)!==input.expected_revision)throw denied();
  const id=row?String(row.id):randomUUID(),revision=input.expected_revision+1;
  // Bind one PostgreSQL array parameter; raw SQL interpolation expands JS arrays as tuples.
  const operations=sql`${sql.param(input.operations)}::text[]`;
  if(row)await tx.execute(sql`UPDATE app_integration_principal_grants SET operations=${operations},expires_at=${new Date(input.expires_at)},revision=${revision},updated_at=clock_timestamp() WHERE id=${id}`);
  else await tx.execute(sql`INSERT INTO app_integration_principal_grants(id,org_id,owner_user_id,installation_id,resource_binding_id,account_ref,store_key,principal_kind,principal_id,operations,revision,expires_at) VALUES(${id},${caller.org_id},${caller.user_id},${input.installation_id},${input.resource_binding_id},${input.account_ref},${input.store_key},${input.principal_kind},${input.principal_id},${operations},1,${new Date(input.expires_at)})`);
  await guard(tx);return {id,revision,operations:input.operations,expires_at:input.expires_at};
 });
}
export async function revokeIntegrationToolGrant(caller:ExperienceCaller,id:string,revision:number){
 return db.transaction(async tx=>{const guard=appDataRetainedGuard(caller);await guard(tx);
  const result=await tx.execute(sql`UPDATE app_integration_principal_grants SET revoked_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE org_id=${caller.org_id} AND owner_user_id=${caller.user_id} AND id=${id} AND revision=${revision} AND revoked_at IS NULL RETURNING id,revision`);
  if(result.rows.length!==1)throw denied();await guard(tx);return result.rows[0];});
}
