import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
const target=process.env.DEFT_TEST_DATABASE_URL;
const safe=(()=>{if(!target||target!==process.env.DATABASE_URL)return false;try{const u=new URL(target);return u.username==='gate_g_test'&&!u.password&&u.hostname==='127.0.0.1'&&u.port==='55435'&&/^\/gate_g_20260927_c19_attachment_test(?:_v[0-9]+)?$/u.test(u.pathname)&&!u.search&&!u.hash;}catch{return false;}})();
async function client(){assert.ok(safe);const c=new pg.Client({connectionString:target,statement_timeout:2000,query_timeout:3000});await c.connect();return c;}
test('installed .50 grant functions deny scope, reviewer, unsupported and null authority in isolated corruption probes',
 {skip:!safe},async()=>{
  const c=await client();try{
    const {rows:[original]}=await c.query(`SELECT g.* FROM app_grant_snapshots g JOIN app_versions v ON v.org_id=g.org_id AND v.id=g.app_version_id
      WHERE v.protocol_version='7' AND g.snapshot_kind='effective' ORDER BY g.created_at DESC LIMIT 1`);assert.ok(original,'Normal reviewed HTTP7 activation must exist first');
    await c.query('BEGIN');await c.query('SET LOCAL search_path=pg_temp,public');
    // These temporary copies intentionally omit immutability controls so the
    // installed shape/lineage functions can be tested against corrupt persisted
    // declarations. They confer no live authority and are rolled back entirely.
    for(const [table,filter,args] of [
      ['app_versions','org_id=$1 AND id=$2',[original.org_id,original.app_version_id]],
      ['app_installations','org_id=$1 AND id=$2',[original.org_id,original.app_installation_id]],
      ['app_grant_snapshots','org_id=$1 AND app_installation_id=$2',[original.org_id,original.app_installation_id]],
      ['org_members','org_id=$1',[original.org_id]],
    ] as const)await c.query(`CREATE TEMP TABLE ${table} AS SELECT * FROM public.${table} WHERE ${filter}`,args as unknown[]);
    await c.query(`CREATE TRIGGER probe_lineage BEFORE INSERT ON pg_temp.app_grant_snapshots FOR EACH ROW EXECUTE FUNCTION public.enforce_app_grant_snapshot_lineage()`);
    await c.query(`CREATE TRIGGER probe_shape BEFORE INSERT ON pg_temp.app_grant_snapshots FOR EACH ROW EXECUTE FUNCTION public.enforce_app_v7_effective_grant_shape()`);
    const {rows:[version]}=await c.query('SELECT manifest FROM pg_temp.app_versions');
    async function insert(row:Record<string,unknown>){return c.query('INSERT INTO pg_temp.app_grant_snapshots SELECT * FROM jsonb_populate_record(NULL::pg_temp.app_grant_snapshots,$1::jsonb)',[JSON.stringify(row)]);}
    await c.query('SAVEPOINT baseline');await insert({...original,id:randomUUID()});await c.query('ROLLBACK TO SAVEPOINT baseline');
    let denied=0;
    async function deny(label:string,row:Record<string,unknown>,manifest=version.manifest){
      await c.query('UPDATE pg_temp.app_versions SET manifest=$1::jsonb',[JSON.stringify(manifest)]);await c.query('SAVEPOINT negative');
      await assert.rejects(insert({...row,id:randomUUID()}),(error:any)=>error.code==='23514',label);
      await c.query('ROLLBACK TO SAVEPOINT negative');denied++;
    }
    const canonical=original.canonical_snapshot;
    for(const field of ['runtime_actions','native_actions','public_actions','experiences'] as const){
      for(const value of [null,[{unexpected:true}]])await deny(`snapshot ${field}`,{...original,canonical_snapshot:{...canonical,[field]:value}});
      const missing={...canonical};delete missing[field];await deny(`missing snapshot ${field}`,{...original,canonical_snapshot:missing});
    }
    for(const field of ['runtime_actions','native_actions','public_actions','experiences','private_capabilities'] as const){
      const missing={...version.manifest};delete missing[field];await deny(`missing persisted ${field}`,original,missing);
      await deny(`null persisted ${field}`,original,{...version.manifest,[field]:null});
    }
    for(const field of ['organization_id','app_installation_id','app_version_id','requested_snapshot_id'])await deny(`canonical ${field}`,{...original,canonical_snapshot:{...canonical,[field]:randomUUID()}});
    await deny('foreign requested ancestry',{...original,requested_snapshot_id:randomUUID()});
    const {rows:[operator]}=await c.query("SELECT user_id FROM pg_temp.org_members WHERE role='member' LIMIT 1");assert.ok(operator);
    await deny('nonmanager reviewer',{...original,reviewed_by_actor_id:operator.user_id});
    await deny('unknown host authority',{...original,canonical_snapshot:{...canonical,authority_token:'not-authority'}});
    assert.equal(denied,29);await c.query('ROLLBACK');
  }finally{await c.query('ROLLBACK').catch(()=>{});await c.end();}
});
test('protocol7 live pointer cannot become bare and active checkpoint accounting excludes purged history by index',
 {skip:!safe},async()=>{
  const c=await client();try{
    const {rows:[active]}=await c.query(`SELECT i.* FROM app_installations i JOIN app_versions v ON v.org_id=i.org_id AND v.id=i.active_version_id
      WHERE v.protocol_version='7' AND i.state='active' LIMIT 1`);assert.ok(active);
    await c.query('BEGIN');
    await assert.rejects((async()=>{await c.query('UPDATE app_installations SET active_grant_snapshot_id=NULL,active_grant_snapshot_kind=NULL WHERE org_id=$1 AND id=$2',[active.org_id,active.id]);await c.query('SET CONSTRAINTS ALL IMMEDIATE');})(),(e:any)=>e.code==='23514');
    await c.query('ROLLBACK');
    assert.equal((await c.query('SELECT active_grant_snapshot_id FROM app_installations WHERE org_id=$1 AND id=$2',[active.org_id,active.id])).rows[0].active_grant_snapshot_id,active.active_grant_snapshot_id);
    assert.equal((await c.query("SELECT count(*)::integer AS n FROM deft_schema_migrations WHERE version='0.3.0-preview.50'")).rows[0].n,1);
    const {rows:[binding]}=await c.query('SELECT org_id,resource_binding_id,id FROM app_sync_checkpoints ORDER BY created_at DESC LIMIT 1');assert.ok(binding);
    await c.query('BEGIN READ ONLY');await c.query('SET LOCAL enable_seqscan=off');
    const plan=(await c.query(`EXPLAIN (FORMAT JSON) SELECT octet_length(decode(metadata_envelope->>'ciphertext_b64','base64'))
      FROM app_attachment_stages WHERE org_id=$1 AND resource_binding_id=$2 AND checkpoint_id=$3
      AND state IN ('uploading','ready','blocked','linked','linked_blocked','retired') ORDER BY state,stage_expires_at,id LIMIT 4097`,
      [binding.org_id,binding.resource_binding_id,binding.id])).rows;
    const text=JSON.stringify(plan);assert.ok(text.includes('app_attachment_stages_active_checkpoint_idx'));assert.ok(text.includes('checkpoint_id'));
    const def=(await c.query("SELECT pg_get_indexdef('app_attachment_stages_active_checkpoint_idx'::regclass) AS definition")).rows[0].definition;
    assert.ok(def.includes('WHERE'));assert.ok(!def.includes('purged'));
    await c.query('ROLLBACK');
  }finally{await c.query('ROLLBACK').catch(()=>{});await c.end();}
});
