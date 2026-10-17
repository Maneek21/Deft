import {parseSourceView,type SourcePresentation} from './app-experience-source-view';
/** Translate only documented public transport metadata. Frozen HTML93 content
 * and raw image nominations remain unchanged; no indexed-source fallback. */
export function parseExperienceDataPresentation(presentation:Record<string,unknown>,scope:{exposure_id:string;exposure_epoch:number},expires_at:string):{presentation:SourcePresentation;expires_at:string}{
 const {source_digest,reply_seed_unavailable,...body}=presentation;
 if(source_digest!==undefined&&(typeof source_digest!=='string'||!/^sha256:[a-f0-9]{64}$/u.test(source_digest)))throw Error('Source digest unavailable');
 if(reply_seed_unavailable!==undefined&&(!Array.isArray(reply_seed_unavailable)||reply_seed_unavailable.length>32||reply_seed_unavailable.some(item=>typeof item!=='string'||item.length>200)))throw Error('Source reply metadata unavailable');
 if(!Array.isArray(body.images))throw Error('Source images unavailable');const images=body.images.map((image:unknown)=>{if(!image||typeof image!=='object'||!('image_ref'in image)||typeof image.image_ref!=='string'||!/^sha256:[a-f0-9]{64}$/u.test(image.image_ref))throw Error('Image reference unavailable');return {...image,image_ref:image.image_ref.slice(7)};});
 const sourceScope={exposure_id:scope.exposure_id,exposure_epoch:scope.exposure_epoch};
 const parsed=parseSourceView({...sourceScope,expires_at,presentation:{...body,images}},sourceScope);if(!parsed.presentation)throw Error('Source unavailable');return {presentation:parsed.presentation,expires_at:parsed.expires_at};
}
