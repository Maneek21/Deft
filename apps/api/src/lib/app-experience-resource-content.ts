import { z } from 'zod';
import { parseRuntimeObjectInput } from '@deft/app-kit/core';
import { AppError } from './app-errors.js';
import type { AppExperienceExposureService } from './app-experience-exposure.js';
import type { ExperienceCaller } from './app-experience-service.js';
import { getAppConnectionRegistry, type AppConnectionRegistry } from './app-connection-registry.js';
import { humanActionDigest } from './app-experience-human-action-contract.js';

const fileRef=z.string().regex(/^[a-f0-9]{64}$/u),recordId=z.string().uuid();
export const ExperienceResourceContentRequestSchema = z.union([
 z.strictObject({operation:z.enum(['read_document','read_source','triage_options','list_files','read_presentation']),record_id:recordId}),
 z.strictObject({operation:z.literal('read_file'),record_id:recordId,file_ref:fileRef}),
 z.strictObject({operation:z.literal('read_image'),record_id:recordId,image_ref:fileRef}),
]);
export const ExperienceSourceFileSchema=z.strictObject({file_ref:fileRef,filename:z.string().min(1).max(200).refine(value=>!/[\u0000-\u001f\u007f/\\]/u.test(value)),media_type:z.string().regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u),size_bytes:z.number().int().min(0).max(8388608),disposition:z.enum(['attachment','inline']),preview:z.enum(['text','image','pdf','unsupported']),content_id:z.string().max(256).optional()});
const sourceFiles=z.array(ExperienceSourceFileSchema).max(32).refine(rows=>new Set(rows.map(row=>row.file_ref)).size===rows.length);
const presentationSchema=z.strictObject({format:z.enum(['plain','html']),content:z.string().max(262144).refine(value=>Buffer.byteLength(value,'utf8')<=262144&&!value.includes('\0')),plain_text:z.string().max(262144).refine(value=>Buffer.byteLength(value,'utf8')<=262144),truncated:z.boolean(),rendering_fallback:z.literal('plain_text').optional(),images:z.array(z.strictObject({image_ref:fileRef,kind:z.enum(['cid','remote']),index:z.number().int().min(0).max(31),alt:z.string().max(200)})).max(32),headers:z.array(z.strictObject({label:z.string().min(1).max(64).refine(value=>!/[\r\n\0]/u.test(value)),value:z.string().max(2048).refine(value=>!/[\r\n\0]/u.test(value))})).max(6),metadata:z.record(z.string(),z.union([z.string(),z.number().finite(),z.boolean()])).optional()}).refine(value=>value.rendering_fallback===undefined||value.format==='plain'&&value.images.length===0);
const option=z.strictObject({id:z.string().min(1).max(256).refine(value=>!/[\r\n\0]/.test(value)),label:z.string().min(1).max(256).refine(value=>!/[\r\n\0]/.test(value))});
export const ExperienceTriageOptionsSchema=z.strictObject({schema_version:z.literal('deft.experience_triage_options.v1'),account_id:z.string().min(1).max(256),provider:z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/u),destinations:z.array(option.extend({kind:z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/u)})).max(100),labels:z.array(option).max(100),complete:z.boolean(),labels_supported:z.boolean()}).refine(value=>value.destinations.length+value.labels.length<=100&&new Set(value.destinations.map(row=>row.id)).size===value.destinations.length&&new Set(value.labels.map(row=>row.id)).size===value.labels.length);
export const ExperienceResourceDocumentSchema = z.strictObject({ format: z.enum(['plain','html']), content: z.string().max(16384).refine(value=>!value.includes('\0')),
  truncated: z.boolean(), plain_text:z.string().max(16384).refine(value=>!value.includes('\0')).optional(), metadata: z.record(z.string(), z.union([z.string(),z.number().finite(),z.boolean()])).optional() })
  .refine(value=>value.format!=='html'||typeof value.plain_text==='string');
const unavailable = () => new AppError('Original content is unavailable for this source', 'APP_ACTION_UNAVAILABLE', 409);
type Authority = Pick<AppExperienceExposureService, 'sourceRecord' | 'connectionSetup'>;
type SourceReadingPolicy = (input: { caller: ExperienceCaller; entry: ReturnType<AppConnectionRegistry['select']>;
  record: Record<string, unknown>; signal: AbortSignal }) => Promise<'ask' | 'always'>;

/** Fixed private adapter, exact host source, and a current source read ceiling.
 * This port cannot prepare an action or nominate provider URLs. */
export class AppExperienceResourceContentService {
  constructor(private readonly authority: Authority, private readonly registry: () => Promise<AppConnectionRegistry> = getAppConnectionRegistry,
    private readonly now = Date.now, private readonly timeoutMs = 15000,
    // Legacy resource readers have no app-owned preference record. Never infer
    // content disclosure policy from a native product's account tables.
    private readonly readingPolicy: SourceReadingPolicy = async () => 'ask') {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw new TypeError('Invalid content timeout');
  }
  async read(caller: ExperienceCaller, sessionId: string, resourceKey: string, raw: unknown, signal?: AbortSignal) {
    const input = ExperienceResourceContentRequestSchema.parse(raw);
    signal?.throwIfAborted();
    const controller = new AbortController();
    let captured:Uint8Array|undefined;
    const workSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let rejectLimit: (error: Error) => void = () => undefined;
    const limit = new Promise<never>((_resolve, reject) => { rejectLimit = reject; });
    const abort = () => { captured?.fill(0); rejectLimit(unavailable()); };
    workSignal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const work = this.readCurrent(caller, sessionId, resourceKey, input, workSignal,bytes=>{captured=bytes;if(workSignal.aborted)bytes.fill(0);}).then(output => {
      if (workSignal.aborted) {captured?.fill(0);throw unavailable();} return output;
    });
    try { return await Promise.race([work, limit]); }
    catch { throw unavailable(); }
    finally { clearTimeout(timer); workSignal.removeEventListener('abort', abort); }
  }
  private async readCurrent(caller: ExperienceCaller, sessionId: string, resourceKey: string,
    input: z.infer<typeof ExperienceResourceContentRequestSchema>, signal: AbortSignal,capture:(bytes:Uint8Array)=>void) {
    const source = await this.authority.sourceRecord(caller, sessionId, resourceKey, input.record_id, signal);
    const sourceInspection=['list_files','read_file','read_presentation','read_image'].includes(input.operation);
    const purpose=sourceInspection?'read_source':input.operation as 'read_document'|'read_source'|'triage_options';
    if (source.record.record_id !== input.record_id) throw unavailable();
    const entry = (await this.registry()).select({ org_id: caller.org_id, owner_user_id: caller.user_id,
      installation_id: source.installation_id, target_key: source.target_key });
    if (entry.pins.resource_key !== resourceKey || entry.pins.resource_binding_id !== source.resource_binding_id
      || input.operation==='read_document'&&!entry.adapter.readResource || input.operation==='read_source'&&!entry.adapter.readSource || input.operation==='triage_options'&&!entry.adapter.readTriageOptions || sourceInspection&&!entry.adapter.readSourceFiles) throw unavailable();
    const initial = structuredClone(await this.authority.connectionSetup(caller, sessionId, entry.pins, signal, purpose));
    const policy = initial.content_policy;
    if (initial.purpose !== purpose || !initial.allowed_operations.includes('read_one')
      || input.operation==='read_document'&&!policy?.document || purpose==='read_source'&&!policy?.source || input.operation==='triage_options'&&!policy?.triage_options) throw unavailable();
    if (initial.org_id !== caller.org_id || initial.owner_user_id !== caller.user_id || initial.web_session_id !== caller.sid
      || initial.experience_session_id !== sessionId || Object.entries(entry.pins).some(([key,value]) => initial[key as keyof typeof initial] !== value)) throw unavailable();
    const projectionDigest = (value: typeof initial) => { const { checked_at: _checked, expires_at: _expires, ...pins } = value; return humanActionDigest(pins); };
    const expectedProjectionDigest = projectionDigest(initial);
    const deadline = Math.min(initial.expires_at, this.now() + this.timeoutMs), same = humanActionDigest(source);
    if (!Number.isFinite(deadline)) throw unavailable();
    const check = () => { signal?.throwIfAborted(); if (this.now() >= deadline) throw unavailable(); };
    const recheck = async () => {
      check();
      const current = await this.authority.connectionSetup(caller, sessionId, entry.pins, signal, purpose);
      if (current.purpose !== purpose || !current.allowed_operations.includes('read_one') || !Number.isFinite(current.expires_at) || current.expires_at < deadline
        || current.lifecycle_epoch !== initial.lifecycle_epoch || current.grant_epoch !== initial.grant_epoch || current.runtime_epoch !== initial.runtime_epoch) throw unavailable();
      if (projectionDigest(current) !== expectedProjectionDigest) throw unavailable();
      check(); return { ...current, expires_at: deadline };
    };
    let captured:Uint8Array|undefined;
    try {
      await recheck();
      if(sourceInspection){
        const raw=await entry.adapter.readSourceFiles!({record:structuredClone(source.record),...(input.operation==='read_file'?{file_ref:input.file_ref}:{}),...(input.operation==='read_image'?{image_ref:input.image_ref}:{}),...(input.operation==='read_presentation'?{presentation:true as const}:{})},{projection:structuredClone({...initial,expires_at:deadline}),recheck,signal});
        if(!raw||typeof raw!=='object'||Array.isArray(raw))throw unavailable();const result=raw as Record<string,unknown>;
        if(result.bytes instanceof Uint8Array){captured=result.bytes;capture(captured);}
        await recheck();const currentSource=await this.authority.sourceRecord(caller,sessionId,resourceKey,input.record_id,signal);
        if(same!==humanActionDigest(currentSource))throw unavailable();
        const common={exposure_id:source.exposure_id,exposure_epoch:source.exposure_epoch,expires_at:new Date(initial.expires_at).toISOString()},files=sourceFiles.parse(result.files);
        const omitted=z.number().int().min(0).max(256).optional().parse(result.omitted_file_count),inventory=omitted===undefined?{}:{omitted_file_count:omitted};
        if(files.reduce((sum,row)=>sum+row.size_bytes,0)>policy!.source!.max_bytes)throw unavailable();
        check();
        if(input.operation==='list_files'){if(Object.keys(result).some(key=>!['files','omitted_file_count'].includes(key)))throw unavailable();return {kind:'files' as const,files,...inventory,...common};}
        if(input.operation==='read_presentation'){
          if(Object.keys(result).some(key=>!['files','presentation','omitted_file_count'].includes(key)))throw unavailable();
          const presentation=presentationSchema.parse(result.presentation);
          if(presentation.metadata!==undefined){if(!policy?.document.metadata_schema)throw unavailable();presentation.metadata=parseRuntimeObjectInput(policy.document.metadata_schema,presentation.metadata);}
          const external_images=await this.readingPolicy({caller,entry,record:source.record,signal});
          await recheck();const finalSource=await this.authority.sourceRecord(caller,sessionId,resourceKey,input.record_id,signal);
          if(same!==humanActionDigest(finalSource)||!['ask','always'].includes(external_images))throw unavailable();check();
          return {kind:'presentation' as const,presentation:{...presentation,...inventory,external_images},...common};
        }
        if(!captured||captured.byteLength>policy!.source!.max_bytes)throw unavailable();
        if(input.operation==='read_file'){const selected=files.find(row=>row.file_ref===input.file_ref);if(!selected||result.file_ref!==input.file_ref||captured.byteLength!==selected.size_bytes||Object.keys(result).some(key=>!['files','file_ref','bytes','omitted_file_count'].includes(key)))throw unavailable();return {kind:'file' as const,bytes:captured,media_type:'application/octet-stream' as const,filename:selected.filename,...common};}
        if(input.operation==='read_image'){if(result.image_ref!==input.image_ref||captured.byteLength<1||captured.byteLength>2097152||!['image/png','image/jpeg','image/gif','image/webp'].includes(String(result.media_type))||Object.keys(result).some(key=>!['files','image_ref','bytes','media_type','omitted_file_count'].includes(key)))throw unavailable();return {kind:'image' as const,bytes:captured,media_type:String(result.media_type),filename:'resource-image',...common};}
        throw unavailable();
      }
      if(input.operation==='triage_options'){
        const options=ExperienceTriageOptionsSchema.parse(await entry.adapter.readTriageOptions!({record:structuredClone(source.record)},{projection:structuredClone({...initial,expires_at:deadline}),recheck,signal}));
        await recheck();const currentSource=await this.authority.sourceRecord(caller,sessionId,resourceKey,input.record_id,signal);
        if(same!==humanActionDigest(currentSource)||options.destinations.length+options.labels.length>policy!.triage_options!.max_options||Buffer.byteLength(JSON.stringify(options),'utf8')>60000)throw unavailable();
        check();return {kind:'options' as const,options,exposure_id:source.exposure_id,exposure_epoch:source.exposure_epoch};
      }
      if(input.operation==='read_source'){
        const output=await entry.adapter.readSource!({record:structuredClone(source.record)},{projection:structuredClone({...initial,expires_at:deadline}),recheck,signal});
        if(!(output.bytes instanceof Uint8Array))throw unavailable();captured=output.bytes;capture(captured);
        await recheck();const currentSource=await this.authority.sourceRecord(caller,sessionId,resourceKey,input.record_id,signal);
        if(same!==humanActionDigest(currentSource)||captured.byteLength<1||captured.byteLength>policy!.source!.max_bytes||output.media_type!==policy!.source!.media_type||output.filename!==policy!.source!.filename)throw unavailable();
        check();return {kind:'source' as const,bytes:captured,media_type:output.media_type,filename:output.filename,exposure_id:source.exposure_id,exposure_epoch:source.exposure_epoch};
      }
      const output = await entry.adapter.readResource!({ operation: 'read_document', record: structuredClone(source.record) }, { projection: structuredClone({ ...initial, expires_at: deadline }), recheck, signal });
      await recheck();
      const currentSource = await this.authority.sourceRecord(caller, sessionId, resourceKey, input.record_id, signal);
      if (same !== humanActionDigest(currentSource)) throw unavailable();
      check();
      const document = ExperienceResourceDocumentSchema.parse(output);
      if (document.content.length > policy!.document.max_characters || (document.plain_text?.length??0)>policy!.document.max_characters
        || !(policy!.document.formats??['plain']).includes(document.format)) throw unavailable();
      if (policy!.document.metadata_schema) {
        document.metadata = parseRuntimeObjectInput(policy!.document.metadata_schema, document.metadata ?? {});
      } else if (document.metadata !== undefined) throw unavailable();
      if (Buffer.byteLength(JSON.stringify(document), 'utf8') > 65536) throw unavailable();
      return { kind: 'document' as const, exposure_id: source.exposure_id, exposure_epoch: source.exposure_epoch, document };
    } catch (error) {
      captured?.fill(0);
      if (error instanceof AppError) throw error;
      throw unavailable();
    }
  }
}
