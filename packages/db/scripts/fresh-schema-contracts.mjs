import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {readCatalog,readLedger} from './lineage-catalog.mjs';

// Schema117: original117 helper definitions plus unchanged fresh-only contracts.
// AFTER is the already reviewed fresh current117 catalog in supported-histories.
const BEFORE='2fcf0818208ea66e02e9b52e5ea29da1fa6b06c127dd86e6c17866b3466ac542';
const AFTER='5d5a042edb86ab8ee628b7f10e82b0b7fe3f2d79c1bb96284c9f33f0490b902d';
const SQL_SHA256='ed4f1ef2c1850d0dcd8b33a759a115e89130baa045b5c9f7fe4d25f97ddb535d';

// Internal fresh initializer only, inside its initial ledger transaction and lock.
// Existing ledgered targets can never enter this reconciliation path.
export async function reconcileFreshSchemaContracts(client){
 if((await readLedger(client)).length)throw new Error('E5_FRESH_LEDGER_NOT_EMPTY');
 const before=await readCatalog(client);
 if(before.digest!==BEFORE)throw new Error('E5_FRESH_PRESTAMP_CATALOG_UNRECOGNIZED');
 for(const relation of before.catalog.relations){
  if(!['r','p'].includes(relation.relkind))continue;
  const name='public."'+relation.relname.replaceAll('"','""')+'"';
  if((await client.query('SELECT EXISTS (SELECT 1 FROM '+name+' LIMIT 1) AS present')).rows[0].present)throw new Error('E5_FRESH_TABLE_NOT_EMPTY');
 }
 const raw=readFileSync(fileURLToPath(new URL('./fresh-schema-contracts.sql',import.meta.url)));
 if(createHash('sha256').update(raw).digest('hex')!==SQL_SHA256)throw new Error('E5_FRESH_CONTRACT_ARTIFACT_MISMATCH');
 await client.query(raw.toString('utf8'));
 const after=await readCatalog(client);
 if(after.digest!==AFTER||(await readLedger(client)).length)throw new Error('E5_FRESH_FINAL_CONTRACT_UNRECOGNIZED');
}
