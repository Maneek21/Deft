import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {z} from 'zod';
import {AppIntegrationSourcePendingError} from '../src/lib/app-integration-source-projection.js';
const source=readFileSync(new URL('../src/routes/app-integration-destinations.ts',import.meta.url),'utf8');
const start=source.indexOf('export function appIntegrationDestinationFailure'),end=source.indexOf('/** Mounted',start);
const failure=new Function('z','AppIntegrationSourcePendingError',stripTypeScriptTypes(source.slice(start,end).replace('export function','function'),{mode:'transform'})+';return appIntegrationDestinationFailure;')(z,AppIntegrationSourcePendingError);
test('destination HTTP distinguishes authorized publication lag and preserves all ordinary denials',()=>{
 assert.equal(failure(new AppIntegrationSourcePendingError()).status,409);assert.equal(failure(new AppIntegrationSourcePendingError()).body.code,'APP_INTEGRATION_SOURCE_PENDING');
 for(const error of [Error('revoked'),Error('foreign account'),Error('APP_INTEGRATION_SOURCE_PENDING'),{code:'APP_INTEGRATION_SOURCE_PENDING'}]){assert.equal(failure(error).status,403);assert.equal(failure(error).body.code,'APP_INTEGRATION_DESTINATION_CHANGED_OR_DENIED');}
 const result=z.object({id:z.uuid()}).safeParse({id:'invalid'});assert.equal(failure(result.error).status,400);
});
