import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectNativeComposeRaster,validateNativeComposeRaster} from '../src/native-compose-raster.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/wAAAABJRU5ErkJggg==','base64');
const dimensions=(width:number,height:number)=>{const bytes=Buffer.from(png);bytes.writeUInt32BE(width,16);bytes.writeUInt32BE(height,20);return bytes;};
const gif=(width:number,height:number,frames:number)=>{const head=Buffer.alloc(13);head.write('GIF89a');head.writeUInt16LE(width,6);head.writeUInt16LE(height,8);const frame=Buffer.alloc(14);frame[0]=44;frame.writeUInt16LE(width,5);frame.writeUInt16LE(height,7);frame[10]=2;frame[11]=1;frame[12]=0;return Buffer.concat([head,...Array.from({length:frames},()=>frame),Buffer.from([59])]);};
const jpeg=Buffer.alloc(21);jpeg.set([255,216,255,192,0,11,8,0,1,0,1],0);
const webp=Buffer.alloc(30);webp.write('RIFF');webp.write('WEBP',8);webp.write('VP8X',12);
test('fixed pure raster profiles reject arbitrary overrides and retain typed-array/byteoffset bounds',()=>{
 for(const [bytes,type]of [[png,'image/png'],[gif(1,1,1),'image/gif'],[jpeg,'image/jpeg'],[webp,'image/webp']] as const){
  assert.equal(validateNativeComposeRaster(bytes,type,'received'),true);const wrapped=Buffer.concat([Buffer.alloc(9,255),bytes,Buffer.alloc(7)]),slice=new Uint8Array(wrapped.buffer,wrapped.byteOffset+9,bytes.length);
  for(const profile of ['received','outgoing','preview'] as const)assert.equal(validateNativeComposeRaster(slice,type,profile),true);
  for(let length=0;length<12;length++)assert.equal(validateNativeComposeRaster(slice.subarray(0,length),type,'outgoing'),false);
 }
 assert.equal(validateNativeComposeRaster(png,'image/png','arbitrary' as any),false);assert.equal(validateNativeComposeRaster(new DataView(png.buffer),'image/png','outgoing'),false);
 assert.equal(validateNativeComposeRaster(png,'image/svg+xml','preview'),false);
 assert.equal(validateNativeComposeRaster(dimensions(5000,800),'image/png','received'),false);assert.equal(validateNativeComposeRaster(dimensions(5000,800),'image/png','preview'),true);
 for(const [width,height]of [[8193,1],[4001,4000],[0,1]] as const)assert.equal(validateNativeComposeRaster(dimensions(width,height),'image/png','outgoing'),false);
 assert.equal(validateNativeComposeRaster(gif(1,1,32),'image/gif','outgoing'),true);assert.equal(validateNativeComposeRaster(gif(1,1,33),'image/gif','outgoing'),false);
 assert.equal(validateNativeComposeRaster(gif(4000,4000,1),'image/gif','outgoing'),true);assert.equal(validateNativeComposeRaster(gif(4000,4000,2),'image/gif','outgoing'),false);
 assert.deepEqual(inspectNativeComposeRaster(gif(2,3,2),'image/gif','preview'),{width:2,height:3,pixels:12});assert.ok(Object.isFrozen(inspectNativeComposeRaster(png,'image/png','preview')));
 const canvas=gif(1,1,1);canvas.writeUInt16LE(4000,6);canvas.writeUInt16LE(4000,8);assert.equal(inspectNativeComposeRaster(canvas,'image/gif','preview')?.pixels,16_000_000,'Logical canvas also consumes pixel budget');
 const animated=Buffer.from(webp);animated[20]=2;assert.equal(validateNativeComposeRaster(animated,'image/webp','outgoing'),false);
});
test('received old/new scanner equality across retained header/malformed/animated corpus',async()=>{
 const baseline=process.env.EMAIL_RASTER_BASELINE??new URL('./native-received-raster.fixture.mjs',import.meta.url).href;
 const {validMessageImage}=await import(baseline);
 const corpus=[png,jpeg,webp,gif(1,1,1),gif(1,1,32),gif(1,1,33),gif(4000,4000,2),dimensions(4096,1),dimensions(4097,1),dimensions(2000,2000),dimensions(2001,2000),dimensions(0,1),Buffer.alloc(2*1024*1024+1)];
 for(const bytes of [png,jpeg,webp,gif(1,1,1)]){
  for(let length=0;length<bytes.length;length++)corpus.push(bytes.subarray(0,length));
  for(let index=0;index<bytes.length;index++){const changed=Buffer.from(bytes);changed[index]=255;corpus.push(changed);}
 }
 for(const bytes of corpus)for(const type of ['image/png','image/jpeg','image/gif','image/webp','image/svg+xml']){
  assert.equal(validateNativeComposeRaster(bytes,type,'received'),validMessageImage(bytes,type));
  const padded=Buffer.concat([Buffer.alloc(3),bytes,Buffer.alloc(5)]),view=new Uint8Array(padded.buffer,padded.byteOffset+3,bytes.length);
  assert.equal(validateNativeComposeRaster(view,type,'received'),validMessageImage(view,type));
 }
});
