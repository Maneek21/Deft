import {AppDataRecordSchema,canonicalAppDataJson,type AppDataResult} from '../../../../packages/app-kit/src/app-data';
import {DeftExperienceRecordIntakeSchema,type DeftExperienceRecordIntake} from '../../../../packages/app-kit/src/record-intake';
import type {ExperienceMailtoSuggestion} from './app-experience-mailto';
export type RecordIntakeEvent={kind:'record_intake';intake_key:string;record:{store_key:string;record_id:string;revision:number;content_digest:string;status:string}};
export function createRecordIntake(intakeInput:DeftExperienceRecordIntake,suggestion:ExperienceMailtoSuggestion,ports:{request:(operation:'record_create'|'request_status'|'record_read',input:Record<string,unknown>,requestId:string)=>Promise<AppDataResult>;emit:(event:RecordIntakeEvent)=>Promise<boolean>}){
 const intake=DeftExperienceRecordIntakeSchema.parse(intakeInput),recordId=crypto.randomUUID(),requestId=crypto.randomUUID();
 const value={...intake.seed,[intake.fields.to]:suggestion.to,[intake.fields.cc]:suggestion.cc,[intake.fields.bcc]:suggestion.bcc,[intake.fields.subject]:suggestion.subject,[intake.fields.plain]:suggestion.plain};
 if(new TextEncoder().encode(canonicalAppDataJson(value)).length>intake.profile.max_record_bytes)throw Error('Draft exceeds its signed profile limit');
 const input={store_key:intake.store_key,record_id:recordId,value};let dispatched=false,receipt:RecordIntakeEvent|null=null;
 const digest=async()=>{const bytes=new TextEncoder().encode(canonicalAppDataJson({operation:'record_create',input}));return 'sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');};
 const accept=(raw:unknown)=>{const row=AppDataRecordSchema.parse(raw);if(row.store_key!==intake.store_key||row.record_id!==recordId||row.revision!==1||row.status!=='draft')throw Error('Created draft could not be verified');receipt={kind:'record_intake',intake_key:intake.key,record:{store_key:row.store_key,record_id:row.record_id,revision:row.revision,content_digest:row.content_digest,status:row.status}};return receipt;};
 return {async create(){if(dispatched)throw Error('Check the original draft creation status');dispatched=true;const result=await ports.request('record_create',input,requestId);return accept(result.record);},
 async check(){if(receipt)return receipt;if(!dispatched)throw Error('Draft has not been created');const result=await ports.request('request_status',{store_key:intake.store_key,request_id:requestId},crypto.randomUUID()),status=result.request_status;
 if(!status||status.state!=='completed')return null;if(status.request_id!==requestId||status.operation!=='record_create'||status.input_digest!==await digest()||status.record_id!==recordId||status.revision!==1)throw Error('Original creation status changed');
 const read=await ports.request('record_read',{store_key:intake.store_key,record_id:recordId},crypto.randomUUID());if(read.record?.content_digest!==status.content_digest)throw Error('Created draft changed');return accept(read.record);},
 async open(){if(!receipt)throw Error('Creation has not been confirmed');return ports.emit(receipt);}};
}
