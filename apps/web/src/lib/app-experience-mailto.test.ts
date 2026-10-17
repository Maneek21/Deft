import test from 'node:test';
import assert from 'node:assert/strict';
import {parseExperienceMailto,parseExperienceMailtoFragment,ExperienceMailtoError} from './app-experience-mailto';

test('generic mailto intake is inert, preserves UTF8, plus addresses and body whitespace',()=>{
 const value=parseExperienceMailto('mailto:one+tag@example.test?cc=copy%40example.test&bcc=private%40example.test&subject=Caf%C3%A9%20%2B%20notes&body=One%0D%0A%09Two%0A%0A');
 assert.deepEqual(value,{to:'one+tag@example.test',cc:'copy@example.test',bcc:'private@example.test',subject:'Café + notes',plain:'One\n\tTwo\n\n',ignored_fields:[]});
 assert.deepEqual(Object.keys(value).sort(),['bcc','cc','ignored_fields','plain','subject','to']);
});
test('sender, file, Send and reply headers are visible ignored names, never authority',()=>{
 const value=parseExperienceMailto('mailto:a@example.test?from=admin%40example.test&attach=file%3A%2F%2Fsecret&send=true&in-reply-to=spoof');
 assert.deepEqual(value.ignored_fields,['from','attach','send','in-reply-to']);assert.equal(value.plain,'');
});
test('ambiguous duplicate headers, injection, malformed encoding and budget overflow deny',()=>{
 for(const raw of ['https://example.test','mailto:a@example.test?subject=%0D%0ABcc:x@example.test','mailto:a@example.test?subject=x&Subject=y','mailto:a@example.test?body=%ZZ','mailto:a@example.test#hidden','mailto:Name%20%3Ca@example.test%3E','mailto:a@example.test?body=%00','mailto:a@example.test?subject='+'x'.repeat(999),'mailto:a@example.test?body='+'x'.repeat(65536), 'mailto:'+Array.from({length:33},(_,i)=>`a${i}@example.test`).join(',')])assert.throws(()=>parseExperienceMailto(raw),ExperienceMailtoError,raw.slice(0,80));
});
test('transport is decoded once and field decoding never expands embedded injection twice',()=>{
 const uri='mailto:one+tag@example.test?body=%250D%250ABcc%3Ax&subject=Caf%C3%A9';
 assert.equal(parseExperienceMailtoFragment('#compose='+encodeURIComponent(uri))?.plain,'%0D%0ABcc:x');
 assert.equal(parseExperienceMailtoFragment('#compose='+encodeURIComponent(uri))?.subject,'Café');
 assert.equal(parseExperienceMailtoFragment('#other=x'),null);
 assert.throws(()=>parseExperienceMailtoFragment('#compose=%ZZ'),ExperienceMailtoError);
 assert.throws(()=>parseExperienceMailtoFragment('#compose='+'x'.repeat(196620)),ExperienceMailtoError);
});
test('path and query add bounded deduplicated recipients without choosing any account',()=>{
 assert.equal(parseExperienceMailto('MAILTO:first@example.test?to=second@example.test,first@example.test').to,'first@example.test, second@example.test');
 assert.equal(parseExperienceMailto('mailto:?subject=Hello').to,'');
});
