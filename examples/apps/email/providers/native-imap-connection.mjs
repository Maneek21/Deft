import {ImapFlow} from 'imapflow';
import nodemailer from 'nodemailer';
import {createNativeImapBridge} from './native-imap.mjs';
import {createNativeImapEffectsBridge} from './native-imap-effects.mjs';
import {fail} from './contract.mjs';

/** Registered bundle entry. The API supplies a host factory closed over exact
 * reviewed registry pins and current SQL/custody authority. Constructors ship
 * with this bundle; all credential/profile metadata stays in the API host.
 * Empty deployment options are intentional: no browser or adapter JSON can
 * nominate a server, password, account, principal, sender, or TLS policy.
 */
export async function createAppConnectionAdapter({host,options={},now=Date.now,monotonic=()=>performance.now(),imageDependencies}){
 if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).length||typeof host?.nativeEmailImapHost!=='function')fail('EMAIL_NATIVE_IMAP_HOST_REQUIRED');
 const nativeHost=await host.nativeEmailImapHost(Object.freeze({ImapFlow,createTransport:options=>nodemailer.createTransport(options)}));
 if(typeof nativeHost?.current!=='function'||typeof nativeHost?.withAuthorizedClient!=='function'||typeof nativeHost?.withAuthorizedSmtp!=='function')fail('EMAIL_NATIVE_IMAP_HOST_REQUIRED');
 const read=createNativeImapBridge({host:nativeHost,now,monotonic,imageDependencies}),effects=createNativeImapEffectsBridge({host:nativeHost,now,monotonic});
 return Object.freeze({...effects,...read,
  async handle(){return new Response(JSON.stringify({code:'EMAIL_NATIVE_IMAP_SETUP_HOST_REQUIRED',error:'Use authenticated account setup'}),{status:409,
   headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});},
 });
}
