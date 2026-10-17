import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicImageAddress, publicImageUrl, validMessageImage, fetchPublicMessageImage } from './remote-image-proxy.mjs';
const png = Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,2,0,0,0,2,8,2,0,0,0,0,0,0,0]);
const authority = {recheck:async()=>true};
test('public image endpoint denies alternate/private/special addresses and credentials', () => {
  for (const ip of ['127.0.0.1','10.0.0.1','0.0.0.0','169.254.169.254','100.64.0.1','172.16.0.1','192.168.1.1','192.0.2.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','::1','::ffff:8.8.8.8','fe80::1','fc00::1','2001::1','2001:db8::1','2002:0808:0808::1','3fff::1']) assert.equal(publicImageAddress(ip), false, ip);
  for (const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111']) assert.equal(publicImageAddress(ip), true);
  for (const url of ['http://example.com','https://user:pass@example.com','https://127.1','https://2130706433','https://[::1]','https://example.com:8443','https://example.com./','https://example.com\\@localhost']) assert.throws(() => publicImageUrl(url), /APP_IMAGE_UNAVAILABLE/u, url);
});
test('every DNS answer and redirect is validated, with pinned chosen address and no private fetch', async () => {
  let calls = 0;
  await assert.rejects(fetchPublicMessageImage('https://images.example.test/a', authority, {
    lookup: async () => [{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}],
    request: async () => { calls++; return {media_type:'image/png',bytes:png}; },
  }), /APP_IMAGE_UNAVAILABLE/u); assert.equal(calls, 0);
  await assert.rejects(fetchPublicMessageImage('https://images.example.test/a', authority, {
    lookup: async () => [{address:'8.8.8.8',family:4}],
    request: async () => { calls++; return {redirect:'https://169.254.169.254/latest'}; },
  }), /APP_IMAGE_UNAVAILABLE/u); assert.equal(calls, 1);
  const requests = [];
  const result = await fetchPublicMessageImage('https://images.example.test/a', authority, {
    lookup: async host => { assert.equal(host, 'images.example.test'); return [{address:'8.8.8.8',family:4}]; },
    request: async (url, pinned, signal) => { requests.push(url.href); assert.equal(pinned.address,'8.8.8.8'); assert.equal(signal.aborted,false); return requests.length === 1 ? {redirect:'/final'} : {media_type:'image/png',bytes:png}; },
  });
  assert.equal(result.media_type,'image/png'); assert.deepEqual(requests,['https://images.example.test/a','https://images.example.test/final']);
  let resolutions=0,reboundRequests=0;
  await assert.rejects(fetchPublicMessageImage('https://images.example.test/a',authority,{
    lookup:async()=>[{address:++resolutions===1?'8.8.8.8':'127.0.0.1',family:4}],
    request:async(_url,pinned)=>{assert.equal(pinned.address,'8.8.8.8');reboundRequests++;return{redirect:'/same-host'};},
  }),/APP_IMAGE_UNAVAILABLE/u);
  assert.equal(resolutions,2);assert.equal(reboundRequests,1,'DNS rebinding between redirect hops never reaches the private address');
});
test('raster-only bytes, maximum bytes, cancellation and redirect bounds remain strict', async () => {
  assert.equal(validMessageImage(png, 'image/png'),true);
  assert.equal(validMessageImage(new TextEncoder().encode('<svg>unsafe</svg>'), 'image/svg+xml'),false);
  assert.equal(validMessageImage(new Uint8Array(2097153), 'image/png'),false);
  const huge = png.slice(); new DataView(huge.buffer).setUint32(16,100000); assert.equal(validMessageImage(huge,'image/png'),false);
  const deps={lookup:async()=>[{address:'8.8.8.8',family:4}],request:async()=>({redirect:'/next'})};
  await assert.rejects(fetchPublicMessageImage('https://example.test',authority,deps),/APP_IMAGE_UNAVAILABLE/u);
  await assert.rejects(fetchPublicMessageImage('https://example.test',{...authority,signal:AbortSignal.abort()},deps),/APP_IMAGE_UNAVAILABLE/u);
});

test('fresh authority is mandatory and revocation during DNS or redirect prevents another outbound request', async () => {
 let live=true,calls=0,release;
 const held=new Promise(resolve=>{release=resolve;});
 const loading=fetchPublicMessageImage('https://example.test/a',{recheck:async()=>live},{lookup:async()=>held,request:async()=>{calls++;return{media_type:'image/png',bytes:png};}});
 await new Promise(resolve=>setTimeout(resolve,0));live=false;release([{address:'8.8.8.8',family:4}]);
 await assert.rejects(loading,/APP_IMAGE_UNAVAILABLE/u);assert.equal(calls,0);
 live=true;
 await assert.rejects(fetchPublicMessageImage('https://example.test/a',{recheck:async()=>live},{lookup:async()=>[{address:'8.8.8.8',family:4}],request:async()=>{calls++;live=false;return{redirect:'/next'};}}),/APP_IMAGE_UNAVAILABLE/u);assert.equal(calls,1);
 await assert.rejects(fetchPublicMessageImage('https://example.test/a',{}, {lookup:async()=>[{address:'8.8.8.8',family:4}],request:async()=>{calls++;return{media_type:'image/png',bytes:png};}}),/APP_IMAGE_UNAVAILABLE/u);assert.equal(calls,1);
});
test('returned remote bytes are cleared when post-request authority or raster validation fails',async()=>{
 for(const invalid of [false,true]){
  const bytes=invalid?new Uint8Array(20).fill(4):png.slice();let live=true;
  await assert.rejects(fetchPublicMessageImage('https://example.test/a',{recheck:async()=>live},{lookup:async()=>[{address:'8.8.8.8',family:4}],request:async()=>{if(!invalid)live=false;return {media_type:'image/png',bytes};}}),/APP_IMAGE_UNAVAILABLE/);
  assert.ok([...bytes].every(byte=>byte===0));
 }
});
