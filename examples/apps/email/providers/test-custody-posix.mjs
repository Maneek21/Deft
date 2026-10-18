import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// Refuse a skipped suite as evidence of private-file durability on Windows.
if(process.platform==='win32'){
 console.error(JSON.stringify({state:'unsupported',code:'EMAIL_CUSTODY_TEST_POSIX_REQUIRED'}));
 process.exitCode=1;
}else{
 const result=spawnSync(process.execPath,['--test','providers/oauth-account.test.mjs','providers/custody-file-store.test.mjs'],{
  cwd:fileURLToPath(new URL('..',import.meta.url)),stdio:'inherit',
 });
 process.exitCode=result.status??1;
}
