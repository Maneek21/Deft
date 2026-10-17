import {createApiTransport,fail,text} from './contract.mjs';
/** Names from this exact connected account under existing read authority.
 * Provider identifiers are values for a labelled picker, never editable UI. */
export async function readProviderTriageOptions(options,{max_options=100}={}){
 const account=options.account;if(!Number.isInteger(max_options)||max_options<1||max_options>100)fail('EMAIL_PROVIDER_INPUT_INVALID');
 const origin=account.provider==='gmail'?'https://gmail.googleapis.com':account.provider==='microsoft'?'https://graph.microsoft.com':null;
 if(!origin)fail('EMAIL_PROVIDER_OPERATION_UNSUPPORTED');const api=createApiTransport(options,origin);
 const result={schema_version:'deft.experience_triage_options.v1',account_id:account.account_id,provider:account.provider,destinations:[],labels:[],complete:false,labels_supported:account.provider==='gmail'};
 if(account.provider==='gmail'){
  const data=await api.request(origin+'/gmail/v1/users/me/labels',{maxBytes:65536});if(!Array.isArray(data.labels)||data.labels.length>10000)fail('EMAIL_PROVIDER_RESPONSE_INVALID');
  const labels=data.labels.filter(row=>row.type==='user').map(row=>({id:text(row.id,256),label:text(row.name,256)})).sort((a,b)=>a.label.localeCompare(b.label));
  const capacity=Math.floor((max_options-1)/2),shown=labels.slice(0,capacity);result.destinations=[{id:'INBOX',label:'Inbox',kind:'folder'},...shown.map(row=>({...row,kind:'label'}))];result.labels=shown;result.complete=shown.length===labels.length;
 }else{
  const data=await api.request(origin+'/v1.0/me/mailFolders?$top=100&$select=id,displayName',{headers:{Prefer:'IdType="ImmutableId"'},maxBytes:65536});if(!Array.isArray(data.value)||data.value.length>100)fail('EMAIL_PROVIDER_RESPONSE_INVALID');
  result.destinations=data.value.slice(0,max_options).map(row=>({id:text(row.id,256),label:text(row.displayName,256),kind:'folder'}));result.complete=data['@odata.nextLink']===undefined&&result.destinations.length===data.value.length;
  // Master categories require MailboxSettings.Read; do not expand consent.
 }
 await api.authority('read');return result;
}
