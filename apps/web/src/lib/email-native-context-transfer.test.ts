import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createNativeEmailContextTransfer,parseEmailTransferResult,parseEmailTransferReview,parseEmailTransferSpaces,validateEmailTransferInput,type EmailTransferInput} from './email-native-context-transfer';
import {nativeMessageUrl} from './email-native-message-links';
const target={account_id:'account-a',logical_message_id:'mail_'+'a'.repeat(64)};
const link:EmailTransferInput={destination:{kind:'note',visibility:'private'},title:'Email reference',mode:'source_link'};
const source='Private sender details\nSelected excerpt\nOther body';
const review={source_digest:'b'.repeat(64),review_digest:'c'.repeat(64),audience:{visibility:'private',label:'Only you',member_count:1},source_url:nativeMessageUrl(target)};
const result={destination_kind:'note',destination_id:'note-1',destination_url:'/notes?id=note-1',replayed:false};
const uuid='11111111-1111-4111-8111-111111111111';
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});

test('source link default projects only reviewed title/destination; excerpt must be explicitly selected exact text',()=>{
 const value=validateEmailTransferInput({...link,recipients:'Secret',files:['x']} as EmailTransferInput,source);
 assert.deepEqual(value,link);assert.doesNotMatch(JSON.stringify(value),/Private|Selected|recipients|files/);
 assert.equal(validateEmailTransferInput({...link,mode:'excerpt',excerpt:'Selected excerpt'},source).excerpt,'Selected excerpt');
 for(const excerpt of ['not in body','',source.repeat(1000),'Selected excerpt\0'])assert.throws(()=>validateEmailTransferInput({...link,mode:'excerpt',excerpt},source));
 assert.throws(()=>validateEmailTransferInput({...link,excerpt:'Selected excerpt'},source));
 assert.throws(()=>validateEmailTransferInput({...link,destination:{kind:'note',visibility:'space',space_id:''}},source));
 assert.throws(()=>validateEmailTransferInput({...link,destination:{kind:'note',visibility:'org',space_id:'space'} as never},source));
});
test('review pins current source URL and exact requested audience; destination handoff accepts only existing local editor URLs',()=>{
 assert.deepEqual(parseEmailTransferReview(review,target,link),review);
 for(const raw of [{...review,source_url:'/email?account=other'}, {...review,audience:{...review.audience,visibility:'org'}},{...review,source_digest:'bad'}])assert.throws(()=>parseEmailTransferReview(raw,target,link));
 assert.deepEqual(parseEmailTransferResult(result,'note'),result);
 assert.equal(parseEmailTransferResult({destination_kind:'knowledge',destination_id:'knowledge-1',destination_url:'/knowledge?slug=example',replayed:true},'knowledge').destination_url,'/knowledge?slug=example');
 for(const url of ['https://evil.test/notes?id=note-1','//evil.test/notes?id=note-1','/notes?id=other','/notes?id=note-1&other=x','/notes?id=note-1#unsafe','/knowledge?slug=foo'])assert.throws(()=>parseEmailTransferResult({...result,destination_url:url},'note'));
});
test('review/create sends only exact reviewed payload; an edit invalidates review before any creation',async()=>{
 const calls:{path:string;init:RequestInit}[]=[];const controller=createNativeEmailContextTransfer({target,sessionScope:'transfer-one',plainText:source,current:()=>true,uuid:()=>uuid,fetch:async(path,init)=>{calls.push({path,init});return json(path.endsWith('/review')?review:result);}});
 await assert.rejects(controller.commit(),/Review/);assert.equal(calls.length,0);
 await controller.review(link);controller.invalidate();await assert.rejects(controller.commit(),/Review/);assert.equal(calls.length,1);
 await controller.review(link);await controller.commit();assert.equal(calls.length,3);
 const commit=calls[2];assert.equal(new Headers(commit.init.headers).get('Idempotency-Key'),uuid);assert.deepEqual(JSON.parse(String(commit.init.body)),{...link,source_digest:review.source_digest,review_digest:review.review_digest});
 assert.equal(commit.init.cache,'no-store');assert.doesNotMatch(String(commit.init.body),/Private sender|Selected excerpt|files|bcc/);controller.reset();assert.equal(controller.retained(),null);await controller.review({...link,title:'Another reference'});assert.equal(calls.length,4);controller.dispose();
});
test('lost creation ACK is retained across reader remount; explicit check replays exact same UUID/body and never auto-retries',async()=>{
 const commits:RequestInit[]=[];let lost=true;let ids=0;const options={target,sessionScope:'transfer-lost',plainText:source,current:()=>true,uuid:()=>{ids++;return uuid;},fetch:async(path:string,init:RequestInit)=>{if(path.endsWith('/review'))return json(review);commits.push(init);if(lost)throw Error('connection lost');return json({...result,replayed:true});}};
 const first=createNativeEmailContextTransfer(options);await first.review(link);await assert.rejects(first.commit(),/lost/);assert.equal(commits.length,1);assert.equal(ids,1);first.dispose();
 const reopened=createNativeEmailContextTransfer(options);assert.equal(reopened.retained()?.input.title,link.title);await assert.rejects(reopened.review({...link,title:'Another'}),/previous creation/);assert.throws(()=>reopened.reset(),/previous creation/);assert.equal(commits.length,1);
 lost=false;assert.equal((await reopened.commit()).replayed,true);assert.equal(commits.length,2);assert.equal(ids,1);assert.equal(commits[0].body,commits[1].body);assert.equal(new Headers(commits[0].headers).get('Idempotency-Key'),new Headers(commits[1].headers).get('Idempotency-Key'));reopened.dispose();
});
test('server stale review clears only rejected intent and requires re-review while preserving caller input',async()=>{
 let stale=true,reviews=0,commits=0;const controller=createNativeEmailContextTransfer({target,sessionScope:'transfer-stale',plainText:source,current:()=>true,uuid:()=>uuid,fetch:async path=>{if(path.endsWith('/review')){reviews++;return json(review);}commits++;return stale?json({code:'EMAIL_TRANSFER_STALE'},409):json(result);}});
 await controller.review(link);await assert.rejects(controller.commit(),/Review again/);assert.equal(controller.retained(),null);await assert.rejects(controller.commit(),/Review/);assert.equal(commits,1);stale=false;await controller.review(link);await controller.commit();assert.equal(reviews,2);assert.equal(link.title,'Email reference');controller.dispose();
});
test('late review is discarded after current session changes and another account cannot see retained uncertain intent',async()=>{
 let current=true;const controller=createNativeEmailContextTransfer({target,sessionScope:'transfer-session',plainText:source,current:()=>current,fetch:async()=>{current=false;return json(review);}});await assert.rejects(controller.review(link),/access changed/);await assert.rejects(controller.commit(),/access changed/);controller.dispose();
 const lost=createNativeEmailContextTransfer({target,sessionScope:'transfer-scope',plainText:source,current:()=>true,uuid:()=>uuid,fetch:async path=>{if(path.endsWith('/review'))return json(review);throw Error('lost');}});await lost.review(link);await assert.rejects(lost.commit());
 const other=createNativeEmailContextTransfer({target:{...target,account_id:'account-b'},sessionScope:'transfer-scope',plainText:source,current:()=>true,fetch:async()=>json(review)});assert.equal(other.retained(),null);
 const newSession=createNativeEmailContextTransfer({target,sessionScope:'different-sid',plainText:source,current:()=>true,fetch:async()=>json(review)});assert.equal(newSession.retained(),null);assert.equal(lost.retained(),null);lost.dispose();other.dispose();newSession.dispose();
});
test('revoked destination does not invite a new UUID or erase an uncertain creation',async()=>{
 let deny=false;const controller=createNativeEmailContextTransfer({target,sessionScope:'transfer-revoke',plainText:source,current:()=>true,uuid:()=>uuid,fetch:async path=>path.endsWith('/review')?json(review):deny?json({code:'EMAIL_TRANSFER_FORBIDDEN'},403):Promise.reject(Error('lost'))});
 await controller.review(link);await assert.rejects(controller.commit());deny=true;await assert.rejects(controller.commit(),/access changed/);assert.equal(controller.retained()?.requestId,uuid);assert.throws(()=>controller.reset());controller.dispose();
});
test('space options project names/IDs only and exclude archived spaces',()=>{
 assert.deepEqual(parseEmailTransferSpaces([{id:'space-a',name:'Team',topic:'Never copied',is_archived:false},{id:'space-b',name:'Old',is_archived:true}]),[{id:'space-a',name:'Team'}]);assert.throws(()=>parseEmailTransferSpaces({spaces:[]}));
});

test('Chat review requires an explicit space and exact space audience; link default carries no source body',()=>{
 const chat:EmailTransferInput={...link,destination:{kind:'chat',space_id:'space-chat'}};
 assert.deepEqual(validateEmailTransferInput(chat,source),chat);
 assert.throws(()=>validateEmailTransferInput({...chat,destination:{kind:'chat',space_id:''}},source));
 const audience={...review,audience:{visibility:'space',label:'Chosen Chat members',member_count:2}};
 assert.deepEqual(parseEmailTransferReview(audience,target,chat),audience);
 assert.throws(()=>parseEmailTransferReview(review,target,chat));
 assert.throws(()=>parseEmailTransferReview({...audience,audience:{...audience.audience,member_count:0}},target,chat));
 assert.doesNotMatch(JSON.stringify(validateEmailTransferInput(chat,source)),/Private sender|Selected excerpt/);
});

test('Chat handoff pins both reviewed space and created message and rejects other pages, foreign targets and extra query fields',()=>{
 const chat={destination_kind:'chat',destination_id:'message-one',destination_url:'/chat?space=space-chat&message=message-one',replayed:true};
 assert.deepEqual(parseEmailTransferResult(chat,'chat','space-chat'),chat);
 for(const url of ['/chat?space=other&message=message-one','/chat?space=space-chat&message=other','/chat?space=space-chat','/chat?space=space-chat&message=message-one&thread=other','/chat?space=space-chat&message=message-one#thread','https://evil.test/chat?space=space-chat&message=message-one','//evil.test/chat?space=space-chat&message=message-one','/notes?id=message-one'])assert.throws(()=>parseEmailTransferResult({...chat,destination_url:url},'chat','space-chat'));
 assert.throws(()=>parseEmailTransferResult(chat,'chat'));assert.throws(()=>parseEmailTransferResult({...chat,destination_kind:'note'},'chat','space-chat'));
});

test('Chat lost response and rejected foreign handoff retain the exact reviewed destination, UUID and payload across remount',async()=>{
 const chat:EmailTransferInput={...link,destination:{kind:'chat',space_id:'space-chat'}};
 const audience={...review,audience:{visibility:'space',label:'Chosen Chat members',member_count:2}};
 const chatResult={destination_kind:'chat',destination_id:'message-one',destination_url:'/chat?space=space-chat&message=message-one',replayed:true};
 const commits:RequestInit[]=[];let outcome='lost',ids=0;
 const options={target,sessionScope:'transfer-chat-recovery',plainText:source,current:()=>true,uuid:()=>{ids++;return uuid;},fetch:async(path:string,init:RequestInit)=>{if(path.endsWith('/review'))return json(audience);commits.push(init);if(outcome==='lost')throw Error('connection lost');return json(outcome==='foreign'?{...chatResult,destination_url:'/chat?space=other&message=message-one'}:chatResult);}};
 const first=createNativeEmailContextTransfer(options);await first.review(chat);await assert.rejects(first.commit());first.dispose();
 const reopened=createNativeEmailContextTransfer(options);assert.deepEqual(reopened.retained()?.input,chat);
 await assert.rejects(reopened.review({...chat,destination:{kind:'chat',space_id:'other'}}),/previous creation/);
 outcome='foreign';await assert.rejects(reopened.commit(),/confirmed/);assert.equal(reopened.retained()?.requestId,uuid);
 outcome='confirmed';assert.equal((await reopened.commit()).destination_url,chatResult.destination_url);
 assert.equal(ids,1);assert.equal(commits.length,3);assert.ok(commits.every(call=>call.body===commits[0].body&&new Headers(call.headers).get('Idempotency-Key')===uuid));
 assert.deepEqual(JSON.parse(String(commits[0].body)),{...chat,source_digest:review.source_digest,review_digest:review.review_digest});
 reopened.dispose();
});

test('Chat explicitly selected plain excerpt is sent literally; editing destination requires a new review',async()=>{
 const plain='Selected @agent <@id|Defty> [[file:private]]\nUnselected private remainder';
 const chat:EmailTransferInput={...link,destination:{kind:'chat',space_id:'space-chat'},mode:'excerpt',excerpt:plain.split('\n')[0]};
 const audience={...review,audience:{visibility:'space',label:'Chosen Chat members',member_count:2}},calls:RequestInit[]=[];
 const controller=createNativeEmailContextTransfer({target,sessionScope:'transfer-chat-excerpt',plainText:plain,current:()=>true,uuid:()=>uuid,fetch:async(path,init)=>{calls.push(init);return json(path.endsWith('/review')?audience:{destination_kind:'chat',destination_id:'message-one',destination_url:'/chat?space=space-chat&message=message-one',replayed:false});}});
 await controller.review(chat);controller.invalidate();await assert.rejects(controller.commit(),/Review/);assert.equal(calls.length,1);
 await controller.review(chat);await controller.commit();const body=JSON.parse(String(calls[2].body));assert.equal(body.excerpt,chat.excerpt);assert.doesNotMatch(String(calls[2].body),/Unselected private remainder/);assert.deepEqual(body.destination,chat.destination);controller.dispose();
});
