import {and,eq,isNull,sql} from 'drizzle-orm';import {z} from 'zod';
import {mcpTokens} from '@deft/db/schema';import {db} from './db.js';
import {appDataRetainedGuard} from './app-data-authority.js';import {getAppIntegrationDataGateway} from './app-integration-runtime-gateway.js';
import type {ExperienceCaller} from './app-experience-service.js';
const Account=z.strictObject({installation_id:z.uuid(),account_ref:z.string().min(1).max(512),store_key:z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u)});
/** Owner settings reveal token labels and grant scope, never token material.
 * Reading this context does not create delegated or notification authority. */
export async function appIntegrationPermissionContext(caller:ExperienceCaller,raw:unknown){
 const account=Account.parse(raw),guard=appDataRetainedGuard(caller),human={kind:'human' as const,org_id:caller.org_id,user_id:caller.user_id,principal_id:caller.sid,access_expires_at:caller.access_expires_at};
 const first=await getAppIntegrationDataGateway().currentAccount(human,account,'read');
 return db.transaction(async tx=>{await guard(tx);const current=await getAppIntegrationDataGateway().currentAccount(human,account,'read',tx);if(current.identity!==first.identity)throw Error('APP_INTEGRATION_PERMISSION_CHANGED');
  const tokens=await tx.select({id:mcpTokens.id,name:mcpTokens.name}).from(mcpTokens).where(and(eq(mcpTokens.org_id,caller.org_id),eq(mcpTokens.user_id,caller.user_id),eq(mcpTokens.principal_kind,'human'),isNull(mcpTokens.agent_employee_id),isNull(mcpTokens.revoked_at))).limit(101).for('share');if(tokens.length>100)throw Error('APP_INTEGRATION_PERMISSION_LIMIT');
  const rows=await tx.execute(sql`SELECT id,revision,principal_kind,principal_id,operations,expires_at FROM app_integration_principal_grants WHERE org_id=${caller.org_id} AND owner_user_id=${caller.user_id} AND installation_id=${account.installation_id} AND resource_binding_id=${current.resource_binding_id} AND account_ref=${account.account_ref} AND store_key=${account.store_key} AND revoked_at IS NULL ORDER BY created_at LIMIT 102 FOR SHARE`);if(rows.rows.length>101)throw Error('APP_INTEGRATION_PERMISSION_LIMIT');
  const principals=[{kind:'defty' as const,id:caller.user_id,name:'Defty'},...tokens.map(row=>({kind:'personal_mcp' as const,id:row.id,name:row.name}))];
  const grants=rows.rows.filter(row=>principals.some(p=>p.kind===row.principal_kind&&p.id===row.principal_id)).map(row=>({id:z.uuid().parse(row.id),revision:z.number().int().positive().parse(row.revision),principal_kind:z.enum(['defty','personal_mcp']).parse(row.principal_kind),principal_id:z.uuid().parse(row.principal_id),operations:z.array(z.enum(['read','draft','triage','send'])).min(1).max(4).parse(row.operations),expires_at:new Date(String(row.expires_at)).toISOString()}));
  await guard(tx);return {schema_version:'deft.app_integration_permissions.v1',resource_binding_id:current.resource_binding_id,principals,grants};
 });
}
