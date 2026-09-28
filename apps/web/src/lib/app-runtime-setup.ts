export type RuntimeSetupRequest = { installation_id:string; action_key:string; operator_user_id:string;
  expected_app_version_id:string; expected_package_digest:string; expected_grant_snapshot_digest:string;
  expected_lifecycle_epoch:number; expected_grant_epoch:number };
export type RuntimeSetupContext = { schema_version:'deft.app_runtime_setup_context.v1';installation_id:string;app_version_id:string;
  grant_snapshot_id:string;package_digest:string;grant_snapshot_digest:string;lifecycle_epoch:number;grant_epoch:number;operator_user_id:string;
  policy:{review_requirement:'always';review_scope:'per_invocation';retry_class:'unsafe_or_unknown'};
  actions:{key:string;label:string;review_request:RuntimeSetupRequest;binding:{id:string;registration_id:string;operator_user_id:string;
    state:'disabled'|'active'|'revoked';registration_state:'disabled'|'active'|'revoked';can_issue_session:boolean}|null}[] };
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const exact=(x:Record<string,unknown>,keys:string[])=>Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
const digest=(x:unknown)=>typeof x==='string'&&/^sha256:[a-f0-9]{64}$/.test(x);
const epoch=(x:unknown)=>Number.isSafeInteger(x)&&Number(x)>=0;
export function parseRuntimeSetupContext(x:unknown):RuntimeSetupContext|null {
  if(!object(x)||!exact(x,['schema_version','installation_id','app_version_id','grant_snapshot_id','package_digest','grant_snapshot_digest','lifecycle_epoch','grant_epoch','operator_user_id','policy','actions'])
    ||x.schema_version!=='deft.app_runtime_setup_context.v1'||!uuid(x.installation_id)||!uuid(x.app_version_id)||!uuid(x.grant_snapshot_id)||!uuid(x.operator_user_id)
    ||!digest(x.package_digest)||!digest(x.grant_snapshot_digest)||!epoch(x.lifecycle_epoch)||!epoch(x.grant_epoch)
    ||!object(x.policy)||!exact(x.policy,['review_requirement','review_scope','retry_class'])||x.policy.review_requirement!=='always'||x.policy.review_scope!=='per_invocation'||x.policy.retry_class!=='unsafe_or_unknown'
    ||!Array.isArray(x.actions)||x.actions.length>16||JSON.stringify(x).length>65536)return null;
  const keys=new Set<string>();
  for(const row of x.actions){
    if(!object(row)||!exact(row,['key','label','review_request','binding'])||typeof row.key!=='string'||!/^[a-z][a-z0-9_]{0,47}$/.test(row.key)||keys.has(row.key)||typeof row.label!=='string'||row.label.length>128)return null;
    keys.add(row.key);const request=row.review_request;
    if(!object(request)||!exact(request,['installation_id','action_key','operator_user_id','expected_app_version_id','expected_package_digest','expected_grant_snapshot_digest','expected_lifecycle_epoch','expected_grant_epoch'])
      ||request.installation_id!==x.installation_id||request.action_key!==row.key||request.operator_user_id!==x.operator_user_id||request.expected_app_version_id!==x.app_version_id
      ||request.expected_package_digest!==x.package_digest||request.expected_grant_snapshot_digest!==x.grant_snapshot_digest||request.expected_lifecycle_epoch!==x.lifecycle_epoch||request.expected_grant_epoch!==x.grant_epoch)return null;
    const binding=row.binding;
    if(binding!==null&&(!object(binding)||!exact(binding,['id','registration_id','operator_user_id','state','registration_state','can_issue_session'])||!uuid(binding.id)||!uuid(binding.registration_id)||!uuid(binding.operator_user_id)
      ||!['active','disabled','revoked'].includes(String(binding.state))||!['active','disabled','revoked'].includes(String(binding.registration_state))||typeof binding.can_issue_session!=='boolean'
      ||binding.can_issue_session!==(binding.state==='active'&&binding.registration_state==='active'&&binding.operator_user_id===x.operator_user_id)))return null;
  }
  return x as RuntimeSetupContext;
}
export function runtimeSetupWebDeadline(token:string|null):number {
  try{if(!token)return 0;const segment=token.split('.')[1],payload=JSON.parse(atob(segment.replace(/-/g,'+').replace(/_/g,'/')));return typeof payload.exp==='number'?payload.exp*1000:0;}catch{return 0;}
}
