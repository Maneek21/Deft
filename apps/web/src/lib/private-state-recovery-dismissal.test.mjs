import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const module = { exports: {} };
const code = ts.transpileModule(readFileSync(new URL('./private-state-recovery-dismissal.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
vm.runInNewContext(code,{exports:module.exports,module,crypto:globalThis.crypto,TextEncoder,Uint8Array});
const { recoveryDismissalKey } = module.exports;
const scope={org_id:'org',user_id:'owner',app_installation_id:'install',app_version_id:'version',grant_snapshot_id:'grant',lifecycle_epoch:1,grant_epoch:1,artifact_digest:'digest'};
const record={record_id:'record',revision:1,byte_length:5,created_at:'2026-10-01T00:00:00.000Z',expires_at:'2026-10-10T00:00:00.000Z'};
const states=[{key:'drafts',context:{groups:[{source_artifact_digest:'old',source_app_version_id:'old-version',source_version:'2.1',count:1,records:[record]}]}}];
test('recovery dismissal is exact owner artifact target authority and legacy-record scope',async()=>{
 const original=await recoveryDismissalKey(scope,'personal',states);
 assert.match(original,/^deft\.recovery\.dismissed\.v1\.[a-f0-9]{64}$/);assert.equal(original.includes('owner'),false);
 assert.equal(original,await recoveryDismissalKey({...scope},'personal',structuredClone(states)));
 for(const key of ['org_id','user_id','app_installation_id','app_version_id','grant_snapshot_id','artifact_digest'])assert.notEqual(original,await recoveryDismissalKey({...scope,[key]:'changed'},'personal',states));
 assert.notEqual(original,await recoveryDismissalKey({...scope,grant_epoch:2},'personal',states));
 assert.notEqual(original,await recoveryDismissalKey(scope,'recipient',states));
 for(const key of ['record_id','revision','byte_length','expires_at']){const altered=structuredClone(states);Object.assign(altered[0].context.groups[0].records[0],{[key]:typeof record[key]==='number'?2:'changed'});assert.notEqual(original,await recoveryDismissalKey(scope,'personal',altered));}
});
