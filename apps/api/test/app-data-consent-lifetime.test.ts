import assert from 'node:assert/strict';
import test from 'node:test';
import {appDataConsentExpiry} from '../src/lib/app-data-consent-lifetime.js';
test('durable record consent follows reviewed resource/policy lifetime independently of short access tokens',()=>{
 const now=Date.now(),iso=(offset:number)=>new Date(now+offset).toISOString(),day=86400000;
 assert.equal(appDataConsentExpiry(iso(day),iso(day*2),86400,now),now+day);
 assert.equal(appDataConsentExpiry(iso(day*3),iso(day*2),86400,now),now+day,'declared policy clamps requested duration');
 assert.equal(appDataConsentExpiry(iso(day),iso(3600000),86400,now),now+3600000,'current resource consent is the upper ceiling');
 assert.equal(appDataConsentExpiry(iso(300000),iso(day),86400,now),now+300000,'shorter human request is preserved');
 assert.throws(()=>appDataConsentExpiry(iso(day),iso(-1),86400,now));
 assert.throws(()=>appDataConsentExpiry(iso(-1),iso(day),86400,now));
});
