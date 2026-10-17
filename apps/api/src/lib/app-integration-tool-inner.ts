import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {canonicalAppDataJson,AppDataOperationInputSchema} from '@deft/app-kit';
import {AppIntegrationToolDeclarationSchema,AppIntegrationToolRuntimeRequestSchema,AppIntegrationToolRuntimeAuthorityRequestSchema} from '../../../../packages/app-kit/src/app-integration-tools.js';

const digest=(value:unknown)=>'sha256:'+createHash('sha256').update(canonicalAppDataJson(value)).digest('hex');
/** Runtime can nominate only the inner operation admitted by the original signed
 * declaration. This grants nothing: the retained principal/account grant still
 * has to be freshly checked by the invocation callback before returning true. */
export function assertAppIntegrationToolInner(declaration:unknown,original:unknown,callback:unknown){
 const declared=AppIntegrationToolDeclarationSchema.parse(declaration),request=AppIntegrationToolRuntimeRequestSchema.parse(original),check=AppIntegrationToolRuntimeAuthorityRequestSchema.parse(callback);
 const {schema_version:ignored,input,...pins}=request;
 const {schema_version:ignoredCheck,input_digest,inner,...checkPins}=check;
 if(!isDeepStrictEqual(pins,checkPins)||input_digest!==digest(input)||declared.key!==request.tool_key||declared.operation!==request.tool_operation||declared.store_key!==request.store_key
  ||inner===null&&(declared.operation!=='read'||declared.data_operations.length!==0)
  ||inner!==null&&(!declared.data_operations.includes(inner.operation)||inner.store_key!==request.store_key
    ||(['prepare_action','prepare_resource_action'].includes(inner.operation)?inner.action_key!==declared.action_key:inner.action_key!==undefined)))throw new Error('APP_INTEGRATION_TOOL_INNER_DENIED');
 if(inner){
  const deny=()=>{throw new Error('APP_INTEGRATION_TOOL_INNER_DENIED');};
  if(!AppDataOperationInputSchema.safeParse({operation:inner.operation,input:inner.input}).success||inner.input.store_key!==request.store_key||inner.input_digest!==digest({operation:inner.operation,input:inner.input}))deny();
  const mapped=declared.input_pins.filter(pin=>pin.operation===inner.operation);
  for(const pin of mapped){
   if(!Object.hasOwn(input,pin.outer_key)){if(pin.required||inner.input[pin.inner_field]!==request.request_id)deny();}
   else if(!isDeepStrictEqual(input[pin.outer_key],inner.input[pin.inner_field]))deny();
  }
  for(const field of ['record_id','expected_revision','value','operation_key'] as const)if(Object.hasOwn(inner.input,field)&&!(inner.operation==='resource_read_presentation'&&field==='record_id')&&!mapped.some(pin=>pin.inner_field===field))deny();
  if(Object.hasOwn(inner.input,'action_key')&&inner.input.action_key!==declared.action_key||Object.hasOwn(inner.input,'resource_key')&&inner.input.resource_key!==request.scope.resource_key)deny();
  if(inner.operation==='resource_read_presentation'&&(!request.source_refs.some(ref=>ref.record_id===inner.input.record_id&&ref.content_digest===inner.input.content_digest&&ref.resource_key===inner.input.resource_key)))deny();
  if(inner.operation==='resource_list'&&Object.hasOwn(inner.input,'anchor_record_id')&&(request.source_refs.length!==1||inner.input.anchor_record_id!==request.source_refs[0]?.record_id))deny();
  if(inner.operation==='prepare_resource_action'&&!isDeepStrictEqual(inner.input.sources,request.source_refs))deny();
 }
 return check;
}
