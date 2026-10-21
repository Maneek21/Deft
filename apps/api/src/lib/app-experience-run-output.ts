import {AppRunRetainedProviderResultSchema} from '@deft/shared';
import {parseRuntimeObjectInput,RuntimeObjectSchema} from '@deft/app-kit/core';

/** No retained input, provider envelope, runtime credential or unreviewed field
 * enters the author status channel. Failed acknowledged output remains useful
 * for reporting per-item outcomes, but uncertain attempts have no receipt. */
export function experienceTerminalOutput(raw:unknown,contract:unknown,state:'succeeded'|'failed'){
  const envelope=AppRunRetainedProviderResultSchema.parse(raw);
  if(envelope.provider_succeeded!==(state==='succeeded'))throw Error('Runtime output state changed');
  const output=parseRuntimeObjectInput(RuntimeObjectSchema.parse(contract),envelope.output);
  if(Buffer.byteLength(JSON.stringify(output),'utf8')>60_000)throw Error('Runtime output limit');
  return Object.freeze(output);
}
