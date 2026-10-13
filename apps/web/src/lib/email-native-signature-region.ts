import {parseNativeSafeComposeHtml as parseSafeComposeHtml,plainTextToNativeComposeHtml} from '../../../../packages/app-kit/src/safe-compose-html';
import type {NativeDraftContent} from './email-native-drafts';
import type {NativeSignaturePreferences} from './email-native-signatures';
export type NativeManagedSignature={schema_version:'deft.email_signature_region.v1';identity_key:string;preference_revision:number;plain:{start:number;text:string};rich:null|{start:number;html:string}};
const normalize=(address:string)=>address.trim().toLocaleLowerCase('en-US');
const closed=(value:unknown,keys:string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export function validNativeSignatureRegionShape(raw:unknown):raw is NativeManagedSignature{
 const range=(value:unknown,key:string)=>closed(value,['start',key])&&typeof value.start==='number'&&Number.isSafeInteger(value.start)&&value.start>=0&&value.start<=262144&&typeof value[key]==='string'&&(value[key] as string).length>0&&(value[key] as string).length<=16384;
 return closed(raw,['schema_version','identity_key','preference_revision','plain','rich'])&&raw.schema_version==='deft.email_signature_region.v1'&&typeof raw.identity_key==='string'&&/^[a-f0-9]{64}$/u.test(raw.identity_key)&&typeof raw.preference_revision==='number'&&Number.isSafeInteger(raw.preference_revision)&&raw.preference_revision>=1&&raw.preference_revision<=2147483647&&range(raw.plain,'text')&&(raw.rich===null||range(raw.rich,'html'));
}
export function nativeSignatureRegionIntact(content:NativeDraftContent):boolean{
 const region=content.managed_signature;if(!region||!content.from_identity||!validNativeSignatureRegionShape(region)||content.body.slice(region.plain.start)!==region.plain.text)return false;
 if(region.rich===null)return content.body_html==='';
 try{return content.body_html.slice(region.rich.start)===region.rich.html&&parseSafeComposeHtml(content.body_html,{inlineAttachments:content.attachments}).plainText===content.body&&(region.rich.start===0?'':parseSafeComposeHtml(content.body_html.slice(0,region.rich.start),{inlineAttachments:content.attachments}).plainText).length===region.plain.start;}catch{return false;}
}
export function detachNativeSignatureRegion(content:NativeDraftContent):NativeDraftContent{
 const preserved=structuredClone(content);delete preserved.managed_signature;return preserved;
}
/** User text is never inferred to be a signature. Only the exact previously
 * marked terminal slices may follow an edit or be removed on explicit choice. */
export function reconcileNativeSignatureEdit(next:NativeDraftContent,previous:NativeDraftContent):NativeDraftContent{
 if(!next.managed_signature)return next;const old=previous.managed_signature;
 if(old&&JSON.stringify(old)===JSON.stringify(next.managed_signature)){
  if(normalize(next.from_identity?.address??'')!==normalize(previous.from_identity?.address??''))return detachNativeSignatureRegion(next);
  const adjusted={...structuredClone(next),managed_signature:{...structuredClone(old),plain:{...old.plain,start:next.body.length-old.plain.text.length},rich:old.rich?{...old.rich,start:next.body_html.length-old.rich.html.length}:null}};
  return nativeSignatureRegionIntact(adjusted)?adjusted:detachNativeSignatureRegion(next);
 }
 return nativeSignatureRegionIntact(next)?next:detachNativeSignatureRegion(next);
}
export function selectNativeSignature(content:NativeDraftContent,preferences:NativeSignaturePreferences,address:string,force=false):{content:NativeDraftContent;notice:string}{
 const identity=preferences.identity_availability.available?.find(item=>normalize(item.address)===normalize(address));if(!identity)throw Error('This sender address is no longer verified. Your draft is unchanged.');
 let base=structuredClone(content);const owned=nativeSignatureRegionIntact(base),hadMarker=!!base.managed_signature;
 if(owned){const region=base.managed_signature!;base.body=base.body.slice(0,region.plain.start);if(region.rich)base.body_html=base.body_html.slice(0,region.rich.start);}
 base=detachNativeSignatureRegion(base);base.from_identity={address:identity.address};
 const entry=preferences.preferences.identities.find(item=>normalize(item.address)===normalize(identity.address)),reply=['reply','reply_all'].includes(base.mode),applies=entry&&(force||entry.placement==='both'||entry.placement===(reply?'reply':'new'));
 const kept=hadMarker&&!owned?'The earlier signature was edited and is kept as message text. ':'';
 if(!applies||!entry.plain)return {content:base,notice:kept+'Sender selected. Review your message before sending.'};
 if(preferences.revision<1)throw Error('Saved signature preferences could not be confirmed. Your draft is unchanged.');
 let plain:string,rich:NativeManagedSignature['rich']=null,body_html='';
 if(base.body_html||entry.html){
  if(base.body_html&&parseSafeComposeHtml(base.body_html,{inlineAttachments:base.attachments}).plainText!==base.body)throw Error('The message formatting could not be confirmed. Your draft is unchanged.');
  const prefix=base.body_html||plainTextToNativeComposeHtml(base.body),suffix=(prefix?'<p></p>':'')+(entry.html||plainTextToNativeComposeHtml(entry.plain));body_html=prefix+suffix;plain=parseSafeComposeHtml(body_html,{inlineAttachments:base.attachments}).plainText;
  rich={start:prefix.length,html:suffix};
 }else plain=base.body+(base.body?'\n\n':'')+entry.plain;
 const start=base.body.length,region:NativeManagedSignature={schema_version:'deft.email_signature_region.v1',identity_key:identity.identity_key,preference_revision:preferences.revision,plain:{start,text:plain.slice(start)},rich};
 const result={...base,body:plain,body_html,managed_signature:region};if(!nativeSignatureRegionIntact(result))throw Error('The signature formatting could not be added safely. Your draft is unchanged.');
 return {content:result,notice:kept+'Signature inserted. Review your message before sending.'};
}
export function applyInitialNativeSignature(options:{current:()=>boolean;eligible:boolean;locked:()=>boolean;baseline:string;primaryAddress:string;preferences:NativeSignaturePreferences;writer:{snapshot:()=>{content:NativeDraftContent;state:string;fileMutation?:unknown};edit:(content:NativeDraftContent)=>void}}):boolean{
 if(!options.current()||!options.eligible||options.locked())return false;const now=options.writer.snapshot();if(['conflict','denied'].includes(now.state)||now.fileMutation||JSON.stringify(now.content)!==options.baseline)return false;
 const selected=selectNativeSignature(now.content,options.preferences,now.content.from_identity?.address??options.primaryAddress);if(!selected.content.managed_signature||!options.current()||options.locked())return false;options.writer.edit(selected.content);return true;
}
export function isNativeSignatureOnlyDraft(content:NativeDraftContent):boolean{
 return content.mode==='compose'&&!content.to&&!content.cc&&!content.bcc&&!content.subject&&!content.attachments.length&&nativeSignatureRegionIntact(content)&&content.managed_signature!.plain.start===0;
}
/** Account selection alone is not a human text edit. Only an untouched automatic
 * signature can be removed here; edited and manually entered text is kept. */
export function nativeSignatureAccountSwitch(content:NativeDraftContent,untouched:boolean){
 const eligible=untouched&&(isNativeSignatureOnlyDraft(content)||content.mode==='compose'&&!content.to&&!content.cc&&!content.bcc&&!content.subject&&!content.body&&!content.body_html&&!content.attachments.length&&!content.reply_record_id);
 const next=structuredClone(content);if(eligible&&nativeSignatureRegionIntact(next)){const marker=next.managed_signature!;next.body=next.body.slice(0,marker.plain.start);if(marker.rich)next.body_html=next.body_html.slice(0,marker.rich.start);}
 delete next.from_identity;return {content:detachNativeSignatureRegion(next),eligible};
}
