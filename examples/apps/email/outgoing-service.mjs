import {readFile,lstat,realpath} from 'node:fs/promises';
import {dirname,isAbsolute,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAppRuntimeClient} from '@deft/app-kit';
import {createEmailFileCustodyStore} from './providers/custody-file-store.mjs';
import {createEncryptedEmailCustody} from './providers/custody-encrypted.mjs';
import {createEmailSendJournal} from './outgoing-operation-store.mjs';
import {runEmailOutgoing} from './outgoing-runtime-service.mjs';

const fail=()=>{throw Error('EMAIL_SEND_PRIVATE_CONFIG_INVALID');};
/** Run one already authorized host attempt. Configuration is operator-owned;
 * it is never read from the Email package, browser or scalar action input. */
export async function runEmailOutgoingCli(args){
 const [mode,path]=args;if(args.length!==2||mode!=='send'||!isAbsolute(path??''))fail();
 const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536
  ||process.platform==='win32'||typeof process.getuid!=='function'||stat.uid!==process.getuid()||(stat.mode&0o077)!==0)fail();
 const actual=await realpath(path),moduleRoot=await realpath(dirname(fileURLToPath(import.meta.url)));
 if(actual===moduleRoot||actual.startsWith(moduleRoot+sep))fail();
 // Do not accept an otherwise-private configuration inside a source checkout.
 for(let directory=dirname(actual);;directory=dirname(directory)){
  if(await lstat(resolve(directory,'.git')).then(()=>true,()=>false))fail();if(dirname(directory)===directory)break;
 }
 let config;try{config=JSON.parse(await readFile(actual,'utf8'));}catch{fail();}
 const fields=['schema_version','channel_url','credential','account_binding','clients','custody_root','encryption_key_hex','key_id',
  'journal_root','journal_encryption_key_hex','journal_key_id','expected_run_id'];
 if(!config||config.schema_version!=='deft.email_outgoing_service.v1'||Object.keys(config).some(key=>!fields.includes(key))
  ||fields.some(key=>!Object.hasOwn(config,key))||!isAbsolute(config.custody_root??'')||!isAbsolute(config.journal_root??'')
  ||!['encryption_key_hex','journal_encryption_key_hex'].every(key=>/^[a-fA-F0-9]{64}$/.test(config[key]??''))
  ||!/^[0-9a-f-]{36}$/i.test(config.expected_run_id??''))fail();
 const sdk=createAppRuntimeClient({channel_url:config.channel_url,credential:config.credential,action_payload_version:'deft.app_action_payload.v1'});
 const store=await createEmailFileCustodyStore({root:config.custody_root}),journalStore=await createEmailFileCustodyStore({root:config.journal_root});
 const encryption_key=Buffer.from(config.encryption_key_hex,'hex'),journalKey=Buffer.from(config.journal_encryption_key_hex,'hex');
 try{return await runEmailOutgoing({sdk,account_binding:config.account_binding,clients:config.clients,expected_run_id:config.expected_run_id,
  custody:createEncryptedEmailCustody({store,encryption_key,key_id:config.key_id}),
  journal:createEmailSendJournal({store:journalStore,encryption_key:journalKey,key_id:config.journal_key_id})});
 }finally{encryption_key.fill(0);journalKey.fill(0);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(await runEmailOutgoingCli(process.argv.slice(2))));}
 catch{console.error(JSON.stringify({state:'stopped',code:'EMAIL_SEND_RUNTIME_UNAVAILABLE',automatic_retry:false}));process.exitCode=1;}
}
