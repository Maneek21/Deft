import {nativeMessageUrl,type NativeMessageTarget} from './email-native-message-links';
import type {NativeEmailMessage} from './email-native-search';

/** A link preserves the Email access check. Message text is copied only by an
 * explicit choice, since ordinary Tasks may be visible across the workspace. */
export function nativeEmailTaskSeed(target:NativeMessageTarget,message:NativeEmailMessage,includeSubject:boolean){
 if(message.account_id!==target.account_id||message.logical_message_id!==target.logical_message_id)throw Error('This message could not be confirmed.');
 const href=nativeMessageUrl(target),subject=typeof message.data.subject==='string'?message.data.subject.replace(/[\u0000-\u001f\u007f-\u009f]/gu,' ').trim().slice(0,240):'';
 return {title:includeSubject&&subject?`Follow up: ${subject}`:'Follow up on email',description:'Open the source email with access to the connected email account.',sourceLink:{href,label:'Open source email'}};
}

export async function prepareNativeEmailTask(target:NativeMessageTarget,includeSubject:boolean,ports:{current:()=>boolean;read:(target:NativeMessageTarget)=>Promise<NativeEmailMessage>}){
 if(!ports.current())throw Error('Account access changed.');
 const row=await ports.read(target);
 if(!ports.current())throw Error('Account access changed.');
 return nativeEmailTaskSeed(target,row,includeSubject);
}
