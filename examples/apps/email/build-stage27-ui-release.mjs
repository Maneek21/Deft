import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {prepareDeftExperienceArtifact,buildDeftAppPackage} from '@deft/app-kit';

// Rebuild the UI Worker against the exact active Stage2.6 package without changing
// any reviewed declaration, quota, retention policy or provider authority.
const baselinePath=process.argv[2],out=resolve(process.argv[3]||'package-stage2.7');
assert.ok(baselinePath,'Exact active Stage2.6 package is required');
const baseline=JSON.parse(readFileSync(baselinePath,'utf8'));
assert.equal(createHash('sha256').update(readFileSync(baselinePath)).digest('hex'),'405ee2fbf705b91122ce161ad7ea5adbd764136cca5f40257a38a4e8e6ccd0b7');
assert.equal(baseline.manifest.id,'io.deft.email');
assert.equal(baseline.manifest.version,'1.6.0-stage2.6');
assert.equal(baseline.artifacts.length,1);
mkdirSync(out,{recursive:true});
const bundle=await build({entryPoints:[fileURLToPath(new URL('./worker.mjs',import.meta.url))],outfile:resolve(out,'worker.bundle.js'),bundle:true,minify:true,format:'iife',platform:'browser',target:'es2022',metafile:true});
assert.ok(!Object.keys(bundle.metafile.inputs).some(path=>path.endsWith('/dist/index.js')||path.includes('/node_modules/zod/')));
const worker=readFileSync(resolve(out,'worker.bundle.js'));
const before=JSON.parse(baseline.artifacts[0].content);
const artifact=await prepareDeftExperienceArtifact(baseline.artifacts[0].path,{...before,worker_source:worker.toString()});
const manifest=structuredClone(baseline.manifest);
manifest.version='1.6.0-stage2.7';manifest.experiences[0].artifact_digest=artifact.digest;
const compare=structuredClone(manifest);
compare.version=baseline.manifest.version;
compare.experiences[0].artifact_digest=baseline.manifest.experiences[0].artifact_digest;
assert.deepEqual(compare,baseline.manifest);
const pkg=await buildDeftAppPackage({manifest,artifacts:[artifact]});
writeFileSync(resolve(out,'app.deft.json'),pkg.json);
writeFileSync(resolve(out,'artifact.json'),JSON.stringify(artifact));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const inputs=Object.keys(bundle.metafile.inputs).sort().map(path=>({path:resolve(path),sha256:sha(readFileSync(resolve(path)))}));
writeFileSync(resolve(out,'input-hashes.json'),JSON.stringify(inputs,null,2));
const proof={version:manifest.version,package_digest:pkg.digest,artifact_digest:artifact.digest,worker_sha256:sha(worker),baseline_sha256:sha(readFileSync(baselinePath)),normalBundler:true,permission_changes:[],declarations_identical:true,staged:false,activated:false};
writeFileSync(resolve(out,'build-proof.json'),JSON.stringify(proof,null,2));
console.log(JSON.stringify(proof));
