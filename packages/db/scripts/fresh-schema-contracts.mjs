import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {readCatalog,readLedger} from './lineage-catalog.mjs';

// Schema117: original117 helper definitions plus unchanged fresh-only contracts.
// AFTER is the already reviewed fresh current117 catalog in supported-histories.
const BEFORE='2fcf0818208ea66e02e9b52e5ea29da1fa6b06c127dd86e6c17866b3466ac542';
const AFTER='5d5a042edb86ab8ee628b7f10e82b0b7fe3f2d79c1bb96284c9f33f0490b902d';
// Explicit120 model columns change only the reviewed empty bootstrap identity.
// The same immutable contracts execute;120 authority still requires forward SQL.
const BEFORE120='4946198320d9bf5012f22c5c5c62d8a598bc61cd2c303d8b793c8307777ace80';
const AFTER120='5894adc2af92b36cd62db66c2233873067c79921cb460d911c5f6ba4b59a980e';
// Explicit132 capture-retirement columns plus the server-stored restore-review
// table change the reviewed empty bootstrap identity again. The same immutable
// contracts execute;132/133/134 authority still requires forward SQL.
const BEFORE132='90ba534e3e125fc19f2f000be62eb1a6ca278d71a88c982f67664f56cb9c4933';
const AFTER132='966778170fd4b0f686443c9f150a7ce14711b197c75ebc01bf0c51f463a6ff28';
const SQL_SHA256='ed4f1ef2c1850d0dcd8b33a759a115e89130baa045b5c9f7fe4d25f97ddb535d';

// Internal fresh initializer only, inside its initial ledger transaction and lock.
// Existing ledgered targets can never enter this reconciliation path.
export async function reconcileFreshSchemaContracts(client){
 if((await readLedger(client)).length)throw new Error('E5_FRESH_LEDGER_NOT_EMPTY');
 const before=await readCatalog(client);
 const expectedAfter=before.digest===BEFORE?AFTER:before.digest===BEFORE120?AFTER120:before.digest===BEFORE132?AFTER132:null;
 if(expectedAfter===null)throw new Error('E5_FRESH_PRESTAMP_CATALOG_UNRECOGNIZED');
 for(const relation of before.catalog.relations){
  if(!['r','p'].includes(relation.relkind))continue;
  const name='public."'+relation.relname.replaceAll('"','""')+'"';
  if((await client.query('SELECT EXISTS (SELECT 1 FROM '+name+' LIMIT 1) AS present')).rows[0].present)throw new Error('E5_FRESH_TABLE_NOT_EMPTY');
 }
 const raw=readFileSync(fileURLToPath(new URL('./fresh-schema-contracts.sql',import.meta.url)));
 if(createHash('sha256').update(raw).digest('hex')!==SQL_SHA256)throw new Error('E5_FRESH_CONTRACT_ARTIFACT_MISMATCH');
 await client.query(raw.toString('utf8'));
 const after=await readCatalog(client);
 if(after.digest!==expectedAfter||(await readLedger(client)).length)throw new Error('E5_FRESH_FINAL_CONTRACT_UNRECOGNIZED');
}
