import {readFileSync,realpathSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadAccountConfig} from './account-config.mjs';
import {runProvider} from './provider-runner.mjs';
import {drainSyncCycle} from './sync-daemon.mjs';

// Config contains private host credentials and journal paths. Never print it.
const root=dirname(fileURLToPath(import.meta.url));
const [mode,configPath]=process.argv.slice(2);
try {
if(!['sync','runtime','sync-daemon'].includes(mode)||!configPath)throw Error('Usage: node provider-cli.mjs sync|runtime|sync-daemon private-config.json');
const config=JSON.parse(readFileSync(resolve(configPath),'utf8'));
if(typeof config.account_file!=='string'||!config.account_file)throw Error('Private account configuration required');
const accountFile=resolve(dirname(resolve(configPath)),config.account_file);
const fixture=config.loopback_fixture===true;
const legacySchema=config.legacy_schema===true;
if(legacySchema&&!fixture)throw Error('Legacy schema requires explicit fixture mode');
loadAccountConfig(accountFile,{allowLoopbackFixture:fixture,allowLegacyFixture:fixture});
if(!config.credential?.session_id||!config.credential?.session_token)throw Error('Private session credential required');
if(mode!=='runtime'&&(!legacySchema&&(typeof config.inventoryPath!=='string'||!config.inventoryPath)||typeof config.stageJournal!=='string'||!config.stageJournal||typeof config.recoveryPath!=='string'||!config.recoveryPath))throw Error('Private sync paths required');
if(mode==='runtime'&&!['send_message','reply_message','archive_message'].includes(config.action))throw Error('Declared mail action required');
const controller=new AbortController(),stop=()=>controller.abort();
process.once('SIGINT',stop);process.once('SIGTERM',stop);
try {
 const options={root:realpathSync(root),config,accountFile,fixture,legacySchema,signal:controller.signal};
 if(mode==='sync-daemon'){
  const result=await drainSyncCycle(config,{signal:controller.signal,runPage:(signal,run_id)=>runProvider({...options,config:{...config,expected_run_id:run_id},signal,mode:'sync'}),onProgress:value=>console.log(JSON.stringify(value))});
  console.log(JSON.stringify(result));
 }else{
  const message=await runProvider({...options,mode});
  console.log(JSON.stringify({state:message.type,run_id:message.run_id,...(mode==='sync'?{record_count:message.count,tombstone_count:message.tombstone_count,has_more:message.has_more,attachment_count:message.attachment_count}:{action:message.action})}));
 }
} finally {process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
} catch(error) {
 // Only module-owned closed codes; never reflect host/network/library messages.
 const code=/^EMAIL_(DAEMON|PROVIDER)_[A-Z_]+$/.test(error?.message)?error.message:'EMAIL_PROVIDER_CONFIG_INVALID';
 console.error(JSON.stringify({state:'stopped',code,automatic_retry:false}));process.exitCode=1;
}
