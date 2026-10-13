import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';import {runInNewContext} from 'node:vm';
const moduleUrl=new URL('./fresh-schema-contracts.mjs',import.meta.url),source=readFileSync(moduleUrl,'utf8');
// Dependency seam only: execute the real service; independently captured117
// catalog identities come from the disposable fresh init/transaction proof.
const before='2fcf0818208ea66e02e9b52e5ea29da1fa6b06c127dd86e6c17866b3466ac542',after='5d5a042edb86ab8ee628b7f10e82b0b7fe3f2d79c1bb96284c9f33f0490b902d';
function fixture({ledger=false,rows=false,drift=false,finalDrift=false}={}){
 let catalogReads=0,sqlWrites=0;
 const service=runInNewContext(source.replace(/^import .*;$/gmu,'').replace(/import\.meta\.url/gu,'moduleUrl').replace('export async function','async function')+'\nreconcileFreshSchemaContracts',{
  createHash,readFileSync,fileURLToPath,URL,moduleUrl:moduleUrl.href,
  readLedger:async()=>ledger?[{version:'existing'}]:[],
  readCatalog:async()=>({digest:++catalogReads===1?(drift?'f'.repeat(64):before):(finalDrift?'f'.repeat(64):after),catalog:{relations:[{relkind:'r',relname:'records'}]}}),
 });
 const client={query:async sql=>{if(sql.startsWith('SELECT EXISTS'))return {rows:[{present:rows}]};sqlWrites++;return {rows:[]};}};
 return {service,client,get writes(){return sqlWrites;}};
}
test('fresh contracts reject existing ledger, stored rows and unknown catalog before any contract write',async()=>{for(const [input,code]of [[{ledger:true},'E5_FRESH_LEDGER_NOT_EMPTY'],[{rows:true},'E5_FRESH_TABLE_NOT_EMPTY'],[{drift:true},'E5_FRESH_PRESTAMP_CATALOG_UNRECOGNIZED']]){const f=fixture(input);await assert.rejects(f.service(f.client),error=>error.message===code);assert.equal(f.writes,0);}});
test('fresh contracts require current reviewed final catalog and cannot accept final drift',async()=>{const f=fixture();await f.service(f.client);assert.equal(f.writes,1);const bad=fixture({finalDrift:true});await assert.rejects(bad.service(bad.client),error=>error.message==='E5_FRESH_FINAL_CONTRACT_UNRECOGNIZED');});
