import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyDeftAppPackageJson } from '@deft/app-kit';
import { verifiedPublicPackageJson } from '../src/lib/app-public-package-validation-memo.js';
import { verifiedExperienceBundle } from '../src/lib/app-experience-service.js';
const raw=readFileSync(new URL('./public-package-memo-fixture.json',import.meta.url),'utf8');const pkg=JSON.parse(raw);
const version:any={protocol_version:'7',manifest:pkg.manifest,package:pkg,package_digest:'sha256:6148c3403036fce729ec1f81d0156e6dbceec5fb0ae6b78bd5fb17a961ea4749',manifest_digest:pkg.manifest_digest};
test('actual public package memo cold and hit have exact verifier parity',async()=>{const original=await verifyDeftAppPackageJson(raw);assert.deepEqual(await verifiedPublicPackageJson(raw),original);assert.deepEqual(await verifiedPublicPackageJson(raw),original);});
test('cached package never bypasses fresh digest protocol experience or feature denials',async()=>{
 for(const name of ['DEFT_APPS_ENABLED','DEFT_APP_RUNS_ENABLED','DEFT_APP_RUN_APP_ORIGIN_ENABLED','DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED','DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED','DEFT_APP_ATTACHMENT_BROKER_ENABLED','DEFT_APP_PRIVATE_STATE_ENABLED'])process.env[name]='true';
 await verifiedPublicPackageJson(JSON.stringify(pkg));
 await assert.rejects(verifiedExperienceBundle({...version,package_digest:'sha256:'+'0'.repeat(64)},'main'));
 await assert.rejects(verifiedExperienceBundle({...version,manifest_digest:'sha256:'+'0'.repeat(64)},'main'));
 await assert.rejects(verifiedExperienceBundle({...version,protocol_version:'4'},'main'));
 await assert.rejects(verifiedExperienceBundle(version,'missing'));
 for(const flag of ['DEFT_APP_ATTACHMENT_BROKER_ENABLED','DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED','DEFT_APP_PRIVATE_STATE_ENABLED']){const prior=process.env[flag];process.env[flag]='false';try{await assert.rejects(verifiedExperienceBundle(version,'main'));}finally{process.env[flag]=prior;}}
});
