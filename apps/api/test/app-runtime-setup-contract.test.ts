import test from 'node:test';import assert from 'node:assert/strict';
import { RuntimeSetupContextSchema } from '../src/lib/app-runtime-setup-contract.js';
const id='00000000-0000-4000-8000-000000000001',digest='sha256:'+'a'.repeat(64);
const context={schema_version:'deft.app_runtime_setup_context.v1',installation_id:id,app_version_id:id,grant_snapshot_id:id,package_digest:digest,grant_snapshot_digest:digest,lifecycle_epoch:1,grant_epoch:1,operator_user_id:id,policy:{review_requirement:'always',review_scope:'per_invocation',retry_class:'unsafe_or_unknown'},actions:[]};
test('Runtime setup DTO is closed and never includes credentials or provider inputs',()=>{assert(RuntimeSetupContextSchema.safeParse(context).success);assert.equal(RuntimeSetupContextSchema.safeParse({...context,session_token:'secret'}).success,false);assert.equal(RuntimeSetupContextSchema.safeParse({...context,policy:{...context.policy,review_scope:'once'}}).success,false);});
