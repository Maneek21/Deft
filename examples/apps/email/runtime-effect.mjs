// Only the provider's deterministic pre-effect checks may construct this marker.
// Network, transport, reservation and journal failures must remain unclassified.
export class MailPreEffectValidationError extends Error {
 constructor(){super('EXACT_MAIL_INPUT_INVALID');this.name='MailPreEffectValidationError';}
}
export async function settleMailRuntimeEffect({sdk,claim,action,journal,effect}) {
 const started=await sdk.start(claim);
 let output,provider_succeeded=true;
 try {output=await effect(journal,claim.run_id,action,started.input);}
 catch(error){
  if(!(error instanceof MailPreEffectValidationError))throw error;
  provider_succeeded=false;
  output={operation_id:`mail-${claim.run_id}`,transport_outcome:'not_attempted',sent_copy_outcome:'not_applicable'};
 }
 // A lost/denied settlement remains uncertain to the supervisor. Never retry it.
 await sdk.result(claim,{status:'returned',provider_succeeded,output});
 if(provider_succeeded)journal.append({...journal.latest(claim.run_id),state:'reported'});
 return {run_id:claim.run_id,provider_succeeded};
}
