import {AppIntegrationSourceIdentitySchema,AppIntegrationSourceTargetSchema,type AppIntegrationSourceIdentity,type AppIntegrationSourceTarget} from '../../../../packages/app-kit/src/app-integration-source.js';
import type {AppIntegrationSourceCaller,AppIntegrationSourceSnapshot} from './app-integration-source.js';

/** A destination-owned citation retains evidence independently of this link.
 * The Host resolves a signed installed navigation entry on each opening. */
export type AppIntegrationSourceLocator=Readonly<{schema_version:'deft.app_integration_source_locator.v1';
 target:AppIntegrationSourceIdentity;navigation_entry_key:string}>;
export function appIntegrationSourceLocator(snapshot:AppIntegrationSourceSnapshot,navigation_entry_key:string):AppIntegrationSourceLocator{
 if(!/^[a-z][a-z0-9_]{0,47}$/u.test(navigation_entry_key))throw new Error('APP_INTEGRATION_SOURCE_LOCATOR_INVALID');
 const {resource_binding_id:unusedBinding,projection_id:unusedProjection,...identity}=snapshot.publication.target;void unusedBinding;void unusedProjection;
 return {schema_version:'deft.app_integration_source_locator.v1',target:AppIntegrationSourceIdentitySchema.parse(identity),navigation_entry_key};
}
export async function openAppIntegrationSourceLocator(caller:AppIntegrationSourceCaller,locator:AppIntegrationSourceLocator,ports:{
 resolve(caller:AppIntegrationSourceCaller,identity:AppIntegrationSourceIdentity):Promise<AppIntegrationSourceTarget>;
 read(caller:AppIntegrationSourceCaller,target:AppIntegrationSourceTarget):Promise<AppIntegrationSourceSnapshot>;
 navigation(caller:AppIntegrationSourceCaller,target:AppIntegrationSourceTarget,entry:string):Promise<{entry_key:string;href:string}>;
}){
 if(caller.kind!=='human'||locator.schema_version!=='deft.app_integration_source_locator.v1')throw new Error('APP_INTEGRATION_SOURCE_CHANGED_OR_DENIED');
 const identity=AppIntegrationSourceIdentitySchema.parse(locator.target);
 const target=AppIntegrationSourceTargetSchema.parse(await ports.resolve(caller,identity));
 const {resource_binding_id:unusedBinding,projection_id:unusedProjection,...resolvedIdentity}=target;void unusedBinding;void unusedProjection;
 if(JSON.stringify(resolvedIdentity)!==JSON.stringify(identity))throw new Error('APP_INTEGRATION_SOURCE_CHANGED_OR_DENIED');
 await ports.read(caller,target);
 const navigation=await ports.navigation(caller,target,locator.navigation_entry_key);
 if(navigation.entry_key!==locator.navigation_entry_key||!navigation.href.startsWith('/')||navigation.href.startsWith('//')
  ||/[\\\u0000-\u001f\u007f]/u.test(navigation.href))throw new Error('APP_INTEGRATION_SOURCE_LOCATOR_INVALID');
 return navigation.href;
}
