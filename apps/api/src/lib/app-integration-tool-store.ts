import {sql} from 'drizzle-orm';
import {db} from './db.js';
import type {AppRunTransaction} from './app-run-repository.js';
import {IntegrationToolMetadataSchema,IntegrationPreparedLocatorSchema,type IntegrationToolJournalRow,type IntegrationToolMetadata,type IntegrationPreparedLocator} from './app-integration-tool-journal.js';
type Executor=Pick<AppRunTransaction,'execute'>;
export function decodeIntegrationToolRow(raw:Record<string,unknown>):IntegrationToolJournalRow{
 const metadata=IntegrationToolMetadataSchema.parse(raw.context);
 if(!['inflight','completed','indeterminate'].includes(String(raw.state))||raw.request_id!==metadata.envelope.request_id||raw.org_id!==metadata.caller.org_id||raw.owner_user_id!==metadata.caller.user_id
  ||raw.authority_identity!==metadata.authority_identity||raw.input_digest!==metadata.input_digest)throw Error('APP_INTEGRATION_TOOL_JOURNAL_INVALID');
 return {metadata,state:raw.state as IntegrationToolJournalRow['state'],prepared:raw.prepared_locator===null?null:IntegrationPreparedLocatorSchema.parse(raw.prepared_locator),
  run_id:raw.accepted_run_id as string|null,run_input_digest:raw.accepted_input_digest as string|null,runtime_binding_id:raw.accepted_runtime_binding_id as string|null};
}
export async function readIntegrationTool(id:string,tx:Executor=db,lock=false){
 const result=await tx.execute(sql`SELECT * FROM app_integration_data_invocations WHERE request_id=${id} AND context->>'kind'='tool' ${lock?sql`FOR UPDATE`:sql``}`);
 return result.rows[0]?decodeIntegrationToolRow(result.rows[0]):null;
}
export async function beginIntegrationTool(raw:IntegrationToolMetadata){
 const m=IntegrationToolMetadataSchema.parse(raw);
 const result=await db.execute(sql`INSERT INTO app_integration_data_invocations(request_id,org_id,owner_user_id,installation_id,principal_kind,principal_id,purpose,authority_identity,authority_expires_at,operation,input_digest,context,state,revision,expires_at)
 VALUES(${m.envelope.request_id},${m.caller.org_id},${m.caller.user_id},${m.target.installation_id},${m.caller.kind},${m.caller.principal_id},${'tool_'+m.envelope.tool_operation},${m.authority_identity},${new Date(m.authority_expires_at)},${'tool:'+m.envelope.tool_key},${m.input_digest},${JSON.stringify(m)}::jsonb,'inflight',1,${new Date(m.envelope.expires_at)}) ON CONFLICT(request_id) DO NOTHING RETURNING request_id`);
 return result.rows.length===1;
}
export async function finishIntegrationTool(id:string,state:'completed'|'indeterminate',prepared:IntegrationPreparedLocator|null=null){
 if(prepared)IntegrationPreparedLocatorSchema.parse(prepared);
 const result=await db.execute(sql`UPDATE app_integration_data_invocations SET state=${state},prepared_locator=${prepared?JSON.stringify(prepared):null}::jsonb,revision=revision+1,updated_at=clock_timestamp() WHERE request_id=${id} AND state='inflight' AND context->>'kind'='tool' RETURNING request_id`);
 if(result.rows.length!==1)throw Error('APP_INTEGRATION_TOOL_JOURNAL_STALE');
}
