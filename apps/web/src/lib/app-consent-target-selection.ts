/** A current account must never silently renew a different account. */
export function selectConsentTarget(targets:readonly {target_key:string}[],requested:string|undefined,previous:string){
 if(requested!==undefined)return targets.some(t=>t.target_key===requested)?requested:'';
 return targets.some(t=>t.target_key===previous)?previous:targets[0]?.target_key??'';
}
