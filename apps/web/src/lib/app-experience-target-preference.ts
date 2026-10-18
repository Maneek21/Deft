type Scope = Readonly<{orgId:string;userId:string;installationId:string}>;
type Catalog = readonly {key:string}[];
type Storage = Pick<globalThis.Storage,'getItem'|'setItem'>;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const target=/^[a-z][a-z0-9_]{0,47}$/;
/** A nomination is a UI preference. Only the fresh authorized catalog can admit it. */
export function experienceTargetPreferenceKey(scope:Scope):string|null {
 return [scope.orgId,scope.userId,scope.installationId].every(value=>uuid.test(value))
  ?`deft.experience.target.v1:${JSON.stringify([scope.orgId,scope.userId,scope.installationId])}`:null;
}
export function createExperienceTargetPreference(storage:Storage){
 const catalogKeys=(catalog:Catalog)=>catalog.length<=64&&catalog.every(item=>target.test(item.key))
  &&new Set(catalog.map(item=>item.key)).size===catalog.length?catalog.map(item=>item.key):null;
 return {
  select(scope:Scope,catalog:Catalog,current:()=>boolean,requested?:string):string|null {
   const keys=catalogKeys(catalog),key=experienceTargetPreferenceKey(scope);
   if(!key||!keys||!current())return null;
   let saved:string|null=null;try{saved=storage.getItem(key);}catch{/* Storage denial does not change authorization. */}
   if(!current())return null;
   return requested&&keys.includes(requested)?requested:saved&&keys.includes(saved)?saved:keys[0]??'primary';
  },
  remember(scope:Scope,catalog:Catalog,selected:string,current:()=>boolean):boolean {
   const key=experienceTargetPreferenceKey(scope),keys=catalogKeys(catalog);
   if(!key||!keys||!keys.includes(selected)||!current())return false;
   try{storage.setItem(key,selected);return true;}catch{return false;}
  },
 };
}
