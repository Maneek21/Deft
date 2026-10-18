/** Only the sealed original input can select a declared store. */
export function inspectionStoreLineage(input:Record<string,unknown>,actionKey:string,exposure:{action_keys:readonly string[];record_store_keys?:readonly string[];resource_keys:readonly string[]},manifest:{runtime_actions:readonly {key:string}[];record_stores?:readonly {key:string;resource_key:string}[]}){
 const key=input.record_store_key;
 return typeof key==='string'&&/^[a-z][a-z0-9_]{0,47}$/u.test(key)
  &&!['constructor','prototype','__proto__'].includes(key)
  &&exposure.action_keys.includes(actionKey)&&manifest.runtime_actions.some(action=>action.key===actionKey)
  &&exposure.record_store_keys?.includes(key)===true
  &&manifest.record_stores?.some(store=>store.key===key&&exposure.resource_keys.includes(store.resource_key))===true;
}
