import {createHash} from 'node:crypto';
const sort=v=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;
const digest=v=>createHash('sha256').update(JSON.stringify(sort(v))).digest('hex');
// Public structural catalog, including migration/provenance tables and guards.
// No OID values or row data. pg_get_* output is intentionally PostgreSQL-version-bound.
export async function readCatalog(client){
 const result={};
 const excluded=[];
 const queries={
  relations:`SELECT c.relname,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,c.relreplident,c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND NOT c.relname=ANY($1::text[]) ORDER BY c.relname`,
  columns:`SELECT c.relname,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid) AS default_expr,co.collname FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum LEFT JOIN pg_collation co ON co.oid=a.attcollation WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped AND NOT c.relname=ANY($1::text[]) ORDER BY c.relname,a.attnum`,
  constraints:`SELECT c.relname,k.conname,k.contype,k.condeferrable,k.condeferred,k.convalidated,pg_get_constraintdef(k.oid,true) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT c.relname=ANY($1::text[]) ORDER BY c.relname,k.conname`,
  indexes:`SELECT c.relname,i.relname AS name,pg_get_indexdef(x.indexrelid) AS definition,x.indisvalid,x.indisready FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT c.relname=ANY($1::text[]) ORDER BY c.relname,i.relname`,
  functions:`SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,p.prosecdef,p.provolatile,p.proparallel,p.proconfig,p.proisstrict,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind IN ('f','p') AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.classid='pg_proc'::regclass AND d.deptype='e') AND cardinality($1::text[])>=0 ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)`,
  triggers:`SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal AND NOT c.relname=ANY($1::text[]) ORDER BY c.relname,t.tgname`,
  policies:`SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' AND NOT tablename=ANY($1::text[]) ORDER BY tablename,policyname`,
  enums:`SELECT t.typname,e.enumlabel,e.enumsortorder FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND cardinality($1::text[])>=0 ORDER BY t.typname,e.enumsortorder`,
  views:`SELECT c.relname,pg_get_viewdef(c.oid,true) AS definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('v','m') AND cardinality($1::text[])>=0 ORDER BY c.relname`,
  sequences:`SELECT sequencename,data_type,start_value,min_value,max_value,increment_by,cycle,cache_size FROM pg_sequences WHERE schemaname='public' AND cardinality($1::text[])>=0 ORDER BY sequencename`,
  extensions:`SELECT extname,extversion FROM pg_extension WHERE cardinality($1::text[])>=0 ORDER BY extname`,
  server:`SELECT current_setting('server_version_num') AS version WHERE cardinality($1::text[])>=0`,
 };
 for(const [name,sql] of Object.entries(queries))result[name]=(await client.query(sql,[excluded])).rows;
 return {digest:digest(result),catalog:result};
}
export async function readLedger(client){return (await client.query('SELECT version,description,checksum,kind,applied_at::text AS applied_at FROM public.deft_schema_migrations ORDER BY version')).rows;}
export async function readReceipts(client){if(!(await client.query("SELECT to_regclass('public.deft_e5_lineage_repairs') IS NOT NULL AS present")).rows[0].present)return [];return (await client.query('SELECT receipt FROM public.deft_e5_lineage_repairs ORDER BY lineage')).rows.map(row=>row.receipt);}
