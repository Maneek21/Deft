import {tasks,taskActivity} from '@deft/db/schema';
import type {AppRunTransaction} from './app-run-repository.js';
import {reserveNextTaskNumber} from './task-numbering.js';
/** Transaction-capable extraction of the existing route constructor. Caller
 * retains project/assignee checks and runs its existing notifications afterward. */
export async function createNativeTask(tx:AppRunTransaction,input:{org_id:string;project_id:string;user_id:string;title:string;
 description?:string|null;status?:string|null;priority?:string|null;assignee_id?:string|null;due_date?:string|null;sort_order?:number|null;
 source_message_id?:string|null;parent_task_id?:string|null;metadata?:Record<string,unknown>|null}){
 const number=await reserveNextTaskNumber({projectId:input.project_id,orgId:input.org_id,executor:tx});
 const [task]=await tx.insert(tasks).values({org_id:input.org_id,project_id:input.project_id,number,title:input.title,
  description:input.description||undefined,status:(input.status||'backlog') as typeof tasks.$inferInsert.status,
  priority:(input.priority||'p2') as typeof tasks.$inferInsert.priority,assignee_id:input.assignee_id??undefined,
  created_by:input.user_id,due_date:input.due_date?new Date(input.due_date):undefined,sort_order:input.sort_order??0,
  source_message_id:input.source_message_id||undefined,parent_task_id:input.parent_task_id||undefined,metadata:input.metadata??undefined}).returning();
 if(!task)throw Error('TASK_CREATE_FAILED');await tx.insert(taskActivity).values({org_id:input.org_id,task_id:task.id,user_id:input.user_id,action:'created'});return task;
}
