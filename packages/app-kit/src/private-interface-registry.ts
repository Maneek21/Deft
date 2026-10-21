import {z} from 'zod';

/** Trusted author-tool extensions only. Host does not load extension packages. */
export const ReviewedOperationPolicySchema=z.strictObject({
 risk_class:z.literal('external_write'),review_requirement:z.literal('always'),review_scope:z.literal('per_invocation'),
 egress_class:z.string().min(1).max(48),retry_class:z.literal('idempotent_with_key'),retention_class:z.literal('standard'),
 automation_eligibility:z.literal('forbidden'),provider_idempotency_key_required:z.literal(true),
});
export type ReviewedOperationPolicy=z.infer<typeof ReviewedOperationPolicySchema>;
export type PrivateInterfaceDescriptor=Readonly<{
 key:string;version:string;provider_kind:'mcp';operation_name:string;
 input_schema:Readonly<Record<string,unknown>>;output_schema:Readonly<Record<string,unknown>>;host_policy:ReviewedOperationPolicy;
 action_binding:Readonly<{inputs:readonly Readonly<{input_key:string;source_kind:'resource_field'|'selected_relation_field';
 source_resource_requirement?:'placement';resource_requirement?:'placement';selection?:'one';allowed_field_types:readonly string[]}>[];
 distinct_resource_field_inputs:readonly (readonly [string,string])[]}>;
}>;
export type ReviewedAutomationPolicy=Readonly<{
 key:string;version:'1';authority_owner:'deft_core';app_authored:false;app_selectable:false;schedule_selectable:false;
 private_interface:PrivateInterfaceDescriptor;action_binding:PrivateInterfaceDescriptor['action_binding'];base_host_policy:ReviewedOperationPolicy;
 review_scope:'approved_automation_definition';definition:Readonly<{fully_pinned:true;approving_roles:readonly ['owner','admin']}>;
 limits:Readonly<{external_actions_per_fire:1}>;
}>;
export type PrivateInterfaceProfile=Readonly<{
 descriptor:PrivateInterfaceDescriptor;input:z.ZodType<Record<string,string>>;automation:ReviewedAutomationPolicy;
 validateBinding:(binding:{input_key:string;source:{kind:string;input_type?:string}})=>string|undefined;
 requiredInputs:readonly string[];
}>;
const profiles=new Map<string,PrivateInterfaceProfile>();
/** Called by explicitly loaded, trusted tooling extensions; never by a manifest.
 * Registration is write-once to prevent policy replacement in the process. */
export function registerPrivateInterfaceProfile(profile:PrivateInterfaceProfile):void {
 const key=`${profile.descriptor.key}:${profile.descriptor.version}`,prior=profiles.get(key);
 if(prior&&prior!==profile)throw Error('PRIVATE_INTERFACE_PROFILE_ALREADY_REGISTERED');
 profiles.set(key,Object.freeze(profile));
}
export function privateInterfaceProfile(ref:{key:string;version:string}):PrivateInterfaceProfile|undefined{return profiles.get(`${ref.key}:${ref.version}`);}
export function privateInterfaceDescriptors():readonly PrivateInterfaceDescriptor[]{return Object.freeze([...profiles.values()].map(p=>p.descriptor));}
export function parsePrivateInterfaceInput(ref:{key:string;version:string},value:unknown){
 const profile=privateInterfaceProfile(ref);
 if(!profile)throw TypeError('Private interface input parser is not registered');
 return profile.input.safeParse(value);
}
/** Host safety policy is unavailable until a trusted implementation is loaded.
 * A manifest cannot turn an unregistered interface into an executable action. */
const unavailablePolicy:ReviewedOperationPolicy={risk_class:'external_write',review_requirement:'always',review_scope:'per_invocation',egress_class:'unavailable',retry_class:'idempotent_with_key',retention_class:'standard',automation_eligibility:'forbidden',provider_idempotency_key_required:true};
const unavailableInterface:PrivateInterfaceDescriptor={key:'unavailable',version:'1',provider_kind:'mcp',operation_name:'unavailable',input_schema:{},output_schema:{},host_policy:unavailablePolicy,action_binding:{inputs:[],distinct_resource_field_inputs:[]}};
const unavailable:ReviewedAutomationPolicy={key:'unavailable',version:'1',authority_owner:'deft_core',app_authored:false,app_selectable:false,schedule_selectable:false,private_interface:unavailableInterface,action_binding:unavailableInterface.action_binding,base_host_policy:unavailablePolicy,review_scope:'approved_automation_definition',definition:{fully_pinned:true,approving_roles:['owner','admin']},limits:{external_actions_per_fire:1}};
function freeze<T>(value:T):T {if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
freeze(unavailable);
export const REVIEWED_AUTOMATION_POLICY:ReviewedAutomationPolicy=Object.freeze(Object.defineProperties({},
 Object.fromEntries(Object.keys(unavailable).map(key=>[key,{enumerable:true,get:()=>Reflect.get([...profiles.values()][0]?.automation??unavailable,key)}]))
)) as ReviewedAutomationPolicy;
