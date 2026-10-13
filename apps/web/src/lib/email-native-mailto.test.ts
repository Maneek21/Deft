import test from 'node:test';
import assert from 'node:assert/strict';
import {parseNativeMailto,parseNativeMailtoFragment,nativeMailtoHandlerPath,NativeMailtoError} from './email-native-mailto';

test('email links preserve plus addressing and UTF8 text, with an editable plain compose only',()=>{
 const {content}=parseNativeMailto('mailto:one+tag@example.test?cc=copy%40example.test&bcc=private%40example.test&subject=Caf%C3%A9%20%2B%20notes&body=One%0D%0ATwo');
 assert.equal(content.to,'one+tag@example.test');assert.equal(content.cc,'copy@example.test');assert.equal(content.bcc,'private@example.test');assert.equal(content.subject,'Café + notes');assert.equal(content.body,'One\nTwo');
 assert.equal(content.mode,'compose');assert.equal(content.body_html,'');assert.equal(content.reply_record_id,'');assert.deepEqual(content.attachments,[]);assert.equal(content.from_identity,undefined);
});
test('path and query recipients combine explicitly; duplicates in a field do not duplicate delivery',()=>{
 const {content}=parseNativeMailto('MAILTO:first@example.test?to=second@example.test,first@example.test');assert.equal(content.to,'first@example.test, second@example.test');
 assert.equal(parseNativeMailto('mailto:?subject=Hello').content.to,'');
});
test('untrusted headers cannot nominate sender, files, reply identities or automatic sending',()=>{
 const value=parseNativeMailto('mailto:a@example.test?from=admin%40example.test&attach=file%3A%2F%2Fsecret&send=true&in-reply-to=spoof');
 assert.deepEqual(value.ignoredFields,['from','attach','send','in-reply-to']);assert.equal(value.content.from_identity,undefined);assert.deepEqual(value.content.attachments,[]);assert.equal(value.content.reply_record_id,'');
 assert.equal(nativeMailtoHandlerPath(),'/email#compose=%s');
});
test('malformed encoding, header injection, ambiguous repeats and oversized links fail visibly',()=>{
 for(const input of ['https://example.test','mailto:a@example.test?subject=%0D%0ABcc:x@example.test','mailto:a@example.test?subject=x&Subject=y','mailto:a@example.test?body=%ZZ','mailto:a@example.test#hidden','mailto:Name%20%3Ca@example.test%3E','mailto:a@example.test?body=%00','mailto:a@example.test?subject='+ 'x'.repeat(999),'mailto:a@example.test?body='+ 'x'.repeat(65536)])assert.throws(()=>parseNativeMailto(input),NativeMailtoError,input.slice(0,80));
 const value=parseNativeMailto('mailto:a@example.test?body=%250D%250ABcc%3Ax');assert.equal(value.content.body,'%0D%0ABcc:x');
});

test('browser fragment decodes its transport once and leaves mailto field decoding to the parser',()=>{
 const uri='mailto:one+tag@example.test?body=%250D%250A&subject=Caf%C3%A9';
 const value=parseNativeMailtoFragment('#compose='+encodeURIComponent(uri));
 assert.equal(value?.content.body,'%0D%0A');assert.equal(value?.content.subject,'Café');
 assert.equal(parseNativeMailtoFragment('#other=x'),null);
 assert.throws(()=>parseNativeMailtoFragment('#compose=%ZZ'),NativeMailtoError);
 assert.throws(()=>parseNativeMailtoFragment('#compose='+encodeURIComponent('https://evil.test')),NativeMailtoError);
});
