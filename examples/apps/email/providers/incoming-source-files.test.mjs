import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectEmailSourceFiles} from './incoming-source-files.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
const part=(name,type,bytes,extra='')=>`--bound\r\nContent-Type: ${type}\r\nContent-Disposition: attachment; filename="${name}"\r\n${extra}Content-Transfer-Encoding: base64\r\n\r\n${bytes.toString('base64')}\r\n`;
const source=(parts=[],html='<p>Controlled body</p>')=>Buffer.from('From: sender@example.test\r\nTo: owner@example.test\r\nSubject: Controlled source\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=bound\r\n\r\n--bound\r\nContent-Type: text/html; charset=utf-8\r\n\r\n'+html+'\r\n'+parts.join('')+'--bound--\r\n');
test('exact source inventories text, safe CID raster and unsupported downloads without fetching images',async()=>{
 const bytes=source([part('../report.txt','text/plain',Buffer.from('Exact text')),part('logo.png','image/png',png,'Content-ID: <logo>\r\n'),part('unsafe.html','text/html',Buffer.from('<script>attack()</script>'))],'<table width="600"><tr><td>News</td></tr></table><img src="cid:logo"><img src="https://public.example.test/photo"><img src="http://untrusted.test/">');
 let fetches=0;const output=await inspectEmailSourceFiles(bytes,{presentation:true,fetchRemote:async()=>{fetches++;throw Error();}});
 assert.equal(output.files.length,3);assert.equal(output.files[0].filename,'.._report.txt');assert.equal(output.files[0].preview,'text');assert.equal(output.files[1].preview,'image');assert.equal(output.files[2].preview,'unsupported');assert.equal(fetches,0);
 assert.deepEqual(output.presentation.images.map(row=>row.kind),['cid','remote']);assert.ok(output.presentation.content.includes('deft-image:'));assert.equal(output.presentation.content.includes('https://public.example.test'),false);
 const downloaded=await inspectEmailSourceFiles(bytes,{file_ref:output.files[0].file_ref});assert.equal(Buffer.from(downloaded.bytes).toString(),'Exact text');
 const image=await inspectEmailSourceFiles(bytes,{image_ref:output.presentation.images[0].image_ref});assert.deepEqual(Buffer.from(image.bytes),png);image.bytes.fill(0);
 await assert.rejects(inspectEmailSourceFiles(source([part('different.txt','text/plain',Buffer.from('Changed'))]),{file_ref:output.files[0].file_ref}));
 await assert.rejects(inspectEmailSourceFiles(bytes,{file_ref:'f'.repeat(64)}));
});
test('MIME/source/output expansion limits reject honestly and selected presentation is explicitly truncated',async()=>{
 await assert.rejects(inspectEmailSourceFiles(new Uint8Array(8388609)));
 await assert.rejects(inspectEmailSourceFiles(Buffer.from(Array.from({length:257},()=> '--deep\r\n').join(''))));
 const large=await inspectEmailSourceFiles(source([],`<p>${'é'.repeat(180000)}</p>`),{presentation:true});assert.equal(large.presentation.truncated,true);assert.ok(Buffer.byteLength(large.presentation.content)<=262144);
 const empty=await inspectEmailSourceFiles(Buffer.from('From: sender@example.test\r\n\r\nNo files.'));assert.deepEqual(empty.files,[]);
});
test('attachment overflow preserves the body and first32 stable nominations with an explicit omitted count',async()=>{
 const bytes=source(Array.from({length:33},(_,i)=>part(`file${i}`,'text/plain',Buffer.from('x'))));
 const output=await inspectEmailSourceFiles(bytes,{presentation:true});assert.equal(output.files.length,32);assert.equal(output.omitted_file_count,1);assert.match(output.presentation.content,/Controlled body/);
 const first=await inspectEmailSourceFiles(bytes,{file_ref:output.files[0].file_ref});assert.equal(Buffer.from(first.bytes).toString(),'x');assert.equal(first.omitted_file_count,1);
 const {createHash}=await import('node:crypto'),hash=v=>createHash('sha256').update(v).digest('hex');
 await assert.rejects(inspectEmailSourceFiles(bytes,{file_ref:hash(`${hash(bytes)}:file:32`)}));
});
test('complex HTML falls back to inert bounded plain text without image nominations or forbidden text',async()=>{
 const html='<script>private-script</script><style>private-style</style><template>private-template</template><noscript>private-noscript</noscript><table><tr>'+'<td>cell</td>'.repeat(5000)+'</tr></table><img src="https://public.example.test/image">';
 const output=await inspectEmailSourceFiles(source([],html),{presentation:true});assert.equal(output.presentation.format,'plain');assert.equal(output.presentation.rendering_fallback,'plain_text');assert.deepEqual(output.presentation.images,[]);
 assert.doesNotMatch(output.presentation.content,/private-|<td>|https:/);assert.match(output.presentation.content,/cell/);assert.equal(output.presentation.truncated,false);
 await assert.rejects(inspectEmailSourceFiles(source([],html),{image_ref:'f'.repeat(64)}));
 let checks=0;await assert.rejects(inspectEmailSourceFiles(source([],html),{presentation:true,check:async()=>{if(++checks===3)throw Error('Revoked');}}),/Revoked/);
});
test('plain alternative loss contributes to truthful truncation even with a short complete HTML alternative',async()=>{
 const bytes=Buffer.from('MIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=alt\r\n\r\n--alt\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n'+'x'.repeat(300000)+'TAIL\r\n--alt\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Short HTML</p>\r\n--alt--\r\n');
 const output=await inspectEmailSourceFiles(bytes,{presentation:true});assert.equal(output.presentation.truncated,true);assert.equal(Buffer.byteLength(output.presentation.plain_text),262144);assert.equal(output.presentation.plain_text.includes('TAIL'),false);
});
test('omitted duplicate CID cannot make a retained image appear uniquely authorized',async()=>{
 const parts=[part('first.png','image/png',png,'Content-ID: <duplicate>\r\n'),...Array.from({length:31},(_,i)=>part(`file${i}`,'text/plain',Buffer.from('x'))),part('last.png','image/png',png,'Content-ID: <duplicate>\r\n')];
 const output=await inspectEmailSourceFiles(source(parts,'<img src="cid:duplicate"><p>Body</p>'),{presentation:true});assert.equal(output.files.length,32);assert.equal(output.omitted_file_count,1);assert.deepEqual(output.presentation.images,[]);assert.match(output.presentation.content,/Body/);
});
test('plain fallback node budget reports loss while retaining a bounded readable prefix',async()=>{
 const output=await inspectEmailSourceFiles(source([],'<div>'+'<i>x</i>'.repeat(24000)+'</div>'),{presentation:true});assert.equal(output.presentation.format,'plain');assert.equal(output.presentation.rendering_fallback,'plain_text');assert.equal(output.presentation.truncated,true);assert.match(output.presentation.content,/^x+/);assert.ok(Buffer.byteLength(output.presentation.content)<=262144);assert.deepEqual(output.presentation.images,[]);
});
test('spoofed MIME, oversized image dimensions, duplicate CID and malicious source do not receive inline authority',async()=>{
 const giant=Buffer.from(png);giant.writeUInt32BE(100000,16);
 const output=await inspectEmailSourceFiles(source([part('script.png','image/png',Buffer.from('<svg onload="attack()"></svg>')),part('large.png','image/png',giant),part('a.png','image/png',png,'Content-ID: <duplicate>\r\n'),part('b.png','image/png',png,'Content-ID: <duplicate>\r\n')],'<img src="cid:duplicate"><img src="javascript:attack()"><iframe src="https://never-fetch.test/"></iframe>'),{presentation:true});
 assert.equal(output.files[0].preview,'unsupported');assert.equal(output.files[1].preview,'unsupported');assert.deepEqual(output.presentation.images,[]);assert.equal(output.presentation.content.includes('javascript:attack()'),false);
});
test('revocation at parser final boundary withholds every selected byte',async()=>{
 let checks=0;await assert.rejects(inspectEmailSourceFiles(source([part('a.txt','text/plain',Buffer.from('secret'))]),{check:async()=>{if(++checks===3)throw Error('Revoked');}}));assert.equal(checks,3);
});

const htmlOnly=html=>Buffer.from('MIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n'+html);
const alternative=(plain,html)=>Buffer.from('MIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=alt\r\n\r\n--alt\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n'+plain+'\r\n--alt\r\nContent-Type: text/html; charset=utf-8\r\n\r\n'+html+'\r\n--alt--\r\n');
const table=()=>'<table><tr><th>Label</th><th>Value</th></tr>'+Array.from({length:2500},(_,i)=>`<tr><td>Label${i}</td><td>Value${i}</td></tr>`).join('')+'</table>';
test('HTML-only MIME keeps a readable plain representation and complex table cell separation',async()=>{
 for(const profile of ['native','legacy']){
  const simple=await inspectEmailSourceFiles(htmlOnly('<p>Visible body</p>'),{presentation:true,profile});assert.equal(simple.presentation.format,'html');assert.equal(simple.presentation.plain_text,'Visible body\n');
  const complex=await inspectEmailSourceFiles(htmlOnly(table()),{presentation:true,profile});assert.equal(complex.presentation.format,'plain');assert.equal(complex.presentation.rendering_fallback,'plain_text');assert.match(complex.presentation.content,/^Label\tValue\t\nLabel0\tValue0\t\nLabel1\tValue1/);assert.match(complex.presentation.content,/Label2499\tValue2499/);assert.equal(complex.presentation.content,complex.presentation.plain_text);assert.equal(complex.presentation.truncated,false);
 }
});
test('empty and whitespace-only MIME alternatives recover HTML but preserve meaningful plain exactly',async()=>{
 for(const plain of ['', ' \t\n  ']){const output=await inspectEmailSourceFiles(alternative(plain,table()),{presentation:true});assert.match(output.presentation.content,/Label0\tValue0/);assert.equal(output.presentation.truncated,false);}
 const preferred='  Preferred plain body\nLine two\tend  ';
 const output=await inspectEmailSourceFiles(alternative(preferred,table()),{presentation:true});assert.equal(output.presentation.content,preferred);assert.equal(output.presentation.plain_text,preferred);assert.equal(output.presentation.truncated,false);
});
test('plain-only whitespace is preserved when there is no HTML to recover',async()=>{
 const output=await inspectEmailSourceFiles(Buffer.from('MIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\n \t \r\n'),{presentation:true});assert.equal(output.presentation.content,' \t \n');assert.equal(output.presentation.plain_text,' \t \n');
});
test('recovered HTML-only fallback remains inert and never fetches remote images',async()=>{
 const html='<script>private-script</script><style>private-style</style><template>private-template</template><noscript>private-noscript</noscript>'+table()+'<img src="https://public.example.test/never-fetch">';let fetches=0;
 const output=await inspectEmailSourceFiles(htmlOnly(html),{presentation:true,fetchRemote:async()=>{fetches++;throw Error('Must not fetch');}});assert.match(output.presentation.content,/Label0\tValue0/);assert.doesNotMatch(output.presentation.content,/private-|<[^>]+>|https:/);assert.deepEqual(output.presentation.images,[]);assert.equal(fetches,0);
 let checks=0;await assert.rejects(inspectEmailSourceFiles(htmlOnly(html),{presentation:true,check:async()=>{if(++checks===3)throw Error('Revoked');}}),/Revoked/);assert.equal(checks,3);
});
test('selected extracted fallback reports traversal loss even when parser plain is empty or whitespace',async()=>{
 const html='<div>'+'<i>x</i>'.repeat(24000)+'</div>';
 for(const bytes of [htmlOnly(html),alternative('  ',html)]){const output=await inspectEmailSourceFiles(bytes,{presentation:true});assert.equal(output.presentation.format,'plain');assert.match(output.presentation.content,/^x+/);assert.equal(output.presentation.truncated,true);assert.ok(Buffer.byteLength(output.presentation.content)<=262144);}
});
test('HTML recovery keeps UTF8 byte bounds and marks loss without replacement characters',async()=>{
 const output=await inspectEmailSourceFiles(htmlOnly('<div>'+'é'.repeat(180000)+'</div>'),{presentation:true});assert.match(output.presentation.plain_text,/^é+/);assert.ok(Buffer.byteLength(output.presentation.plain_text)<=262144);assert.doesNotMatch(output.presentation.plain_text,/\ufffd/u);assert.equal(output.presentation.truncated,true);
});

test('semantic headings separate following paragraphs in native and legacy HTML-only MIME, including complex fallback',async()=>{
 for(const profile of ['native','legacy']){
  for(let level=1;level<=6;level++){const output=await inspectEmailSourceFiles(htmlOnly(`<h${level}>Heading ${level}</h${level}><p>Following paragraph</p>`),{presentation:true,profile});assert.equal(output.presentation.format,'html');assert.equal(output.presentation.plain_text,`Heading ${level}\nFollowing paragraph\n`);assert.equal(output.presentation.truncated,false);}
  const complex=await inspectEmailSourceFiles(htmlOnly('<h1>UNSENT synthetic HTML-only reading fixture</h1><p>Do not send.</p>'+table()+'<p>END</p>'),{presentation:true,profile});assert.equal(complex.presentation.format,'plain');assert.match(complex.presentation.content,/^UNSENT synthetic HTML-only reading fixture\nDo not send\.\nLabel\tValue\t\n/);assert.match(complex.presentation.content,/Label2499\tValue2499\t\nEND\n$/);assert.equal(complex.presentation.content,complex.presentation.plain_text);assert.equal(complex.presentation.truncated,false);
 }
});

test('semantic block entry and exit separate words while inline emphasis and br keep their text meaning',async()=>{
 const output=await inspectEmailSourceFiles(htmlOnly('Intro <b>word</b><h2>Heading</h2><section>Section</section><blockquote>Quote <i>inline</i></blockquote><p>Tail</p>'),{presentation:true});assert.equal(output.presentation.plain_text,'Intro word\nHeading\nSection\nQuote inline\nTail\n');
 for(const tag of ['article','header','footer','main','aside','nav','address','pre','figure','figcaption','ul','ol','dl','dt','dd','div','li']){const out=await inspectEmailSourceFiles(htmlOnly(`Before<${tag}>Block <em>inline</em></${tag}>After`),{presentation:true});assert.equal(out.presentation.plain_text,'Before\nBlock inline\nAfter',tag);}
 const inline=await inspectEmailSourceFiles(htmlOnly('<p>co<strong>operate</strong> and <span>re</span><i>join</i><br>Next</p>'),{presentation:true});assert.equal(inline.presentation.plain_text,'cooperate and rejoin\nNext\n');
});

test('semantic separators remain inert and do not alter a meaningful plain alternative or image authority',async()=>{
 const html='<h1>Safe heading</h1><script>secret-script</script><style>secret-style</style><template>secret-template</template><noscript>secret-noscript</noscript><section>Safe section</section>'+table()+'<img src="https://public.example.test/never-fetch">';let fetches=0;
 for(const profile of ['native','legacy']){const output=await inspectEmailSourceFiles(htmlOnly(html),{presentation:true,profile,fetchRemote:async()=>{fetches++;throw Error('Must not fetch');}});assert.match(output.presentation.content,/^Safe heading\nSafe section\n/);assert.doesNotMatch(output.presentation.content,/secret-|<[^>]+>|https:/);assert.deepEqual(output.presentation.images,[]);assert.equal(output.presentation.truncated,false);
  const preferred='  Meaningful plain\nkept exactly\t ';const plain=await inspectEmailSourceFiles(alternative(preferred,html),{presentation:true,profile});assert.equal(plain.presentation.content,preferred);assert.equal(plain.presentation.plain_text,preferred);}
 assert.equal(fetches,0);let checks=0;await assert.rejects(inspectEmailSourceFiles(htmlOnly(html),{presentation:true,check:async()=>{if(++checks===3)throw Error('Revoked');}}),/Revoked/);assert.equal(checks,3);
});

test('semantic extraction preserves UTF8/output/node loss bounds and existing source rejection',async()=>{
 const bytes=htmlOnly('<h1>'+'é'.repeat(180000)+'</h1><p>Tail</p>'),output=await inspectEmailSourceFiles(bytes,{presentation:true});assert.ok(Buffer.byteLength(output.presentation.plain_text)<=262144);assert.doesNotMatch(output.presentation.plain_text,/\ufffd/u);assert.equal(output.presentation.truncated,true);
 const nodes=await inspectEmailSourceFiles(htmlOnly('<section>'+'<b>x</b>'.repeat(24000)+'</section>'),{presentation:true});assert.match(nodes.presentation.content,/^x+/);assert.equal(nodes.presentation.truncated,true);assert.ok(Buffer.byteLength(nodes.presentation.content)<=262144);assert.deepEqual(nodes.presentation.images,[]);
 await assert.rejects(inspectEmailSourceFiles(new Uint8Array(8388609)));
});
