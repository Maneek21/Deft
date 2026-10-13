import {nativeMessageUrl,parseNativeMessageLink} from './email-native-message-links';
/** An attention link is a nomination only; the Email host freshly checks the
 * current owner/account before opening content. No mail content is displayed here. */
export function nativeEmailAttentionHref(item:{source_type:string;source_id:string;metadata:Record<string,unknown>;link:string|null}):string|null{
 if(item.source_type!=='email'||typeof item.metadata.account_id!=='string'||typeof item.link!=='string'||!item.link.startsWith('/email?'))return null;
 try{const params=new URLSearchParams(item.link.slice(7));if([...params.keys()].some(key=>!['account','message'].includes(key)))return null;const target=parseNativeMessageLink(params.toString());return target&&target.account_id===item.metadata.account_id&&target.logical_message_id===item.source_id&&item.link===nativeMessageUrl(target)?nativeMessageUrl(target):null;}catch{return null;}
}
