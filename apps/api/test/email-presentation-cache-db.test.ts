import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {and,eq} from 'drizzle-orm';
import {emailAccounts,emailPresentationCache} from '@deft/db/schema';
import {EmailMailboxCrypto} from '../src/lib/email-mailbox-crypto.js';
import {PostgresEmailPresentationCache} from '../src/lib/email-presentation-cache.js';
import type {NativeEmailPresentation} from '../src/lib/email-native-adapter-contract.js';
import type {EmailScope} from '../src/lib/email-mailbox-service.js';

const target='postgresql://gate_g_test@127.0.0.1:55435/email_stage34_cache_81';
const safe=process.env.DATABASE_URL===target&&process.env.DEFT_TEST_DATABASE_URL===target;
test('PostgreSQL reader cache is encrypted, scoped, bounded under concurrency and expires',{skip:!safe,timeout:30000},async t=>{
 const pool=new pg.Pool({connectionString:target,max:8}),db=drizzle(pool,{schema:{emailAccounts,emailPresentationCache}});
 const verified=await pool.query('select current_database() as db, current_user as role, inet_server_port() as port');
 assert.deepEqual(verified.rows[0],{db:'email_stage34_cache_81',role:'gate_g_test',port:55435});
 const identity=(await pool.query('select org_id,owner_user_id,resource_binding_id from email_accounts limit 1')).rows[0];
 assert.ok(identity,'Dedicated baseline contains synthetic owner binding');
 const scope:EmailScope={org_id:identity.org_id,owner_user_id:identity.owner_user_id,account_id:'cache-'+randomUUID()},other={...scope,account_id:'cache-'+randomUUID()};
 let now=Date.parse('2026-10-04T00:00:00Z'),allowed=true;
 const keys={current:()=>({key_id:'cache-test-key',key:Buffer.alloc(32,27)}),read:(_purpose:unknown,key:string)=>key==='cache-test-key'?{key_id:key,key:Buffer.alloc(32,27)}:null,keyIds:()=>['cache-test-key']};
 const cipher=new EmailMailboxCrypto(keys);
 const guard=async(s:EmailScope,tx:unknown)=>{if(!allowed)throw Error('fixture access revoked');const [row]=await (tx as typeof db).select().from(emailAccounts)
  .where(and(eq(emailAccounts.org_id,s.org_id),eq(emailAccounts.owner_user_id,s.owner_user_id),eq(emailAccounts.account_id,s.account_id))).limit(1).for('share');if(!row)throw Error('fixture scope denied');};
 const cache=new PostgresEmailPresentationCache(db,cipher,guard,()=>now,3);
 const key=(n:number)=>createHash('sha256').update(String(n)).digest('hex');
 const value:NativeEmailPresentation={schema_version:'deft.email_presentation.v1',account_id:scope.account_id,provider:'gmail',logical_message_id:'mail_'+'a'.repeat(64),source_digest:'b'.repeat(64),content_trust:'unsanitized',files:[],
  presentation:{format:'html',content:'<p>Synthetic private cached body</p>',plain_text:'Synthetic private cached body',truncated:false,images:[],headers:[],metadata:{account_id:scope.account_id,
   primary_address:'cache@example.test',verified_sender_identities:'["cache@example.test"]',reply_from:'sender@example.test',reply_to:'sender@example.test',reply_to_list:'cache@example.test',reply_cc:'',subject:'Cached fixture',message_id:'<cache@example.test>',references:'',conversation_id:'cached-thread',
   conversation_coverage_state:'unknown',conversation_indexed_count:'0',conversation_exact_count:'',conversation_observed_at:'',conversation_drained:'false',mailbox_reset_required:'false'}}};
 await db.insert(emailAccounts).values([scope,other].map(s=>({...s,provider:'gmail' as const,resource_binding_id:identity.resource_binding_id,principal_digest:'a'.repeat(64),state:'active' as const,authority_revision:1,consented_at:new Date(now)})));
 t.after(async()=>{for(const s of [scope,other]){await pool.query('delete from email_presentation_cache where org_id=$1 and owner_user_id=$2 and account_id=$3',Object.values(s));await pool.query('delete from email_accounts where org_id=$1 and owner_user_id=$2 and account_id=$3',Object.values(s));}await pool.end();});
 await cache.write(scope,key(1),value);assert.deepEqual(await cache.read(scope,key(1)),value);assert.equal(await cache.read(other,key(1)),null);
 const raw=(await pool.query('select content_envelope from email_presentation_cache where account_id=$1',[scope.account_id])).rows[0].content_envelope;
 assert.equal(JSON.stringify(raw).includes('Synthetic private cached body'),false);
 assert.throws(()=>cipher.open(raw,{...other,kind:'presentation_cache',record_id:key(1),revision:1}));
 await Promise.all(Array.from({length:12},(_,n)=>cache.write(scope,key(n+2),value)));
 const count=(await pool.query('select count(*)::int n from email_presentation_cache where account_id=$1',[scope.account_id])).rows[0].n;assert.equal(count,3);
 now+=1;await cache.write(scope,key(99),value);assert.deepEqual(await cache.read(scope,key(99)),value);
 now+=300001;assert.equal(await cache.read(scope,key(99)),null);await cache.write(scope,key(100),value);
 assert.equal((await pool.query('select count(*)::int n from email_presentation_cache where account_id=$1',[scope.account_id])).rows[0].n,1);
 const retained=(await pool.query('select cache_key from email_presentation_cache where account_id=$1',[scope.account_id])).rows[0].cache_key;
 assert.equal(retained,key(100));
 await cache.write(scope,key(101),{...value,presentation:{...value.presentation,content:'x'.repeat(250000),plain_text:'x'.repeat(250000)}});
 assert.equal(await cache.read(scope,key(101)),null,'Large valid presentations bypass the cache without truncation');
 allowed=false;await assert.rejects(cache.read(scope,key(100)),/revoked/);
});
