import type {AppConnectionContext} from './app-connection-session-flow';
import type {ExperienceSettingsAccount} from './app-experience-settings';
/** Display-only metadata. The reviewed target catalog still controls selection. */
export function verifiedExperienceAccountLabels(context:AppConnectionContext){
 return context.targets.flatMap(target=>{const account=target.session?.account;
  return account&&['connected','indeterminate'].includes(target.session!.state)&&account.label.trim()?[{key:target.target_key,label:account.label}]:[];});
}
export function experienceSettingsAccounts(catalog:readonly ExperienceSettingsAccount[],labels:readonly {key:string;label:string}[]){
 const known=new Map(labels.map(item=>[item.key,item.label]));return catalog.map(item=>({...item,label:known.get(item.key)??item.label}));
}
export function observationIntervalLabel(seconds:number){return seconds%60===0?`${(seconds/60).toLocaleString()} ${seconds===60?'minute':'minutes'}`:`${seconds.toLocaleString()} seconds`;}
export function observationIntervalChoices(min:number,selected:number){
 if(!Number.isSafeInteger(min)||min<1||min>86400)return [];
 const values=[300,900,1800,3600].filter(value=>value>=min);
 for(const value of [...(values.length?[]:[min]),selected])if(Number.isSafeInteger(value)&&value>=min&&value<=86400&&!values.includes(value))values.push(value);
 return values.sort((a,b)=>a-b).map(value=>({value,label:observationIntervalLabel(value)}));
}
