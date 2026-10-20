import {isDeepStrictEqual} from 'node:util';
import type {AppPreparedMirrorInput} from '@deft/app-kit/core';
import type {ReviewedRecordMirrorAuthority} from './app-record-mirror-authority.js';
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
/** Positive outcome alone grants nothing: the signed cleanup declaration,
 * accepted human Run and immutable preparation must share every source pin. */
export function preparedRecordCleanupMatches(pins:ReviewedRecordMirrorAuthority,input:AppPreparedMirrorInput,source:Record<string,unknown>,run:Record<string,unknown>){
 const connection=source.connection,outcome=run.safe_outcome;
 return input.mirror_operation==='delete'&&typeof source.action_key==='string'&&Boolean(pins.policy.cleanup_action_keys?.includes(source.action_key))
  &&source.action_key!==pins.policy.action_key&&run.state==='succeeded'&&object(outcome)&&outcome.success===true
  &&run.initiating_actor_type==='human'&&run.initiating_actor_id===pins.scope.owner_user_id&&run.provider_kind==='app_runtime'&&run.origin_kind==='app'
  &&run.operation_name===source.action_key&&run.input_fingerprint===source.run_input_fingerprint
  &&run.origin_app_installation_id===pins.scope.installation_id&&run.origin_app_version_id===pins.scope.app_version_id&&run.origin_app_grant_snapshot_id===pins.scope.grant_snapshot_id
  &&isDeepStrictEqual(source.scope,pins.scope)&&source.account_ref===pins.connection.account_ref
  &&object(connection)&&connection.session_id===pins.connection.session_id&&connection.runtime_session_ref===pins.connection.runtime_session_ref
  &&source.store_key===input.record_store_key&&source.record_id===input.record_id&&source.record_revision===input.record_revision&&source.content_digest===input.content_digest
  &&source.snapshot_id===input.accepted_snapshot_id&&source.snapshot_digest===input.accepted_snapshot_digest;
}
