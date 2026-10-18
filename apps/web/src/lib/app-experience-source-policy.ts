import type {ExperienceExposureReview,ExperienceExposureStatus} from './app-experience-session';
/** The existing normalized review is display policy, never a substitute for the content route's fresh authority check. */
export function reviewedSourcePolicy(review:Pick<ExperienceExposureReview,'review_digest'|'snapshot'>, exposure:ExperienceExposureStatus,
 session:Readonly<{artifact_digest:string;resource_keys:readonly string[]}>, key:string, current:()=>boolean,
 leaseExposure?:Pick<ExperienceExposureStatus,'exposure_id'|'exposure_epoch'|'review_digest'|'expires_at'>){
 const effective=leaseExposure??exposure;
 if(effective.exposure_id!==exposure.exposure_id||effective.exposure_epoch!==exposure.exposure_epoch||effective.review_digest!==exposure.review_digest)return undefined;
 if(!current()||review.review_digest!==effective.review_digest||review.snapshot.artifact_digest!==session.artifact_digest
   ||!session.resource_keys.includes(key)||!Number.isFinite(Date.parse(effective.expires_at))||Date.parse(effective.expires_at)<=Date.now()
   ||!Number.isFinite(Date.parse(review.snapshot.expires_at))||Date.parse(review.snapshot.expires_at)<=Date.now())return undefined;
 const rows=review.snapshot.resources.filter(row=>row.resource_key===key);
 return rows.length===1&&rows[0]!.allowed_operations.includes('read_one')&&rows[0]!.content_policy?.source?rows[0]!.content_policy:undefined;
}
