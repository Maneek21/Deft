import {AppError} from './app-errors.js';

/** Durable human consent is reviewed against resource authority and the
 * admitted policy duration. Each invocation separately checks current access. */
export function appDataConsentExpiry(requested:string,scopeExpiresAt:string,maxConsentSeconds:number,now=Date.now()){
 const nominated=Date.parse(requested),scope=Date.parse(scopeExpiresAt);
 if(!Number.isFinite(nominated)||!Number.isFinite(scope)||!Number.isSafeInteger(maxConsentSeconds)||maxConsentSeconds<=0||nominated<=now)
  throw new AppError('Invalid App data consent expiry','APP_ACTION_INVALID',400);
 const expiry=Math.min(nominated,scope,now+maxConsentSeconds*1000);
 if(expiry<=now)throw new AppError('App data access ended','APP_ACCESS_DENIED',403);
 return expiry;
}
