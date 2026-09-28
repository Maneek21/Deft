import {readFileSync} from 'node:fs';

const fail=()=>{throw Error('EMAIL_ACCOUNT_CONFIG_INVALID');};
const object=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))fail();};
const text=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\r\n\0]/.test(value);
export const singleAddress=value=>text(value,200)&&/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value);
const endpoint=(value,fixture)=>{
 object(value,['host','port','tls','auth','ca_file']);
 if(!text(value.host,253)||!Number.isInteger(value.port)||value.port<1||value.port>65535)fail();
 if(!['implicit','starttls',...(fixture?['none']:[])].includes(value.tls))fail();
 if(value.tls==='none'&&!['127.0.0.1','::1','localhost'].includes(value.host))fail();
 object(value.auth,['user','password']);
 if(!text(value.auth.user,320)||!text(value.auth.password,1024))fail();
 if(value.ca_file!==undefined&&!text(value.ca_file,4096))fail();
 return {...value,auth:{...value.auth}};
};
export function validateAccountConfig(value,{allowLoopbackFixture=false}={}) {
 object(value,['schema_version','mode','owner','smtp','imap','fixture_recipient','folders']);
 if(value.schema_version!=='deft.email_account.v1'||!['production','loopback_fixture'].includes(value.mode)||!singleAddress(value.owner))fail();
 const fixture=value.mode==='loopback_fixture';
 if(fixture&&!allowLoopbackFixture)fail();
 if(fixture?!singleAddress(value.fixture_recipient):value.fixture_recipient!==undefined)fail();
 if(value.folders!==undefined){object(value.folders,['sent','archive']);if(Object.values(value.folders).some(path=>!text(path,128)))fail();}
 return {schema_version:value.schema_version,mode:value.mode,owner:value.owner,smtp:endpoint(value.smtp,fixture),imap:endpoint(value.imap,fixture),...(value.fixture_recipient?{fixture_recipient:value.fixture_recipient}:{}),...(value.folders?{folders:{...value.folders}}:{})};
}
export function loadAccountConfig(path,{allowLoopbackFixture=false,allowLegacyFixture=false}={}) {
 const bytes=readFileSync(path);if(bytes.byteLength>32768)fail();
 let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{fail();}
 if(allowLegacyFixture&&value.schema_version===undefined) {
  object(value,['host','smtpPort','imapPort','owner','recipient','password']);
  value={schema_version:'deft.email_account.v1',mode:'loopback_fixture',owner:value.owner,fixture_recipient:value.recipient,
   smtp:{host:value.host,port:value.smtpPort,tls:'none',auth:{user:value.owner,password:value.password}},
   imap:{host:value.host,port:value.imapPort,tls:'none',auth:{user:value.owner,password:value.password}}};
 }
 return validateAccountConfig(value,{allowLoopbackFixture});
}
export function tlsOptions(endpoint) {
 let ca;if(endpoint.ca_file!==undefined){ca=readFileSync(endpoint.ca_file);if(ca.byteLength>65536)fail();}
 return {rejectUnauthorized:true,servername:endpoint.host,...(ca?{ca}:{}),minVersion:'TLSv1.2'};
}
