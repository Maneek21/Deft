import {appConsentDeadline,appConsentExpiryValid} from '@deft/app-kit/core';
type Target=Readonly<{key:string;label:string}>;
type Binding=Readonly<{id:string;key:string;target:string}>;
type Pins=Readonly<{org_id:string;owner_user_id:string;installation_id:string;app_version_id:string;grant_snapshot_id:string;lifecycle_epoch:number;grant_epoch:number}>;
const object=(value:unknown):Record<string,unknown>|null=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;

/** Labels are metadata only; the admitted target keys and account authority stay unchanged. */
export function experienceTargetAccountLabels(targets:readonly Target[],records:readonly unknown[],bindings:readonly Binding[],pins:Pins,now=Date.now()):Target[]{
  return targets.map(target=>{
    const labels=new Set<string>();
    for(const raw of records){
      const record=object(raw),scope=object(record?.scope),account=object(record?.account);
      if(record?.state!=='connected'||typeof record.runtime_session_ref!=='string'||!record.runtime_session_ref||!scope||!account
        ||Object.entries(pins).some(([key,value])=>scope[key]!==value)||scope.target_key!==target.key
        ||(typeof scope.consent_expires_at!=='string'&&scope.consent_expires_at!==null)||!appConsentExpiryValid(scope.consent_expires_at as string|null,scope.consent_lifetime)||appConsentDeadline(scope.consent_expires_at as string|null,scope.consent_lifetime)<=now
        ||!bindings.some(binding=>binding.id===scope.resource_binding_id&&binding.target===target.key&&binding.key===scope.resource_key)
        ||typeof account.account_ref!=='string'||!account.account_ref||typeof account.label!=='string'||!account.label.trim()
        ||account.label.length>80||/[\u0000-\u001f\u007f]/u.test(account.label))continue;
      labels.add(account.label);
    }
    return {...target,...(labels.size===1?{label:[...labels][0]!}:{})};
  });
}
