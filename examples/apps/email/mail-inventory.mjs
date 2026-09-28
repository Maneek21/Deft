import {DatabaseSync} from 'node:sqlite';
import {existsSync,openSync,closeSync,statSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';

export const INVENTORY_LIMITS=Object.freeze({rows:100000,bytes:33554432,namespaces:16,pending_bytes:65536});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=code=>{throw Error(code);};
const metadataRow=row=>typeof row?.folder==='string'&&['inbox','sent','archive'].includes(row.folder)&&/^\d{1,30}$/.test(row.validity)&&Number.isSafeInteger(row.uid)&&row.uid>0&&row.uid<=4294967295&&/^[a-f0-9]{64}$/.test(row.digest)&&/^[a-f0-9]{64}$/.test(row.revision);

// Node >=22.13 DatabaseSync API subset. This remains an active-development
// Node API. No bodies, addresses, credentials or provider result capsules live here.
export class MailInventory {
 constructor(path,scope){
  if(typeof scope!=='string'||!scope||scope.length>256)fail('EMAIL_INVENTORY_SCOPE_INVALID');
  this.path=path;this.scope=digest(scope);this.checkFootprint();
  if(!existsSync(path)){const fd=openSync(path,'wx',0o600);closeSync(fd);}
  this.db=new DatabaseSync(path);
  try{
   // DELETE avoids an unbounded WAL. 4000 pages of main DB plus a full rollback
   // journal (page headers included) and the bounded prepared record fit32MiB.
   this.db.exec('PRAGMA busy_timeout=250;PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA page_size=4096;PRAGMA max_page_count=4000;PRAGMA cache_size=-1024;PRAGMA temp_store=MEMORY;CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;CREATE TABLE IF NOT EXISTS namespaces(id TEXT PRIMARY KEY,paths TEXT NOT NULL) WITHOUT ROWID;CREATE TABLE IF NOT EXISTS items(namespace TEXT NOT NULL,folder TEXT NOT NULL,validity TEXT NOT NULL,uid INTEGER NOT NULL,digest TEXT NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(namespace,folder,validity,uid)) WITHOUT ROWID;CREATE TABLE IF NOT EXISTS pending(slot INTEGER PRIMARY KEY CHECK(slot=1),payload TEXT NOT NULL);');
   if(this.db.prepare('PRAGMA page_size').get().page_size!==4096||this.db.prepare('PRAGMA max_page_count').get().max_page_count>4000||this.db.prepare('PRAGMA journal_mode').get().journal_mode!=='delete')fail('EMAIL_INVENTORY_STORAGE_SHAPE_INVALID');
   const prior=this.db.prepare("SELECT value FROM meta WHERE key='scope'").get();
   if(prior&&prior.value!==this.scope)fail('EMAIL_INVENTORY_SCOPE_CHANGED');
   if(!prior)this.transaction(()=>{this.db.prepare("INSERT INTO meta VALUES ('scope',?)").run(this.scope);this.db.prepare("INSERT INTO meta VALUES ('rows','0')").run();});
  }catch(error){this.db.close();throw error;}
 }
 checkFootprint(){const bytes=[this.path,this.path+'-journal',this.path+'-wal',this.path+'-shm'].reduce((sum,path)=>sum+(existsSync(path)?statSync(path).size:0),0);if(bytes>INVENTORY_LIMITS.bytes)fail('EMAIL_INVENTORY_STORAGE_LIMIT');return bytes;}
 close(){this.db.close();}
 transaction(fn){this.checkFootprint();this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');this.checkFootprint();return result;}catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}}
 pending(){const row=this.db.prepare('SELECT payload FROM pending WHERE slot=1').get();return row?JSON.parse(row.payload):null;}
 begin(inputCursor){
  const pending=this.pending();
  // A later authenticated host starting cursor is evidence that the exact
  // prepared page committed even when its result acknowledgement was lost.
  if(pending){if(digest(inputCursor)!==digest(pending.next_cursor))fail('EMAIL_SYNC_ACK_UNKNOWN_MANUAL_RECOVERY');this.acknowledge(pending.page_id);}
  if(inputCursor===null){if(this.db.prepare('SELECT count(*) AS n FROM namespaces').get().n>=INVENTORY_LIMITS.namespaces)fail('EMAIL_INVENTORY_NAMESPACE_LIMIT');return {id:randomUUID(),paths:{}};}
  let value;try{value=JSON.parse(inputCursor);}catch{fail('EMAIL_SYNC_CURSOR_INVALID');}
  if(value.v!==2||typeof value.namespace!=='string')fail('EMAIL_INVENTORY_NEW_BASELINE_REQUIRED');
  const row=this.db.prepare('SELECT paths FROM namespaces WHERE id=?').get(value.namespace);if(!row)fail('EMAIL_INVENTORY_NAMESPACE_UNKNOWN');return {id:value.namespace,paths:JSON.parse(row.paths)};
 }
 range(namespace,folder,validity,start,end){if(end-start>=64)fail('EMAIL_INVENTORY_RANGE_LIMIT');return this.db.prepare('SELECT uid,digest,revision FROM items WHERE namespace=? AND folder=? AND validity=? AND uid BETWEEN ? AND ? ORDER BY uid LIMIT 64').all(namespace,folder,validity,start,end);}
 highwater(namespace,folder,validity){return this.db.prepare('SELECT uid FROM items WHERE namespace=? AND folder=? AND validity=? ORDER BY uid DESC LIMIT 1').get(namespace,folder,validity)?.uid??0;}
 oldEpoch(namespace,folder,validity,limit){const n=Math.min(limit,100),lower=this.db.prepare('SELECT folder,validity,uid,digest,revision FROM items WHERE namespace=? AND folder=? AND validity<? ORDER BY validity,uid LIMIT ?').all(namespace,folder,validity,n);return [...lower,...this.db.prepare('SELECT folder,validity,uid,digest,revision FROM items WHERE namespace=? AND folder=? AND validity>? ORDER BY validity,uid LIMIT ?').all(namespace,folder,validity,n-lower.length)];}
 rowCount(){const n=Number(this.db.prepare("SELECT value FROM meta WHERE key='rows'").get()?.value);if(!Number.isSafeInteger(n)||n<0||n>INVENTORY_LIMITS.rows)fail('EMAIL_INVENTORY_ROW_COUNT_INVALID');return n;}
 prepare({namespace,paths,input_cursor,next_cursor,upserts=[],removed=[]}){
  if(this.pending())fail('EMAIL_SYNC_ACK_UNKNOWN_MANUAL_RECOVERY');
  if(typeof namespace!=='string'||!/^[a-f0-9-]{36}$/.test(namespace)||!paths||Array.isArray(paths)||Object.entries(paths).some(([key,value])=>!['inbox','sent','archive'].includes(key)||typeof value!=='string'||value.length<1||value.length>128||/[\r\n\0]/.test(value))||typeof next_cursor!=='string'||Buffer.byteLength(next_cursor)>2048)fail('EMAIL_INVENTORY_PAGE_INVALID');
  const keys=[...upserts,...removed].map(row=>`${row.folder}:${row.validity}:${row.uid}`);
  if(upserts.length+removed.length>100||upserts.some(row=>!metadataRow(row))||removed.some(row=>!metadataRow(row))||new Set(keys).size!==keys.length)fail('EMAIL_INVENTORY_PAGE_INVALID');
  const payload={page_id:randomUUID(),namespace,paths,input_cursor_hash:digest(input_cursor),next_cursor,upserts,removed};
  const bytes=JSON.stringify(payload);if(Buffer.byteLength(bytes)>INVENTORY_LIMITS.pending_bytes)fail('EMAIL_INVENTORY_PAGE_LIMIT');
  this.transaction(()=>{const n=this.rowCount(),exists=this.db.prepare('SELECT 1 AS present FROM items WHERE namespace=? AND folder=? AND validity=? AND uid=?'),added=upserts.filter(row=>!exists.get(namespace,row.folder,row.validity,row.uid)).length,deleted=removed.filter(row=>exists.get(namespace,row.folder,row.validity,row.uid)).length;if(n+added-deleted>INVENTORY_LIMITS.rows)fail('EMAIL_INVENTORY_ROW_LIMIT');this.db.prepare('INSERT INTO pending VALUES(1,?)').run(bytes);});return payload.page_id;
 }
 acknowledge(pageId){
  const pending=this.pending();if(!pending||pending.page_id!==pageId)fail('EMAIL_INVENTORY_ACK_MISMATCH');
  this.transaction(()=>{
   this.db.prepare('INSERT INTO namespaces VALUES (?,?) ON CONFLICT(id) DO UPDATE SET paths=excluded.paths').run(pending.namespace,JSON.stringify(pending.paths));
   let n=this.rowCount();const exists=this.db.prepare('SELECT 1 AS present FROM items WHERE namespace=? AND folder=? AND validity=? AND uid=?');
   const remove=this.db.prepare('DELETE FROM items WHERE namespace=? AND folder=? AND validity=? AND uid=?');for(const row of pending.removed)n-=Number(remove.run(pending.namespace,row.folder,row.validity,row.uid).changes);
   const put=this.db.prepare('INSERT INTO items VALUES(?,?,?,?,?,?) ON CONFLICT(namespace,folder,validity,uid) DO UPDATE SET digest=excluded.digest,revision=excluded.revision');for(const row of pending.upserts){if(!exists.get(pending.namespace,row.folder,row.validity,row.uid))n++;put.run(pending.namespace,row.folder,row.validity,row.uid,row.digest,row.revision);}
   if(n>INVENTORY_LIMITS.rows)fail('EMAIL_INVENTORY_ROW_LIMIT');this.db.prepare("UPDATE meta SET value=? WHERE key='rows'").run(String(n));this.db.exec('DELETE FROM pending');
  });
 }
}
