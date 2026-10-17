import {lookup as systemLookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {canonicalCapabilityJson} from '@deft/shared';
import {z} from 'zod';
import {NativeEmailSendIdentitySchema, type NativeEmailAccount, type NativeEmailConnectionContext} from './email-native-adapter-contract.js';
import type {EmailImapCredentialCustody} from './email-imap-custody.js';
import type {EmailImapHostAccount} from './email-imap-host.js';
import {publicEmailServerAddress} from './email-public-address.js';

type Context=NativeEmailConnectionContext;
export type EmailSmtpTransport={verify?():Promise<boolean>;sendMail(input:{raw:Uint8Array;envelope:{from:string;to:readonly string[]};disableFileAccess:true;disableUrlAccess:true}):Promise<unknown>;close():void};
export type EmailSmtpDependencies={custody:Pick<EmailImapCredentialCustody,'withVerifiedSmtpProfile'>;
 current(context:Context,purpose:'send'):Promise<EmailImapHostAccount>;
 createTransport(options:Record<string,unknown>):EmailSmtpTransport;
 lookup?:(host:string,options:{all:true;verbatim:true})=>Promise<readonly {address:string;family:number}[]>;};
export class EmailSmtpHostError extends Error{constructor(readonly code:'EMAIL_ACCESS_DENIED'|'EMAIL_SMTP_UNAVAILABLE'){super(code);this.name='EmailSmtpHostError';}}
const denied=():never=>{throw new EmailSmtpHostError('EMAIL_ACCESS_DENIED');};
const Envelope=z.strictObject({from:z.string().email().max(320),to:z.array(z.string().email().max(320)).min(1).max(200)});
const fields=['account_id','provider','resource_binding_id','authority_epoch','connection_revision','principal_digest','health','capabilities','primary_address','display_label'] as const;
const extras=['connection_target','action_binding_id','verified_sender_identities'] as const;

/** Encrypted credentials are used only inside the server callback. SMTP options
 * pin a public address while certificate/SNI verification retains the hostname.
 * Reservation/retry decisions belong to the durable Send service, not transport. */
export function createEmailSmtpHost(dependencies:EmailSmtpDependencies){
 const current=async(context:Context,expected:NativeEmailAccount)=>{
  if(context.lifecycle_inspect!==undefined)return denied();
  context.signal?.throwIfAborted();if(context.expires_at<=Date.now())return denied();await context.recheck();
  const parsed=NativeEmailSendIdentitySchema.safeParse(await dependencies.current(context,'send'));if(!parsed.success)return denied();const account=parsed.data;
  if(account.provider!=='imap_smtp'||account.org_id!==context.org_id||account.owner_user_id!==context.owner_user_id||account.installation_id!==context.installation_id
   ||account.account_id!==context.account_id||account.resource_binding_id!==context.resource_binding_id||context.expires_at<=Date.now()
   ||fields.some(key=>canonicalCapabilityJson(account[key])!==canonicalCapabilityJson(expected[key])))return denied();
  for(const key of extras)if(key in expected&&canonicalCapabilityJson(account[key])!==canonicalCapabilityJson((expected as unknown as Record<string,unknown>)[key]))return denied();
  await context.recheck();context.signal?.throwIfAborted();return account;
 };
 return Object.freeze({async withAuthorizedSmtp<T>(context:Context,expected:NativeEmailAccount,work:(transport:EmailSmtpTransport)=>Promise<T>):Promise<T>{
  const before=await current(context,expected),fingerprint=canonicalCapabilityJson(before);
  const check=async()=>{if(canonicalCapabilityJson(await current(context,expected))!==fingerprint)return denied();};
  return dependencies.custody.withVerifiedSmtpProfile(context,expected,async profile=>{
   let transport:EmailSmtpTransport|undefined,closed=false,sent=false,timedOut=false,timer:ReturnType<typeof setTimeout>|undefined;
   const close=()=>{if(!closed){closed=true;try{transport?.close();}catch{}}};
   let rejectAbort:(error:unknown)=>void=()=>{};
   const interrupted=new Promise<never>((_,reject)=>{rejectAbort=reject;});
   // Mark rejection handled even if cancellation arrives during the preflight.
   void interrupted.catch(()=>{});
   const abort=()=>{close();rejectAbort(context.signal?.reason??new EmailSmtpHostError('EMAIL_ACCESS_DENIED'));};
   context.signal?.addEventListener('abort',abort,{once:true});
   timer=setTimeout(()=>{timedOut=true;close();rejectAbort(new EmailSmtpHostError('EMAIL_SMTP_UNAVAILABLE'));},45_000);
   let auth:{user:string;pass:string}|undefined;
   try{
    await check();
    if(profile.tls.rejectUnauthorized!==true||profile.tls.minVersion!=='TLSv1.2'
     ||profile.tls.mode==='implicit_tls'&&profile.port!==465||profile.tls.mode==='starttls_required'&&profile.port!==587
     ||!['implicit_tls','starttls_required'].includes(profile.tls.mode)||!profile.username||!profile.password||isIP(profile.host)||!profile.host.includes('.'))return denied();
    const resolve=dependencies.lookup??systemLookup;
    const addresses=await Promise.race([resolve(profile.host,{all:true,verbatim:true}),interrupted]);
    if(!Array.isArray(addresses)||!addresses.length||addresses.length>32||addresses.some(row=>!publicEmailServerAddress(row.address)||isIP(row.address)!==row.family))return denied();
    await check();if(timedOut||closed)return denied();
    auth={user:profile.username,pass:profile.password};
    transport=dependencies.createTransport({host:addresses[0]!.address,port:profile.port,secure:profile.tls.mode==='implicit_tls',requireTLS:true,ignoreTLS:false,
      tls:{servername:profile.host,rejectUnauthorized:true,minVersion:'TLSv1.2'},auth,pool:false,logger:false,debug:false,
      connectionTimeout:20_000,greetingTimeout:10_000,socketTimeout:30_000,disableFileAccess:true,disableUrlAccess:true});
    const facade:EmailSmtpTransport={close,async verify(){await check();if(closed||timedOut||!transport?.verify)return denied();const result=await Promise.race([transport.verify(),interrupted]);await check();if(result!==true)throw new EmailSmtpHostError('EMAIL_SMTP_UNAVAILABLE');return true;},async sendMail(input){
      await check();if(sent||closed||timedOut)return denied();
      const envelope=Envelope.parse(input.envelope);
      if(!before.verified_sender_identities.includes(envelope.from)||!(input.raw instanceof Uint8Array)||input.raw.byteLength<1||input.raw.byteLength>36*1024*1024)return denied();
      sent=true;const raw=Buffer.from(input.raw);
      const pending=transport!.sendMail({raw,envelope,disableFileAccess:true,disableUrlAccess:true}).finally(()=>raw.fill(0));
      const result=await Promise.race([pending,interrupted]);await check();return result;
    }};
    const result=await Promise.race([work(facade),interrupted]);await check();return result;
   }catch(error){if(context.signal?.aborted)throw error;if(error instanceof EmailSmtpHostError)throw error;throw new EmailSmtpHostError('EMAIL_SMTP_UNAVAILABLE');}
   finally{clearTimeout(timer);context.signal?.removeEventListener('abort',abort);close();if(auth)auth.pass='';}
  });
 }});
}
