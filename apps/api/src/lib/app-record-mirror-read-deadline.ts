import {appConsentDeadline,type AppConsentLifetime} from '@deft/app-kit';
import {AppError} from './app-errors.js';
export type RecordMirrorReadDeadlinePins={data_consent_expires_at:string|null;consent_lifetime?:AppConsentLifetime;scope:{consent_expires_at:string|null;consent_lifetime?:AppConsentLifetime}};
/** Persistent grant bounds do not extend the finite operation/window itself. */
export function assertRecordMirrorReadDeadline(pins:RecordMirrorReadDeadlinePins,clock=()=>new Date()){
 try {
  const data=appConsentDeadline(pins.data_consent_expires_at,pins.consent_lifetime),scope=appConsentDeadline(pins.scope.consent_expires_at,pins.scope.consent_lifetime),now=clock().getTime();
  if(!Number.isFinite(now)||Math.min(data,scope)<=now)throw Error('expired');
 }catch{throw new AppError('App data access ended','APP_ACCESS_DENIED',403);}
}
export async function discloseRecordMirrorRead<T>(pins:RecordMirrorReadDeadlinePins,read:()=>Promise<T>,clock=()=>new Date()):Promise<T>{
 assertRecordMirrorReadDeadline(pins,clock);const result=await read();assertRecordMirrorReadDeadline(pins,clock);return result;
}
