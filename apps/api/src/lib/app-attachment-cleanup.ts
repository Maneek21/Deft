import { and,asc,eq,inArray,sql } from 'drizzle-orm';
import { appAttachmentStages,appSyncCheckpoints } from '@deft/db/schema';
import { createBoundedAppRunDatabase } from './app-run-bounded-db.js';
import { LocalAppAttachmentObjectStore,type AppAttachmentObjectStore } from './app-attachment-object-store.js';
import { env,isAppAttachmentBrokerEnabled } from './env.js';
type Candidate={id:string;org_id:string;resource_binding_id:string;checkpoint_id:string;state:string;stage_expires_at:Date};
const states=['uploading','ready','blocked','linked','linked_blocked','retired'] as const;

/** No keyring or executor is needed to purge quarantine. Each pass visits at
 * most20 retained rows under a10s deadline; a keyset advances past poison rows.
 * Ready bytes expire at their fixed host/Run ceiling, never the initial lease. */
export class AppAttachmentCleanup {
  #cursor:Candidate|null=null;
  #pending:Promise<{inspected:number;purged:number;failed:number}>|null=null;
  #database:ReturnType<typeof createBoundedAppRunDatabase>|null=null;
  #controller:AbortController|null=null;
  #stopped=false;
  constructor(private readonly enabled=isAppAttachmentBrokerEnabled,private readonly clock=()=>new Date(),
    private readonly objects:AppAttachmentObjectStore=new LocalAppAttachmentObjectStore(),private readonly connectionString=env.DATABASE_URL){}
  run(){
    if(this.#stopped||!this.enabled()||this.#pending)return Promise.resolve({inspected:0,purged:0,failed:0});
    const controller=new AbortController();this.#controller=controller;
    const pending=this.#pass(controller.signal).finally(()=>{if(this.#pending===pending)this.#pending=null;});
    this.#pending=pending;return pending;
  }
  async #pass(signal:AbortSignal){
    const deadline=performance.now()+10_000;
    const database=this.#database??=createBoundedAppRunDatabase(this.connectionString,{max:2,application_name:'deft-attachment-retention'});
    const after=this.#cursor;
    const candidates=await database.transaction(tx=>tx.select({id:appAttachmentStages.id,org_id:appAttachmentStages.org_id,
      resource_binding_id:appAttachmentStages.resource_binding_id,checkpoint_id:appAttachmentStages.checkpoint_id,
      state:appAttachmentStages.state,stage_expires_at:appAttachmentStages.stage_expires_at}).from(appAttachmentStages)
      .where(and(inArray(appAttachmentStages.state,[...states]),...(after?[sql`(${appAttachmentStages.state},${appAttachmentStages.stage_expires_at},${appAttachmentStages.id}) >
        (${after.state},${after.stage_expires_at.toISOString()}::timestamp,${after.id})`]:[])))
      .orderBy(asc(appAttachmentStages.state),asc(appAttachmentStages.stage_expires_at),asc(appAttachmentStages.id)).limit(20),signal,deadline);
    let inspected=0,purged=0,failed=0;
    for(const candidate of candidates){
      if(signal.aborted||performance.now()>=deadline)break;
      this.#cursor=candidate;inspected++;
      try{
        const retired=await database.transaction(async tx=>{
          await tx.select({id:appSyncCheckpoints.id}).from(appSyncCheckpoints).where(and(eq(appSyncCheckpoints.org_id,candidate.org_id),
            eq(appSyncCheckpoints.id,candidate.checkpoint_id),eq(appSyncCheckpoints.resource_binding_id,candidate.resource_binding_id))).for('update');
          const [row]=await tx.select().from(appAttachmentStages).where(and(eq(appAttachmentStages.org_id,candidate.org_id),eq(appAttachmentStages.id,candidate.id))).limit(1).for('update');
          if(!row||row.state==='purged')return null;
          const now=this.clock();
          const expired=['linked','linked_blocked'].includes(row.state)?!!row.linked_expires_at&&row.linked_expires_at<=now:row.stage_expires_at<=now;
          if(row.state!=='retired'&&!expired)return null;
          if(row.state!=='retired')await tx.update(appAttachmentStages).set({state:'retired',retired_at:now,updated_at:now})
            .where(and(eq(appAttachmentStages.org_id,row.org_id),eq(appAttachmentStages.id,row.id)));
          return row;
        },signal,deadline);
        if(!retired)continue;
        // Delete by reserved opaque identity even if a crash occurred after put
        // and before ready publication. Uncertain delete never releases budget.
        const deletion=this.objects.delete(retired.object_id??retired.id);
        let timer:ReturnType<typeof setTimeout>|undefined;
        let abort:()=>void=()=>{};
        try{await Promise.race([deletion,new Promise<never>((_,reject)=>{
          timer=setTimeout(()=>reject(new Error('Attachment purge deadline')),Math.max(1,deadline-performance.now()));
          abort=()=>reject(new Error('Attachment purge stopped'));signal.addEventListener('abort',abort,{once:true});
          if(signal.aborted)abort();
        })]);}finally{if(timer)clearTimeout(timer);signal.removeEventListener('abort',abort);}
        if(signal.aborted||performance.now()>=deadline)continue;
        await database.transaction(async tx=>{
          await tx.select({id:appSyncCheckpoints.id}).from(appSyncCheckpoints).where(and(eq(appSyncCheckpoints.org_id,candidate.org_id),eq(appSyncCheckpoints.id,candidate.checkpoint_id))).for('update');
          await tx.update(appAttachmentStages).set({state:'purged',purged_at:this.clock(),updated_at:this.clock(),metadata_envelope:null,
            object_id:null,binary_key_version:null,binary_nonce_b64:null,binary_auth_tag_b64:null})
            .where(and(eq(appAttachmentStages.org_id,candidate.org_id),eq(appAttachmentStages.id,candidate.id),eq(appAttachmentStages.state,'retired')));
        },signal,deadline);purged++;
      }catch{failed++;}
    }
    if(candidates.length<20&&inspected===candidates.length)this.#cursor=null;
    return {inspected,purged,failed};
  }
  async stop(){this.#stopped=true;this.#controller?.abort();await this.#pending?.catch(()=>{});await this.#database?.close();this.#database=null;}
}
export const appAttachmentCleanup=new AppAttachmentCleanup();
