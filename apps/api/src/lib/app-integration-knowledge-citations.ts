import {and,eq,inArray,or,sql} from 'drizzle-orm';
import {isDeepStrictEqual} from 'node:util';
import {wikiPages,wikiCitations} from '@deft/db/schema';
import {appIntegrationCaptureSources as sources} from '../../../../packages/db/src/app-integration-capture-schema.js';
import type {AppRunTransaction as Tx} from './app-run-repository.js';
import type {AppIntegrationSourceCaller,AppIntegrationSourceSnapshot} from './app-integration-source.js';
import type {AppIntegrationSourceIdentity} from '../../../../packages/app-kit/src/app-integration-source.js';

/** Destination copy visibility is independent of permission to open its source.
 * Capturing-owner attribution never bypasses removal from a Space destination. */
export function appIntegrationKnowledgeDestinationCondition(user_id:string,org_id:string){return and(eq(wikiPages.org_id,org_id),eq(wikiPages.is_deleted,false),
 sql`exists(select 1 from org_members m where m.org_id=${org_id} and m.user_id=${user_id} and m.is_active=true)`,
 or(and(eq(wikiPages.scope,'user'),eq(wikiPages.user_id,user_id)),and(eq(wikiPages.scope,'space'),sql`exists(select 1 from spaces s join space_members m on m.space_id=s.id where s.id=${wikiPages.space_id} and s.org_id=${org_id} and s.is_archived=false and m.user_id=${user_id})`)));}
export async function readAppIntegrationRelatedKnowledge(tx:Tx,caller:AppIntegrationSourceCaller,snapshot:AppIntegrationSourceSnapshot,guard:()=>Promise<void>){
 if(!isDeepStrictEqual(caller,snapshot.caller)||snapshot.purpose!=='read')throw new Error('APP_INTEGRATION_SOURCE_CHANGED_OR_DENIED');
 await guard();
 const target=snapshot.publication.target;
 // Exact account/source first; a subject/title never widens the thread.
 const [source]=await tx.select({thread_key:sources.thread_key}).from(sources).where(and(eq(sources.org_id,caller.org_id),eq(sources.owner_user_id,caller.user_id),
  eq(sources.installation_id,target.installation_id),eq(sources.account_ref,target.account_ref),eq(sources.store_key,target.store_key),
  sql`${sources.target}->'ref'->>'record_id'=${target.ref.record_id}`)).limit(1);
 const rows=await tx.selectDistinctOn([wikiPages.id],{page_id:wikiPages.id,title:wikiPages.title,slug:wikiPages.slug,source_id:sources.id,publication:sources.publication})
  .from(sources).innerJoin(wikiCitations,and(eq(wikiCitations.org_id,caller.org_id),eq(wikiCitations.source_type,'app_integration'),eq(wikiCitations.source_id,sources.id)))
  .innerJoin(wikiPages,and(eq(wikiPages.org_id,caller.org_id),eq(wikiPages.id,wikiCitations.page_id)))
  .where(and(eq(sources.org_id,caller.org_id),eq(sources.owner_user_id,caller.user_id),eq(sources.installation_id,target.installation_id),eq(sources.account_ref,target.account_ref),
   eq(sources.store_key,target.store_key),source?eq(sources.thread_key,source.thread_key):sql`${sources.target}->'ref'->>'record_id'=${target.ref.record_id}`,
   appIntegrationKnowledgeDestinationCondition(caller.user_id,caller.org_id))).orderBy(wikiPages.id,sources.id).limit(20);
 await guard();return rows.map(row=>({...row,url:`/knowledge?slug=${encodeURIComponent(row.slug)}`,partial:true}));
}
export async function loadAppIntegrationCitationSources(tx:Tx,caller:AppIntegrationSourceCaller,ids:string[]){
 if(ids.length>32)throw new Error('APP_INTEGRATION_SOURCE_CHANGED_OR_DENIED');
 return ids.length?tx.select({id:sources.id,org_id:sources.org_id,owner_user_id:sources.owner_user_id,target:sources.target}).from(sources).innerJoin(wikiPages,and(eq(wikiPages.org_id,caller.org_id),eq(wikiPages.id,sources.page_id))).where(and(eq(sources.org_id,caller.org_id),inArray(sources.id,ids),appIntegrationKnowledgeDestinationCondition(caller.user_id,caller.org_id))):[];
}
/** Run AFTER the destination read transaction commits. Failed fresh source
 * checks remove only its link, never the destination-owned excerpt. No network
 * is performed while a destination transaction holds its visibility locks. */
export async function decorateAppIntegrationKnowledgeCitations<T extends {source_type:string;source_id:string}>(input:{caller:AppIntegrationSourceCaller;citations:T[];
 records:Array<{id:string;org_id:string;owner_user_id:string;target:Record<string,unknown>}>;
 read(caller:AppIntegrationSourceCaller,target:AppIntegrationSourceIdentity):Promise<unknown>}){
 const selected=input.citations.filter(row=>row.source_type==='app_integration').slice(0,32),ids=selected.map(row=>row.source_id);
 if(!ids.length)return input.citations;
 const records=input.records.filter(source=>source.org_id===input.caller.org_id&&ids.includes(source.id));
 const links=new Map<string,string|null>();
 for(const source of records){let href:string|null=null;
  if(source.owner_user_id===input.caller.user_id&&input.caller.kind==='human')try{
   await input.read(input.caller,source.target as AppIntegrationSourceIdentity);href=`/apps/source/${source.id}`;
  }catch{/* Destination copy remains readable; original access ended. */}
  links.set(source.id,href);
 }
 return input.citations.map(citation=>citation.source_type==='app_integration'?{...citation,source_label:'App source',source_url:links.get(citation.source_id)??null}:citation);
}
