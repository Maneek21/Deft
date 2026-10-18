import assert from 'node:assert/strict';import test from 'node:test';
import {parseExperienceDataPresentation} from './app-experience-data-presentation';
const scope={exposure_id:'11111111-1111-4111-8111-111111111111',exposure_epoch:1},expiry=new Date(Date.now()+60000).toISOString(),ref='a'.repeat(64);
const value={format:'html',content:'<p>Exact <img src="deft-image:'+ref+'"></p>',plain_text:'Exact',truncated:false,headers:[{label:'Subject',value:'Native subject'}],images:[{image_ref:'sha256:'+ref,kind:'cid',index:0,alt:'PNG'}],source_digest:'sha256:'+'b'.repeat(64),reply_seed_unavailable:[]};
test('public resource presentation preserves frozen HTML93 bytes and maps only signed image ref prefix',()=>{
 const parsed=parseExperienceDataPresentation(value,scope,expiry);assert.equal(parsed.presentation.content,value.content);assert.equal(parsed.presentation.images[0].image_ref,ref);assert.equal(Object.hasOwn(parsed.presentation,'source_digest'),false);
 assert.equal(value.images[0].image_ref,'sha256:'+ref);
});
test('full installed exposure contributes only the exact source scope pair',()=>{
 const exposure={...scope,exposure_digest:'sha256:'+'c'.repeat(64),grant_id:'22222222-2222-4222-8222-222222222222',expires_at:expiry};
 const parsed=parseExperienceDataPresentation(value,exposure,expiry);
 assert.equal(parsed.presentation.content,value.content);assert.equal(parsed.expires_at,expiry);
 assert.throws(()=>parseExperienceDataPresentation(value,{...exposure,exposure_epoch:0},'expired'));
});
test('new source transport extras are validated and unknown presentation/source authority fields deny',()=>{
 for(const changed of [{...value,source_digest:'raw'},{...value,reply_seed_unavailable:['x'.repeat(201)]},{...value,provider_url:'private'},{...value,images:[{...value.images[0],image_ref:ref}]}])assert.throws(()=>parseExperienceDataPresentation(changed,scope,expiry));
});
