import {createHash} from 'node:crypto';
import {AppDataPreparedRecordActionSchema,canonicalAppDataJson,canonicalAppPreparedEffectJson,parseAppPreparedEffectDetails,
  type AppDataPreparedRecordAction,type RecordStoreDeclaration} from '@deft/app-kit';

/** The declaration is reviewed content. Current action authority is checked
 * independently by the host, and current custody by the external executor. */
export function verifiedPreparedRecordAction(raw:unknown,bindingId?:string,store?:Pick<RecordStoreDeclaration,'supplemental_effects'>):AppDataPreparedRecordAction {
  const prepared=AppDataPreparedRecordActionSchema.parse(raw);
  if(prepared.supplemental_effect){
    const effect=prepared.supplemental_effect;
    const digest='sha256:'+createHash('sha256').update(canonicalAppPreparedEffectJson(effect)).digest('hex');
    if(digest!==effect.plan_digest||bindingId!==undefined&&effect.action_binding_id!==bindingId)
      throw new Error('Prepared effect changed');
    if(store){
      const declaration=store.supplemental_effects?.find(row=>row.action_key===prepared.action_key&&row.key===effect.effect_key);
      if(!declaration)throw new Error('Prepared effect is not declared');
      parseAppPreparedEffectDetails(declaration,effect);
    }
    return prepared;
  }
  // Retained v1 metadata can still be inspected without changing its identity.
  // New apps use declared supplemental effects; their semantics belong to the Runtime.
  if(!prepared.copy_effect)return prepared;
  const {plan_digest,...unsigned}=prepared.copy_effect;
  const digest='sha256:'+createHash('sha256').update(canonicalAppDataJson(unsigned)).digest('hex');
  if(digest!==plan_digest||bindingId!==undefined&&prepared.copy_effect.action_binding_id!==bindingId)
    throw new Error('Prepared copy effect changed');
  return prepared;
}

/** The invocation journal deliberately retains no draft preview. Reuse the
 * same metadata checks without requiring private content in that journal. */
export function verifiedRetainedPreparedRecordAction(raw:unknown,bindingId:string,store?:Pick<RecordStoreDeclaration,'supplemental_effects'>):AppDataPreparedRecordAction {
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.hasOwn(raw,'preview'))
    throw new Error('Invalid retained prepared metadata');
  return verifiedPreparedRecordAction({...raw,preview:{}},bindingId,store);
}
