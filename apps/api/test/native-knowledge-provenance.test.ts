import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { PgDialect } from 'drizzle-orm/pg-core';
import { appCaptureAssociation } from '../src/lib/app-integration-capture-provenance.js';
import { appSourceKnowledgeProvenanceCondition } from '../src/lib/native-knowledge-provenance.js';

const uuid = (n:number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const url=process.env.DEFT_TEST_DATABASE_URL;
const safe=!!url&&url===process.env.DATABASE_URL&&/^postgres(?:ql)?:\/\/(?:[^@]+@)?(?:127\.0\.0\.1|localhost):\d+\/[^?]*test(?:\?.*)?$/u.test(url);
test('retained Knowledge provenance preserves exact v1/v2 audiences and rejects unknown mappings in PostgreSQL',{skip:!safe},async()=>{
 const client=new pg.Client({connectionString:url});await client.connect();
 try{
  await client.query(`BEGIN;
   CREATE TEMP TABLE wiki_pages(id text,org_id text,user_id text,scope text,space_id text,version integer);
   CREATE TEMP TABLE wiki_citations(org_id text,page_id text,source_type text,source_id text);
   CREATE TEMP TABLE app_integration_capture_sources(id text,page_id text,org_id text,owner_user_id text,
     installation_id text,account_ref text,store_key text,thread_key text,body_digest text,publication jsonb);
   CREATE TEMP TABLE app_integration_capture_threads(page_id text,org_id text,owner_user_id text,
     installation_id text,account_ref text,store_key text,thread_key text,destination_key text,page_version integer);
   CREATE TEMP TABLE app_integration_destination_receipts(org_id text,owner_user_id text,destination jsonb,result jsonb);
   INSERT INTO wiki_pages VALUES ('ordinary','org','owner','user',null,1),('v1','org','owner','user',null,2),
     ('transfer','org','owner','space','space',1),('unknown','org','owner','user',null,1);
   INSERT INTO app_integration_capture_sources VALUES ('s1','v1','org','owner','install','account','store','thread','digest','{}'),
     ('unknown','unknown','org','owner','install','account','store','thread','digest','{}');
   INSERT INTO app_integration_capture_threads VALUES ('v1','org','owner','install','account','store','thread','user',1);
   INSERT INTO app_integration_destination_receipts VALUES ('org','owner','{"kind":"knowledge","space_id":"space"}',
     '{"destination_kind":"knowledge","destination_id":"transfer"}');`);
  const query=new PgDialect().sqlToQuery(appSourceKnowledgeProvenanceCondition());
  const mapped=async()=> (await client.query('SELECT id FROM wiki_pages WHERE '+query.sql+' ORDER BY id',query.params)).rows.map(row=>row.id);
  assert.deepEqual(await mapped(),['transfer','v1']);
  for(const column of ['org_id','owner_user_id','installation_id','account_ref','store_key','thread_key','page_id','destination_key']){
   await client.query('SAVEPOINT mismatch');
   await client.query(`UPDATE app_integration_capture_threads SET ${column}='foreign'`);
   assert.deepEqual(await mapped(),['transfer'],column+' is part of the exact mapping');
   await client.query('ROLLBACK TO SAVEPOINT mismatch');
  }
  await client.query("UPDATE wiki_pages SET scope='space',space_id='space' WHERE id='v1'");
  assert.deepEqual(await mapped(),['transfer'],'a private copy cannot be widened by editing its page ACL');
  await client.query("UPDATE wiki_pages SET scope='user',space_id=null WHERE id='v1'");
  await client.query("UPDATE wiki_pages SET space_id='other' WHERE id='transfer'");
  assert.deepEqual(await mapped(),['v1'],'a transfer is bound to the original destination receipt');
  await client.query("UPDATE wiki_pages SET space_id='space' WHERE id='transfer'");
  const association=appCaptureAssociation({page_id:uuid(1),page_version:1,owner_user_id:uuid(2),
   destination:{scope:'user',space_id:null},body_digest:'sha256:'+'a'.repeat(64),captured_at:'2026-10-20T12:00:00Z'});
  await client.query('INSERT INTO wiki_pages VALUES ($1,$2,$3,$4,null,3)',[uuid(1),'org',uuid(2),'user']);
  await client.query('INSERT INTO app_integration_capture_sources VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
   ['s2',uuid(1),'org',uuid(2),'install','account','store','thread',association.body_digest,JSON.stringify({association})]);
  const expected=[uuid(1),'transfer','v1'];assert.deepEqual(await mapped(),expected);
  await client.query("INSERT INTO wiki_citations VALUES ('org','transfer','app_integration','s2')");
  assert.deepEqual(await mapped(),[uuid(1),'v1'],'a source association cannot be cited as consent for another destination');
  await client.query("DELETE FROM wiki_citations");
  await client.query("INSERT INTO wiki_citations VALUES ('org','v1','app_integration','s1')");
  assert.deepEqual(await mapped(),expected,'a citation identifies this exact association');
  await client.query("UPDATE wiki_citations SET org_id='foreign'");
  assert.deepEqual(await mapped(),[uuid(1),'transfer'],'foreign citation authority fails closed');
  await client.query("DELETE FROM wiki_citations");
  const publication=async(value:unknown)=>client.query('UPDATE app_integration_capture_sources SET publication=$1 WHERE id=$2',[JSON.stringify({association:value}),'s2']);
  for(const bad of [{...association,schema_version:'unknown'},null,{...association,page_id:uuid(5)},
    {...association,body_digest:'sha256:'+'b'.repeat(64)}, {...association,page_version:4},
    {...association,page_version:'1'}, {...association,page_version:1e30},
    {...association,captured_at:undefined}, {...association,captured_at:'unknown'},
    {...association,audience:{scope:'space',space_id:'space',user_id:null}},
    {...association,audience:{...association.audience,user_id:uuid(3)}}]){
   await publication(bad);assert.deepEqual(await mapped(),['transfer','v1']);
  }
  await publication(association);
  await client.query('INSERT INTO app_integration_capture_sources SELECT $1,page_id,org_id,owner_user_id,installation_id,account_ref,store_key,thread_key,body_digest,$2 FROM app_integration_capture_sources WHERE id=$3',
   ['conflicting',JSON.stringify({association:{...association,audience:{scope:'space',space_id:'space',user_id:null}}}),'s2']);
  assert.deepEqual(await mapped(),['transfer','v1'],'one valid association does not override conflicting consent');
  await client.query("DELETE FROM app_integration_capture_sources WHERE id='conflicting'");
  assert.deepEqual(await mapped(),expected);
  const shared=appCaptureAssociation({page_id:uuid(10),page_version:1,owner_user_id:uuid(2),
   destination:{scope:'space',space_id:uuid(11)},body_digest:association.body_digest,captured_at:association.captured_at});
  await client.query('INSERT INTO wiki_pages VALUES ($1,$2,$3,$4,$5,1)',[uuid(10),'org',uuid(2),'space',uuid(11)]);
  await client.query('INSERT INTO app_integration_capture_sources VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
   ['shared',uuid(10),'org',uuid(2),'install','account','store','thread',shared.body_digest,JSON.stringify({association:shared})]);
  assert.deepEqual(await mapped(),[uuid(1),uuid(10),'transfer','v1']);
  await client.query('UPDATE wiki_pages SET space_id=$1 WHERE id=$2',[uuid(12),uuid(10)]);
  assert.deepEqual(await mapped(),expected,'a shared association is limited to its original space');
 }finally{await client.query('ROLLBACK');await client.end();}
});
