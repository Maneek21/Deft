/** Print candidate v2 pins; this does not review or modify the manifest. */
import {readFileSync} from 'node:fs';
import {findingFingerprint} from './codeql-reviewed-findings.mjs';

if(!process.argv[2])throw Error('Usage: node scripts/codeql-reviewed-findings-fingerprint.mjs <file.sarif> [repository-root]');
const sarif=JSON.parse(readFileSync(process.argv[2],'utf8'));
if(sarif.version!=='2.1.0'||!Array.isArray(sarif.runs)||sarif.runs.length===0)throw Error('INVALID_SARIF');
const findings=sarif.runs.flatMap(run=>{
 if(run.tool?.driver?.name!=='CodeQL'||!Array.isArray(run.results))throw Error('CODEQL_RESULTS_REQUIRED');
 return run.results.map(result=>({rule:result.ruleId,path:result.locations?.[0]?.physicalLocation?.artifactLocation?.uri,line:result.locations?.[0]?.physicalLocation?.region?.startLine,fingerprint_v2:findingFingerprint(result,process.argv[3]??process.cwd())}));
});
console.log(JSON.stringify(findings,null,2));
