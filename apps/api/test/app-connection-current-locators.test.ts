import assert from 'node:assert/strict';
import test from 'node:test';
import {drizzle} from 'drizzle-orm/node-postgres';
import {currentConnectionBindingLocators,currentConnectionSessionLocators} from '../src/lib/app-connection-current-locators.js';
import type {AppRunTransaction} from '../src/lib/app-run-repository.js';

const tx=drizzle.mock() as unknown as AppRunTransaction;
const caller={org_id:'own-org',user_id:'own-human'},nomination={installation_id:'same-email',target_key:'same-target'};
test('old retained and current same-target bindings are separated by current version and effective grant before the two-row bound',()=>{
 const query=currentConnectionBindingLocators(tx,caller,nomination).limit(2).toSQL();
 assert.match(query.sql,/inner join "app_installations"/);
 assert.match(query.sql,/"app_resource_bindings"\."app_version_id" = "app_installations"\."active_version_id"/);
 assert.match(query.sql,/"app_resource_bindings"\."grant_snapshot_id" = "app_installations"\."active_grant_snapshot_id"/);
 assert.match(query.sql,/"app_installations"\."active_grant_snapshot_kind" = \$/);
 assert.match(query.sql,/"app_installations"\."state" = \$/);
 assert.match(query.sql,/"app_resource_bindings"\."org_id" = "app_installations"\."org_id"/);
 assert.match(query.sql,/"app_resource_bindings"\."app_installation_id" = "app_installations"\."id"/);
 assert.match(query.sql,/"app_resource_bindings"\."owner_user_id" = \$/);
 assert.deepEqual(query.params,['own-org','own-human','same-email','active','same-target','active','effective',2]);
 assert.equal(query.sql.includes('for share'),false,'locator introduces no App lock before the existing human locks');
});
test('data catalog excludes retained version/grant and foreign owner scopes before parsing manifests or invoking metadata',()=>{
 const query=currentConnectionSessionLocators(tx,caller,nomination.installation_id).toSQL();
 assert.match(query.sql,/inner join "app_installations"/);
 assert.match(query.sql,/"app_connection_sessions"\."org_id" = "app_installations"\."org_id"/);
 assert.match(query.sql,/"record"->'scope'->>'installation_id' = "app_installations"\."id"::text/);
 assert.match(query.sql,/"record"->'scope'->>'app_version_id' = "app_installations"\."active_version_id"::text/);
 assert.match(query.sql,/"record"->'scope'->>'grant_snapshot_id' = "app_installations"\."active_grant_snapshot_id"::text/);
 assert.match(query.sql,/"app_connection_sessions"\."owner_user_id" = \$/);
 assert.deepEqual(query.params,['own-org','own-human','same-email','active','effective','connected']);
 assert.equal(query.sql.includes('for share'),false);
});
test('catalog lookup applies the same current scope without a nominated target and retains the bounded catalog',()=>{
 const query=currentConnectionBindingLocators(tx,caller,{installation_id:nomination.installation_id}).limit(33).toSQL();
 assert.match(query.sql,/"app_resource_bindings"\."app_version_id" = "app_installations"\."active_version_id"/);
 assert.match(query.sql,/"app_resource_bindings"\."grant_snapshot_id" = "app_installations"\."active_grant_snapshot_id"/);
 assert.deepEqual(query.params,['own-org','own-human','same-email','active','active','effective',33]);
});
