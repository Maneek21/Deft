import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
const target=process.env.DEFT_TEST_DATABASE_URL;
const safe=(()=>{try{if(!target||target!==process.env.DATABASE_URL)return false;const u=new URL(target);
  return u.hostname==='127.0.0.1'&&u.port==='55435'&&u.username==='gate_g_test'&&!u.password
    &&/^\/gate_g_20260927_c22_email7_test(?:_v[0-9]+)?$/u.test(u.pathname)&&!u.search&&!u.hash;}catch{return false;}})();
test('installed .51 keeps exact v1 and rejects malformed v2 composition, unsupported planes and foreign ancestry',
 {skip:!safe},async()=>{
  const c=new pg.Client({connectionString:target,statement_timeout:2000,query_timeout:3000});await c.connect();
  try{
    const {rows:[original]}=await c.query(`SELECT g.* FROM app_grant_snapshots g JOIN app_versions v ON v.org_id=g.org_id AND v.id=g.app_version_id
      WHERE v.protocol_version='7' AND g.canonical_snapshot->>'schema'='deft.app_blob_grant.v2' ORDER BY g.created_at DESC LIMIT 1`);
    assert.ok(original,'Normal public HTTP mixed activation must precede shape probes');
    await c.query('BEGIN');await c.query('SET LOCAL search_path=pg_temp,public');
    // Deliberately corrupt temporary copies exercise installed SQL functions;
    // no immutability bypass or synthetic authority reaches live tables.
    for(const [table,filter,args] of [
      ['app_versions','org_id=$1 AND id=$2',[original.org_id,original.app_version_id]],
      ['app_installations','org_id=$1 AND id=$2',[original.org_id,original.app_installation_id]],
      ['app_grant_snapshots','org_id=$1 AND app_installation_id=$2',[original.org_id,original.app_installation_id]],
      ['org_members','org_id=$1',[original.org_id]],
    ] as const)await c.query(`CREATE TEMP TABLE ${table} AS SELECT * FROM public.${table} WHERE ${filter}`,args as unknown[]);
    await c.query('CREATE TRIGGER lineage BEFORE INSERT ON pg_temp.app_grant_snapshots FOR EACH ROW EXECUTE FUNCTION public.enforce_app_grant_snapshot_lineage()');
    await c.query('CREATE TRIGGER shape BEFORE INSERT ON pg_temp.app_grant_snapshots FOR EACH ROW EXECUTE FUNCTION public.enforce_app_v7_effective_grant_shape()');
    const {rows:[version]}=await c.query('SELECT manifest FROM pg_temp.app_versions');
    const insert=(row:unknown)=>c.query('INSERT INTO pg_temp.app_grant_snapshots SELECT * FROM jsonb_populate_record(NULL::pg_temp.app_grant_snapshots,$1::jsonb)',[JSON.stringify(row)]);
    await c.query('SAVEPOINT baseline');await insert({...original,id:randomUUID()});await c.query('ROLLBACK TO baseline');
    const canonical=original.canonical_snapshot;
    let negatives=0;
    async function deny(label:string,snapshot=canonical,manifest=version.manifest,row=original){
      await c.query('UPDATE pg_temp.app_versions SET manifest=$1::jsonb',[JSON.stringify(manifest)]);await c.query('SAVEPOINT negative');
      await assert.rejects(insert({...row,id:randomUUID(),canonical_snapshot:snapshot}),(e:any)=>e.code==='23514',label);
      await c.query('ROLLBACK TO negative');negatives++;
    }
    for(const schema of [null,'deft.app_blob_grant.v3'])await deny('unknown grant schema',{...canonical,schema});
    for(const field of ['native_actions','public_actions'] as const){
      await deny(`snapshot ${field}`,{...canonical,[field]:[{unexpected:true}]});
      for(const value of [null,[{unexpected:true}]])await deny(`manifest ${field}`,canonical,{...version.manifest,[field]:value});
      const missing={...version.manifest};delete missing[field];await deny(`missing ${field}`,canonical,missing);
    }
    for(const field of ['runtime_actions','private_capabilities','runtime_requirements','experiences'] as const){
      const missing={...version.manifest};delete missing[field];await deny(`missing composition ${field}`,canonical,missing);
      await deny(`null composition ${field}`,canonical,{...version.manifest,[field]:null});
    }
    await deny('undeclared action',{...canonical,runtime_actions:[{...canonical.runtime_actions[0],action_key:'foreign'}]});
    await deny('duplicate action',{...canonical,runtime_actions:canonical.runtime_actions.map((a:any)=>canonical.runtime_actions[0])});
    await deny('changed contract',{...canonical,runtime_actions:canonical.runtime_actions.map((a:any,i:number)=>i===0?{...a,input_schema:{type:'object'}}:a)});
    await deny('unknown action authority',{...canonical,runtime_actions:canonical.runtime_actions.map((a:any)=>({...a,credential:'forbidden'}))});
    await deny('missing Experience pin',{...canonical,experiences:[]});
    for(const field of ['organization_id','app_installation_id','app_version_id','requested_snapshot_id'])await deny(`foreign ${field}`,{...canonical,[field]:randomUUID()});
    await deny('foreign requested row',canonical,version.manifest,{...original,requested_snapshot_id:randomUUID()});
    const {rows:[operator]}=await c.query("SELECT user_id FROM pg_temp.org_members WHERE role='member' LIMIT 1");assert.ok(operator);
    await deny('nonmanager review',canonical,version.manifest,{...original,reviewed_by_actor_id:operator.user_id});
    await deny('v1 cannot admit mixed manifest',{...canonical,schema:'deft.app_blob_grant.v1',runtime_actions:[],experiences:[]});
    // A valid old v1 shape stays accepted, with every former authority plane empty.
    await c.query('UPDATE pg_temp.app_versions SET manifest=$1::jsonb',[JSON.stringify({...version.manifest,runtime_actions:[],private_capabilities:[],experiences:[]})]);
    await insert({...original,id:randomUUID(),canonical_snapshot:{...canonical,schema:'deft.app_blob_grant.v1',runtime_actions:[],experiences:[]}});
    assert.equal(negatives,30);await c.query('ROLLBACK');
    assert.equal((await c.query("SELECT count(*)::int AS n FROM deft_schema_migrations WHERE version='0.3.0-preview.51'")).rows[0].n,1);
  }finally{await c.query('ROLLBACK').catch(()=>{});await c.end();}
 });
