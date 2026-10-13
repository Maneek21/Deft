import {AppError} from './app-errors.js';
export type RecordMirrorReadDeadlinePins={data_consent_expires_at:string;scope:{consent_expires_at:string}};
/** Read visibility cannot outlive either actual data or resource grant. This is
 * independent of recurring Modify state and never renews any authority. */
export function assertRecordMirrorReadDeadline(pins:RecordMirrorReadDeadlinePins,clock=()=>new Date()){
 const data=Date.parse(pins.data_consent_expires_at),scope=Date.parse(pins.scope.consent_expires_at),now=clock().getTime();
 if(!Number.isFinite(data)||!Number.isFinite(scope)||!Number.isFinite(now)||Math.min(data,scope)<=now)throw new AppError('App data access ended','APP_ACCESS_DENIED',403);
}
export async function discloseRecordMirrorRead<T>(pins:RecordMirrorReadDeadlinePins,read:()=>Promise<T>,clock=()=>new Date()):Promise<T>{
 assertRecordMirrorReadDeadline(pins,clock);const result=await read();assertRecordMirrorReadDeadline(pins,clock);return result;
}
