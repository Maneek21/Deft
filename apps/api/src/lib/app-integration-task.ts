import {and,eq} from 'drizzle-orm';
import {orgMembers,projects} from '@deft/db/schema';
import type {AppRunTransaction as Tx} from './app-run-repository.js';
import type {AppIntegrationDestinationPorts} from './app-integration-destination.js';
import {createNativeTask} from './native-task-create.js';
import {getIO} from '../socket.js';
import {enqueue,QUEUE_NAMES} from './queues.js';
/** Reviewed Tasks are ordinary org-visible tasks. Source IDs stay in governed
 * citations; source_message_id remains a Chat-message foreign key. */
export const appIntegrationTaskAdapter:Pick<AppIntegrationDestinationPorts<Tx>,'audience'|'create'>={
 async audience(tx,caller,destination){if(destination.kind!=='task')throw Error('APP_INTEGRATION_DESTINATION_CHANGED_OR_DENIED');
  const [project]=await tx.select().from(projects).where(and(eq(projects.org_id,caller.org_id),eq(projects.id,destination.project_id),eq(projects.is_deleted,false),eq(projects.is_archived,false))).for('share');
  const members=await tx.select({id:orgMembers.id,user_id:orgMembers.user_id,version:orgMembers.app_run_authorization_version}).from(orgMembers).where(and(eq(orgMembers.org_id,caller.org_id),eq(orgMembers.is_active,true))).for('share');
  if(!project||!members.some(m=>m.user_id===caller.user_id))throw Error('APP_INTEGRATION_DESTINATION_CHANGED_OR_DENIED');members.sort((a,b)=>a.id.localeCompare(b.id));
  return {visibility:'project',label:project.name+' · Organization members',member_count:members.length,identity:{project:{id:project.id,name:project.name,prefix:project.prefix,lead_id:project.lead_id},members}};
 },
 async create(tx,caller,input,snapshot,request_id){if(input.destination.kind!=='task')throw Error('APP_INTEGRATION_DESTINATION_CHANGED_OR_DENIED');
  const citation='/apps/source/transfer/'+encodeURIComponent(request_id),quote=input.mode==='excerpt'?'\n\n'+input.excerpt!:'';
  const task=await createNativeTask(tx,{org_id:caller.org_id,project_id:input.destination.project_id,user_id:caller.user_id,title:input.title,
   description:'Original source (requires access): '+citation+quote,metadata:{app_integration_transfer:{source_citation:citation,observed_at:snapshot.publication.observed_at,partial:snapshot.publication.partial}}});
  return {destination_kind:'task',destination_id:task.id,destination_url:'/tasks?task='+encodeURIComponent(task.id),replayed:false};
 },
};
export async function afterAppIntegrationTaskCommit(input:{id:string;org_id:string;project_id:string;title:string}){
 getIO()?.to('org:'+input.org_id).emit('task:created',input);
 await enqueue(QUEUE_NAMES.AGENT_JOBS,'duplicate-detect',{taskId:input.id,title:input.title,projectId:input.project_id,orgId:input.org_id});
}
