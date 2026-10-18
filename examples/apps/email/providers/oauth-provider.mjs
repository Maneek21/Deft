import {singleAddress} from '../account-config.mjs';
import {EmailOAuthError,oauthDigest,oauthFail,oauthObject,oauthText} from './oauth-contract.mjs';

const GOOGLE_PREFIX='https://www.googleapis.com/auth/';
const GOOGLE_READ=GOOGLE_PREFIX+'gmail.readonly',GOOGLE_SEND=GOOGLE_PREFIX+'gmail.send';
const GOOGLE_MODIFY=GOOGLE_PREFIX+'gmail.modify',GOOGLE_FULL='https://mail.google.com/';
const GRAPH_PREFIX='https://graph.microsoft.com/';
const MAX_RESPONSE_BYTES=65536,TIMEOUT_MS=15000;
export function validateOAuthClient(provider,input){
 oauthObject(input,['client_id','client_secret','redirect_uri','tenant','verify_aliases'],'EMAIL_OAUTH_CLIENT_CONFIG_INVALID');
 let redirect;try{redirect=new URL(input.redirect_uri);}catch{oauthFail('EMAIL_OAUTH_CLIENT_CONFIG_INVALID');}
 if(!oauthText(input.client_id,512)||!oauthText(input.client_secret,4096)||!oauthText(input.redirect_uri,2048)||redirect.username||redirect.password||redirect.hash||redirect.search||!(redirect.protocol==='https:'||redirect.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(redirect.hostname))||provider==='gmail'&&input.tenant!==undefined||provider==='microsoft'&&(input.verify_aliases!==undefined||!['common','organizations','consumers'].includes(input.tenant)&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.tenant??''))||input.verify_aliases!==undefined&&typeof input.verify_aliases!=='boolean')oauthFail('EMAIL_OAUTH_CLIENT_CONFIG_INVALID');
 const value={client_id:input.client_id,client_secret:input.client_secret,redirect_uri:input.redirect_uri,...(provider==='microsoft'?{tenant:input.tenant}:{verify_aliases:input.verify_aliases??false})};
 return Object.freeze(value);
}
export const oauthClientFingerprint=(provider,client)=>oauthDigest([provider,client.client_id,client.redirect_uri,client.tenant??null,client.verify_aliases??null]);
export function requestedOAuthScopes(binding){
 const reads=binding.capabilities.some(item=>['read','search','thread'].includes(item));
 if(binding.provider==='gmail'){
  // Gmail's profile endpoint cannot be called with gmail.send alone.
  if(!reads)oauthFail('EMAIL_OAUTH_MAILBOX_READ_REQUIRED');
  return ['openid','email',GOOGLE_READ,...(binding.capabilities.includes('send')?[GOOGLE_SEND]:[]),...(binding.capabilities.includes('modify')?[GOOGLE_MODIFY]:[]),...(binding.capabilities.includes('permanent_delete')?[GOOGLE_FULL]:[])];
 }
 return ['offline_access',GRAPH_PREFIX+'User.Read',...(reads?[GRAPH_PREFIX+'Mail.Read']:[]),...(binding.capabilities.includes('send')?[GRAPH_PREFIX+'Mail.Send']:[]),...(binding.capabilities.some(item=>['modify','permanent_delete'].includes(item))?[GRAPH_PREFIX+'Mail.ReadWrite']:[])];
}
function normalizeScope(provider,value){
 if(provider==='microsoft'){const scope=value.replace(/^https:\/\/graph\.microsoft\.com\//i,'').toLowerCase();return ({'user.read':'User.Read','mail.read':'Mail.Read','mail.send':'Mail.Send','mail.readwrite':'Mail.ReadWrite','offline_access':'offline_access'})[scope]??null;}
 if(value==='email'||value===GOOGLE_PREFIX+'userinfo.email')return 'email';if(['openid',GOOGLE_READ,GOOGLE_SEND,GOOGLE_MODIFY,GOOGLE_FULL].includes(value))return value;return null;
}
export function normalizeOAuthScopes(provider,values){return [...new Set(values.map(value=>normalizeScope(provider,value)).filter(Boolean))].sort();}
export function grantedOAuthCapabilities(binding,scopes){
 const gmail=binding.provider==='gmail',full=gmail&&scopes.includes(GOOGLE_FULL),modify=full||scopes.includes(gmail?GOOGLE_MODIFY:'Mail.ReadWrite');
 const read=modify||scopes.includes(gmail?GOOGLE_READ:'Mail.Read'),send=(gmail&&modify)||scopes.includes(gmail?GOOGLE_SEND:'Mail.Send');
 return binding.capabilities.filter(item=>item==='permanent_delete'?(gmail?full:modify):item==='modify'?modify:item==='send'?send:read);
}
export function createOAuthProvider({provider,client,fetch:fetchImpl=globalThis.fetch,now=Date.now}){
 if(!['gmail','microsoft'].includes(provider)||typeof fetchImpl!=='function'||typeof now!=='function')oauthFail('EMAIL_OAUTH_CLIENT_CONFIG_INVALID');client=validateOAuthClient(provider,client);
 const authorize=provider==='gmail'?'https://accounts.google.com/o/oauth2/v2/auth':`https://login.microsoftonline.com/${client.tenant}/oauth2/v2.0/authorize`;
 const token=provider==='gmail'?'https://oauth2.googleapis.com/token':`https://login.microsoftonline.com/${client.tenant}/oauth2/v2.0/token`;
 async function json(url,{method='GET',body,bearer,checkAuthority}){
  await checkAuthority();let response;
  try{response=await fetchImpl(url,{method,body,headers:bearer?{Authorization:`Bearer ${bearer}`}:{'Content-Type':'application/x-www-form-urlencoded'},redirect:'error',signal:AbortSignal.timeout(TIMEOUT_MS)});}catch{oauthFail('EMAIL_OAUTH_PROVIDER_UNAVAILABLE',{outcome:method==='POST'?'credential_uncertain':'no_effect'});}
  const chunks=[];let size=0,reader;
  try{
   if(Number(response.headers?.get('content-length'))>MAX_RESPONSE_BYTES)oauthFail('EMAIL_OAUTH_PROVIDER_RESPONSE_LIMIT');
   reader=response.body?.getReader();if(!reader)oauthFail('EMAIL_OAUTH_PROVIDER_RESPONSE_INVALID');
   for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_RESPONSE_BYTES){await reader.cancel();oauthFail('EMAIL_OAUTH_PROVIDER_RESPONSE_LIMIT');}chunks.push(Buffer.from(value));}
   let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{oauthFail('EMAIL_OAUTH_PROVIDER_RESPONSE_INVALID');}
   if(!data||typeof data!=='object'||Array.isArray(data))oauthFail('EMAIL_OAUTH_PROVIDER_RESPONSE_INVALID');
   await checkAuthority();
   if(!response.ok)oauthFail(data.error==='invalid_grant'?'EMAIL_OAUTH_REAUTH_REQUIRED':response.status===401?'EMAIL_OAUTH_PROVIDER_IDENTITY_DENIED':response.status===403?'EMAIL_OAUTH_PROVIDER_SCOPE_DENIED':'EMAIL_OAUTH_PROVIDER_REQUEST_FAILED');
   return data;
  }catch(error){if(error instanceof EmailOAuthError){if(method==='POST'&&error.code.startsWith('EMAIL_OAUTH_PROVIDER_RESPONSE'))oauthFail(error.code,{outcome:'credential_uncertain'});throw error;}oauthFail('EMAIL_OAUTH_PROVIDER_UNAVAILABLE',{outcome:method==='POST'?'credential_uncertain':'no_effect'});}finally{reader?.releaseLock();}
 }
 function parseTokens(data,previousScopes,previousRefresh=null){
  if(!oauthText(data.access_token,16384)||typeof data.token_type!=='string'||data.token_type.toLowerCase()!=='bearer'||!Number.isSafeInteger(data.expires_in)||data.expires_in<1||data.expires_in>86400||data.refresh_token!==undefined&&!oauthText(data.refresh_token,16384))oauthFail('EMAIL_OAUTH_TOKEN_RESPONSE_INVALID',{outcome:'credential_uncertain'});
  if(data.scope!==undefined&&(!oauthText(data.scope,8192)||data.scope.split(/\s+/).length>64))oauthFail('EMAIL_OAUTH_TOKEN_RESPONSE_INVALID',{outcome:'credential_uncertain'});
  const scopes=data.scope===undefined?previousScopes:normalizeOAuthScopes(provider,data.scope.split(/\s+/));
  if(!scopes.includes(provider==='gmail'?'email':'User.Read')||provider==='gmail'&&!scopes.includes('openid'))oauthFail('EMAIL_OAUTH_IDENTITY_SCOPE_REQUIRED');
  const refresh_token=data.refresh_token??previousRefresh;if(!refresh_token)oauthFail('EMAIL_OAUTH_REFRESH_TOKEN_REQUIRED');
  return {access_token:data.access_token,refresh_token,expires_at:now()+data.expires_in*1000,scopes};
 }
 return Object.freeze({
  client_fingerprint:oauthClientFingerprint(provider,client),
  authorizationUrl({state,challenge,scopes}){
   const url=new URL(authorize);const params={client_id:client.client_id,redirect_uri:client.redirect_uri,response_type:'code',scope:scopes.join(' '),state,code_challenge:challenge,code_challenge_method:'S256',...(provider==='gmail'?{access_type:'offline',prompt:'consent select_account',include_granted_scopes:'false'}:{response_mode:'query',prompt:'select_account'})};for(const [key,value] of Object.entries(params))url.searchParams.set(key,value);return url.href;
  },
  async exchange({code,verifier,scopes,checkAuthority}){
   const body=new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,client_secret:client.client_secret,redirect_uri:client.redirect_uri,code,code_verifier:verifier,...(provider==='microsoft'?{scope:scopes.join(' ')}:{})});
   return parseTokens(await json(token,{method:'POST',body,checkAuthority}),normalizeOAuthScopes(provider,scopes));
  },
  async refresh({secret,checkAuthority}){
   const body=new URLSearchParams({grant_type:'refresh_token',client_id:client.client_id,client_secret:client.client_secret,refresh_token:secret.refresh_token,...(provider==='microsoft'?{scope:secret.scopes.filter(scope=>scope!=='offline_access').map(scope=>GRAPH_PREFIX+scope).join(' ')}:{})});
   return parseTokens(await json(token,{method:'POST',body,checkAuthority}),secret.scopes,secret.refresh_token);
  },
  async verify({tokens,checkAuthority}){
   if(provider==='microsoft'){
    const user=await json('https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName',{bearer:tokens.access_token,checkAuthority});
    if(!oauthText(user.id,256)||!singleAddress(user.mail))oauthFail('EMAIL_OAUTH_PROVIDER_IDENTITY_INVALID');
    return {provider_subject:user.id,primary_address:user.mail.toLowerCase(),verified_sender_identities:[user.mail.toLowerCase()],display_label:oauthText(user.displayName,256)?user.displayName:user.mail};
   }
   const user=await json('https://openidconnect.googleapis.com/v1/userinfo',{bearer:tokens.access_token,checkAuthority});
   if(!oauthText(user.sub,256)||user.email_verified!==true||!singleAddress(user.email))oauthFail('EMAIL_OAUTH_PROVIDER_IDENTITY_INVALID');
   if(![GOOGLE_READ,GOOGLE_MODIFY,GOOGLE_FULL].some(scope=>tokens.scopes.includes(scope)))oauthFail('EMAIL_OAUTH_MAILBOX_READ_REQUIRED');
   const profile=await json('https://gmail.googleapis.com/gmail/v1/users/me/profile',{bearer:tokens.access_token,checkAuthority});
   if(!singleAddress(profile.emailAddress)||profile.emailAddress.toLowerCase()!==user.email.toLowerCase())oauthFail('EMAIL_OAUTH_PROVIDER_IDENTITY_INVALID');
   const primary_address=profile.emailAddress.toLowerCase(),verified_sender_identities=[primary_address];
   if(client.verify_aliases){
    const result=await json('https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs',{bearer:tokens.access_token,checkAuthority});
    if(!Array.isArray(result.sendAs)||result.sendAs.length>32)oauthFail('EMAIL_OAUTH_PROVIDER_IDENTITY_INVALID');
    for(const alias of result.sendAs){if(alias?.verificationStatus==='accepted'&&singleAddress(alias.sendAsEmail)&&!verified_sender_identities.includes(alias.sendAsEmail.toLowerCase()))verified_sender_identities.push(alias.sendAsEmail.toLowerCase());}
   }
   return {provider_subject:user.sub,primary_address,verified_sender_identities,display_label:oauthText(user.name,256)?user.name:primary_address};
  },
  async revokeProjectGrant({refresh_token,checkAuthority}){
   if(provider!=='gmail')return {state:'user_portal_required',portals:[...(client.tenant!=='organizations'&&!/^[a-f0-9-]{36}$/i.test(client.tenant)?[{audience:'personal',url:'https://account.live.com/consent/Manage'}]:[]),...(client.tenant!=='consumers'?[{audience:'work_or_school',url:'https://myapps.microsoft.com/'}]:[])]};
   await checkAuthority();let response;try{response=await fetchImpl('https://oauth2.googleapis.com/revoke',{method:'POST',body:new URLSearchParams({token:refresh_token}),headers:{'Content-Type':'application/x-www-form-urlencoded'},redirect:'error',signal:AbortSignal.timeout(TIMEOUT_MS)});}catch{return {state:'unknown'};}
   const status=response.status;await response.body?.cancel();return {state:status===200?'revoked':status===400?'invalid_token':'unknown'};
  }
 });
}
