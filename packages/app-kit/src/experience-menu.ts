/** Inert menu declarations. Native integrations nominate a governed document;
 * the Host resolves current authority before opening its review surface. */
export const DEFT_EXPERIENCE_ICONS = ['compose','refresh','search','reply','archive','back','close','send','select','check','more','trash','mail','star','folder','label','chevron_down','read','unread','print'] as const;
export type DeftExperienceIcon = typeof DEFT_EXPERIENCE_ICONS[number];
export type DeftExperienceMenuItem = Readonly<{id:string;label:string;icon?:DeftExperienceIcon;disabled?:boolean;danger?:boolean;integration?:Readonly<{kind:'task'|'knowledge';document_id:string}>}>;
export type DeftExperienceMenuNode = Readonly<{kind:'menu';id:string;label:string;icon?:DeftExperienceIcon;disabled?:boolean;items:readonly DeftExperienceMenuItem[]}>;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const id=(value:unknown):value is string=>typeof value==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(value);
const closed=(value:Record<string,unknown>,keys:readonly string[])=>Object.keys(value).every(key=>keys.includes(key));
const label=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=128&&!/[\u0000-\u001f\u007f]/u.test(value);
export const isDeftExperienceIcon=(value:unknown):value is DeftExperienceIcon=>typeof value==='string'&&(DEFT_EXPERIENCE_ICONS as readonly string[]).includes(value);
function item(value:unknown):value is DeftExperienceMenuItem {
 return object(value)&&closed(value,['id','label','icon','disabled','danger','integration'])&&id(value.id)&&label(value.label)
  &&(value.icon===undefined||isDeftExperienceIcon(value.icon))&&(value.disabled===undefined||typeof value.disabled==='boolean')
  &&(value.danger===undefined||typeof value.danger==='boolean')
  &&(value.integration===undefined||object(value.integration)&&closed(value.integration,['kind','document_id'])
    &&(value.integration.kind==='task'||value.integration.kind==='knowledge')&&id(value.integration.document_id));
}
export function parseDeftExperienceMenuNode(value:unknown):DeftExperienceMenuNode|null {
 if(!object(value)||!closed(value,['kind','id','label','icon','disabled','items'])||value.kind!=='menu'||!id(value.id)||!label(value.label)
  ||value.icon!==undefined&&!isDeftExperienceIcon(value.icon)||value.disabled!==undefined&&typeof value.disabled!=='boolean'
  ||!Array.isArray(value.items)||value.items.length<1||value.items.length>20||!value.items.every(item)
  ||new Set([value.id,...value.items.map(row=>row.id)]).size!==value.items.length+1)return null;
 const optional=(row:DeftExperienceMenuItem)=>({...(row.icon===undefined?{}:{icon:row.icon}),...(row.disabled===undefined?{}:{disabled:row.disabled})});
 return {kind:'menu',id:value.id,label:value.label,...optional(value as unknown as DeftExperienceMenuItem),items:value.items.map(row=>({id:row.id,label:row.label,...optional(row),...(row.danger===undefined?{}:{danger:row.danger}),...(row.integration===undefined?{}:{integration:{...row.integration}})}))};
}
