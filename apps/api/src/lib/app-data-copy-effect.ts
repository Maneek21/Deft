import {createHash} from 'node:crypto';
import {AppDataPreparedRecordActionSchema,canonicalAppDataJson,type AppDataPreparedRecordAction} from '@deft/app-kit';

/** The declaration is reviewed content. Current action authority is checked
 * independently by the host, and current custody by the external executor. */
export function verifiedPreparedCopyEffect(raw:unknown,bindingId?:string):AppDataPreparedRecordAction {
  const prepared=AppDataPreparedRecordActionSchema.parse(raw);
  if(!prepared.copy_effect)return prepared;
  const {plan_digest,...unsigned}=prepared.copy_effect;
  const digest='sha256:'+createHash('sha256').update(canonicalAppDataJson(unsigned)).digest('hex');
  if(digest!==plan_digest||bindingId!==undefined&&prepared.copy_effect.action_binding_id!==bindingId)
    throw new Error('Prepared copy effect changed');
  return prepared;
}

/** The invocation journal deliberately retains no draft preview. Reuse the
 * same metadata checks without requiring private content in that journal. */
export function verifiedRetainedPreparedCopyEffect(raw:unknown,bindingId:string):AppDataPreparedRecordAction {
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.hasOwn(raw,'preview'))
    throw new Error('Invalid retained prepared metadata');
  return verifiedPreparedCopyEffect({...raw,preview:{}},bindingId);
}
