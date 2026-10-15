import {appConsentDeadline,type AppConsentLifetime} from '@deft/app-kit';
import {AppError} from './app-errors.js';

/** Only explicitly reviewed persistent account/policy grants admit a persistent
 * store grant. Requests, reviews and provider I/O retain their own deadlines. */
export function appDataConsentExpiry(requested:string|null,scopeExpiresAt:string|null,maxConsentSeconds:number,now=Date.now(),
 lifetime?:AppConsentLifetime,scopeLifetime?:AppConsentLifetime,allowUntilRevoked=false):number {
 let nominated:number,scope:number;
 try {nominated=appConsentDeadline(requested,lifetime);scope=appConsentDeadline(scopeExpiresAt,scopeLifetime);}catch{
  throw new AppError('Invalid App data consent expiry','APP_ACTION_INVALID',400);
 }
 if(!Number.isSafeInteger(maxConsentSeconds)||maxConsentSeconds<=0||nominated<=now)
  throw new AppError('Invalid App data consent expiry','APP_ACTION_INVALID',400);
 if(lifetime==='until_revoked'){
  if(!allowUntilRevoked||scope!==Infinity)throw new AppError('Persistent App data consent is unavailable','APP_ACCESS_DENIED',403);
  return Infinity;
 }
 const expiry=Math.min(nominated,scope,now+maxConsentSeconds*1000);
 if(expiry<=now)throw new AppError('App data access ended','APP_ACCESS_DENIED',403);
 return expiry;
}
