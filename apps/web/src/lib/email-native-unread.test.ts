import assert from 'node:assert/strict';import test from 'node:test';
import {createNativeEmailUnread,nativeUnreadDisplay,nativeUnreadStateDisplay,nativeUnreadScopeKey,parseNativeUnread,type NativeUnreadState} from './email-native-unread';
const meta=(account_id='one')=>({account_id,coverage:'complete',sync_state:'idle',checkpoint_revision:4,observed_at:'2026-10-04T00:00:00.000Z',fresh_until:'2026-10-04T00:01:00.000Z'});
const single={...meta(),folder:'inbox',unread_count:12,cached_unread_count:12};
const unified={folder:'inbox',unread_count:24,cached_unread_count:24,coverage:'complete',accounts:[meta('one'),meta('two')]};
test('real canonical cached Inbox rows are counted instead of falsely returning zero',async()=>{
 const cached=[{account_id:'one',logical_message_id:'same-message',folders:['inbox'],seen:false},{account_id:'two',logical_message_id:'same-message',folders:['inbox'],seen:false}];
 for(const ids of [['one'],['one','two']]){const c=createNativeEmailUnread({accountIds:ids,current:()=>true,change:()=>{},fetch:async path=>{const folder=new URL(path,'https://fixture.test').searchParams.get('folder')!,count=cached.filter(row=>ids.includes(row.account_id)&&row.folders.includes(folder)&&!row.seen).length;return Response.json(ids.length===1?{...single,folder,unread_count:count,cached_unread_count:count}:{...unified,folder,unread_count:count,cached_unread_count:count});}});await c.load();assert.equal(c.snapshot().snapshot?.unread_count,ids.length,'each account/message pair is counted in canonical lowercase Inbox');c.dispose();}
});
test('strict unread scope requires unique bounded owner nominations and pins every unified account',()=>{
 assert.equal(nativeUnreadScopeKey(['two','one']),nativeUnreadScopeKey(['one','two']));assert.equal(parseNativeUnread(single,['one']).unread_count,12);assert.equal(parseNativeUnread(unified,['two','one']).unread_count,24);
 for(const ids of [['one','one'],['bad\naccount'],Array.from({length:51},(_,n)=>String(n))])assert.throws(()=>nativeUnreadScopeKey(ids));
 for(const raw of [{...single,account_id:'foreign'},{...single,credential:'private'},{...single,folder:'all'},{...single,unread_count:-1},{...single,cached_unread_count:11},{...single,coverage:'partial'},{...single,checkpoint_revision:-1},{...single,fresh_until:'bad'}])assert.throws(()=>parseNativeUnread(raw,['one']));
 for(const raw of [{...unified,accounts:[meta('one'),meta('one')]},{...unified,accounts:[meta('one'),meta('foreign')]},{...unified,coverage:'partial'},{...unified,accounts:[{...meta('one'),provider_locator:'private'},meta('two')]}])assert.throws(()=>parseNativeUnread(raw,['one','two']));
});
test('partial or stale cache never supplies an exact badge, while cached count remains accessible',()=>{
 const now=Date.parse('2026-10-04T00:00:10Z');assert.equal(nativeUnreadDisplay(parseNativeUnread(single,['one']),now).count,12);
 const partial=parseNativeUnread({...single,coverage:'partial',unread_count:null},['one']);assert.deepEqual(nativeUnreadDisplay(partial,now).count,null);assert.match(nativeUnreadDisplay(partial,now).text,/12 cached unread/);
 assert.equal(nativeUnreadDisplay(parseNativeUnread(single,['one']),Date.parse('2026-10-04T00:02:00Z')).count,null);assert.equal(nativeUnreadDisplay(parseNativeUnread({...single,observed_at:null},['one']),now).count,null);
 const overflow=parseNativeUnread({...single,unread_count:null,cached_unread_count:null},['one']);assert.equal(nativeUnreadDisplay(overflow,now).count,null);assert.match(nativeUnreadDisplay(overflow,now).text,/unavailable/);
});
test('exact badge expires on its own without waiting for the next poll or publishing after disposal',async()=>{
 let now=Date.parse('2026-10-04T00:00:10Z'),callback:(()=>void)|null=null,delay=0,clears=0;const displays:(number|null)[]=[];
 const c=createNativeEmailUnread({accountIds:['one'],current:()=>true,fetch:async()=>Response.json(single),change:value=>displays.push(nativeUnreadDisplay(value.snapshot,now).count),clock:{now:()=>now,set:(run,wait)=>{callback=run;delay=wait;return 1;},clear:()=>{callback=null;clears++;}}});
 await c.load();assert.equal(displays.at(-1),12);assert.equal(delay,50000);const expired=callback as unknown as ()=>void;callback=null;now+=50000;expired();assert.equal(displays.at(-1),null);assert.equal(callback,null);
 now-=50000;await c.load();assert.equal(displays.at(-1),12);const held=callback as unknown as ()=>void;c.dispose();const before=displays.length;held();assert.equal(displays.length,before);assert.ok(clears>0);
});
test('single/unified endpoints use no-store exact scopes, canonical Inbox and one count-only read',async()=>{
 for(const ids of [['one'],['two','one']]){const calls:string[]=[];const c=createNativeEmailUnread({accountIds:ids,current:()=>true,change:()=>{},fetch:async(path,init)=>{calls.push(path);assert.equal(init.method,'GET');assert.equal(init.cache,'no-store');assert.ok(init.signal);return Response.json(ids.length===1?single:unified);}});await c.load();assert.equal(c.snapshot().snapshot?.cached_unread_count,ids.length===1?12:24);assert.deepEqual(calls,[ids.length===1?'/api/email/accounts/one/unread?folder=inbox':'/api/email/unread?folder=inbox&account_id=one&account_id=two']);c.dispose();}
});
test('empty or revoked account scope never displays a fallback zero or allows late access results',async()=>{
 let calls=0;const empty=createNativeEmailUnread({accountIds:[],current:()=>true,change:()=>{},fetch:async()=>{calls++;return Response.json(single);}});await empty.load();assert.equal(calls,0);empty.dispose();
 let denied:string|null|undefined;const c=createNativeEmailUnread({accountIds:['one'],current:()=>true,change:()=>{},denied:id=>{denied=id;},fetch:async()=>new Response(null,{status:403})});await c.load();assert.equal(c.snapshot().snapshot,null);assert.equal(c.snapshot().denied,true);assert.equal(denied,'one');await c.load();c.dispose();
 const all=createNativeEmailUnread({accountIds:['one','two'],current:()=>true,change:()=>{},denied:id=>{denied=id;},fetch:async()=>new Response(null,{status:403})});await all.load();assert.equal(denied,null,'unified denial does not invent which account lost permission');all.dispose();
});
test('manual revision requests coalesce while held; read-only polling never overlaps or repeats mutations',async()=>{
 let resolve!:(response:Response)=>void,calls=0,inflight=0,max=0;const c=createNativeEmailUnread({accountIds:['one'],current:()=>true,change:()=>{},fetch:async()=>{calls++;inflight++;max=Math.max(max,inflight);if(calls===1)return new Promise<Response>(done=>{resolve=value=>{inflight--;done(value);};});inflight--;return Response.json(single);}});
 const first=c.load();await c.load();await c.load();assert.equal(calls,1);resolve(Response.json(single));await first;await new Promise(done=>setTimeout(done,0));assert.equal(calls,2);assert.equal(max,1);c.dispose();
});
test('held old SID response and disposed account controller cannot publish counts into new scope',async()=>{
 let live=true,resolve!:(response:Response)=>void;const values:unknown[]=[];const c=createNativeEmailUnread({accountIds:['one'],current:()=>live,change:value=>values.push(value),fetch:async()=>new Promise<Response>(done=>{resolve=done;})});const request=c.load(),before=values.length;live=false;c.dispose();resolve(Response.json(single));await request;assert.equal(values.length,before);assert.equal(c.snapshot().snapshot,null);
});
test('retry failures retain the last verified snapshot without claiming a fresh exact total',async()=>{
 let response=Response.json(single);const c=createNativeEmailUnread({accountIds:['one'],current:()=>true,change:()=>{},fetch:async()=>response});await c.load();assert.equal(c.snapshot().snapshot?.unread_count,12);
 for(const next of [new Response(null,{status:503}),Response.json({...single,provider_locator:'private'}),new Response('x'.repeat(32769)),new Response('bad json')]){response=next;await c.load();assert.equal(c.snapshot().snapshot?.cached_unread_count,12);assert.match(c.snapshot().notice,/unavailable/);}c.dispose();
});
test('loading, failed retry, cached count and recovered exact count have distinct truthful displays',async()=>{
 const now=Date.parse('2026-10-04T00:00:10Z'),states:NativeUnreadState[]=[];let response:Response|Promise<Response>=Response.json(single),release!:(value:Response)=>void;
 const c=createNativeEmailUnread({accountIds:['one'],current:()=>true,change:value=>states.push(value),fetch:async()=>response,clock:{now:()=>now,set:()=>1,clear:()=>{}}});
 await c.load();assert.equal(nativeUnreadStateDisplay(c.snapshot(),now).count,12);
 response=new Response(null,{status:503});await c.load();assert.equal(nativeUnreadStateDisplay(c.snapshot(),now).count,null);assert.match(nativeUnreadStateDisplay(c.snapshot(),now).text,/12 cached unread.*update unavailable/);
 response=new Promise(resolve=>{release=resolve;});const retry=c.load();assert.equal(nativeUnreadStateDisplay(states.at(-1)!,now).count,null,'a retry does not restore an exact badge from the failed snapshot');assert.equal(states.at(-1)!.snapshot?.cached_unread_count,12);
 release(Response.json(single));await retry;assert.equal(nativeUnreadStateDisplay(c.snapshot(),now).count,12);assert.equal(c.snapshot().notice,'');
 assert.match(nativeUnreadStateDisplay(null,now).text,/Checking/);assert.match(nativeUnreadStateDisplay({...c.snapshot(),snapshot:null,busy:false,notice:'Unavailable'},now).text,/unavailable/);c.dispose();
});
test('revocation after a known snapshot clears cache and stops retrying until scope replacement',async()=>{
 for(const status of [401,403]){let calls=0;const c=createNativeEmailUnread({accountIds:['one'],current:()=>true,change:()=>{},fetch:async()=>++calls===1?Response.json(single):new Response(null,{status})});await c.load();assert.equal(c.snapshot().snapshot?.cached_unread_count,12);await c.load();assert.equal(c.snapshot().snapshot,null);assert.equal(nativeUnreadStateDisplay(c.snapshot()).count,null);assert.match(nativeUnreadStateDisplay(c.snapshot()).text,/access changed/i);await c.load();assert.equal(calls,2);c.dispose();}
});
