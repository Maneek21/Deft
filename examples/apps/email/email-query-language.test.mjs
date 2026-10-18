import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {parseEmailQuery,compileEmailQuery,EmailQueryError} from './email-query-language.mjs';
const require=createRequire(import.meta.url);
const {searchCompiler}=require('./node_modules/imapflow/dist/cjs/search-compiler.js');
const rows=[
 {id:'one',from:'Alice alice@example.test',to:'team@example.test',cc:'review@example.test',subject:'Quarterly plan Café 東京',body:'Ready for review',seen:false,flagged:true,attachment:true,size:12000,received:Date.parse('2026-11-01T03:00:00Z')/1000},
 {id:'two',from:'Alice alice@example.test',to:'legal@example.test',cc:'review@example.test',subject:'Quarterly plan Café 東京',body:'Ready for review',seen:true,flagged:false,attachment:false,size:200,received:Date.parse('2026-11-01T20:00:00Z')/1000},
 {id:'three',from:'Bob bob@example.test',to:'team@example.test',cc:'other@example.test',subject:'Quarterly forecast',body:'Annual review',seen:false,flagged:false,attachment:true,size:1500000,received:Date.parse('2026-11-02T00:00:00Z')/1000},
 {id:'four',from:'Alice alice@example.test',to:'team@example.test',cc:'review@example.test',subject:'Quoted "plan" C:\\Work',body:'Annual review',seen:false,flagged:true,attachment:false,size:100,received:Date.parse('2026-10-31T23:00:00Z')/1000},
];
const contains=(a,b)=>String(a).toLowerCase().includes(String(b).toLowerCase());
function predicate(row,field,value){
 if(field==='text')return contains([row.from,row.to,row.cc,row.subject,row.body].join(' '),value);
 if(['from','to','cc','subject'].includes(field))return contains(row[field],value);
 if(field==='is')return value==='starred'?row.flagged:value==='read'?row.seen:!row.seen;
 if(field==='has')return row.attachment;
 if(field==='hasAttachments')return row.attachment;
 if(field==='larger')return row.size>Number(value);
 if(field==='smaller')return row.size<Number(value);
 if(field==='after')return row.received>=Number(value);
 if(field==='before')return row.received<Number(value);
 throw Error('Fixture unsupported predicate '+field);
}
// These tiny fixture interpreters read the emitted provider dialect, never the
// parser AST. Expected IDs below are authored independently from the compiler.
function nativeMatches(provider,request){
 if(provider==='imap_smtp'){
  const evalImap=(row,node)=>Object.entries(node).every(([key,value])=>key==='not'?!evalImap(row,value):key==='or'?value.some(child=>evalImap(row,child)):key==='seen'||key==='flagged'?row[key]===value:predicate(row,key,value));
  return rows.filter(row=>evalImap(row,request.search)).map(row=>row.id);
 }
 const pattern=provider==='gmail'?/-?(?:[a-z]+:)?"[^"]*"|-?(?:is:[a-z]+|has:attachment|(?:larger|smaller|after|before):\d+)/gu:/(?:NOT )?(?:[a-z]+:)?"[^"]*"|(?:NOT )?hasAttachments:true|(?:NOT )?size[<>]\d+/gu;
 const clauses=[...request.query.matchAll(pattern)].map(match=>match[0]);assert.ok(clauses.length);
 return rows.filter(row=>clauses.every(clause=>{
  let negate=false;if(clause.startsWith('-')){negate=true;clause=clause.slice(1);}else if(clause.startsWith('NOT ')){negate=true;clause=clause.slice(4);}
  const size=/^size([<>])(\d+)$/u.exec(clause);let result;
  if(size)result=predicate(row,size[1]==='>'?'larger':'smaller',size[2]);
  else{const parsed=/^(?:([A-Za-z]+):)?(?:"([^"]*)"|([^" ]+))$/u.exec(clause);assert.ok(parsed);result=predicate(row,parsed[1]??'text',parsed[2]??parsed[3]);}
  return negate?!result:result;
 })).map(row=>row.id);
}

test('one AST translates phrase/from/to/cc/subject/exclusion with independently expected provider fixture IDs',()=>{
 const query='from:alice@example.test subject:"Quarterly plan" cc:review@example.test -to:legal@example.test',ast=parseEmailQuery(query);
 for(const provider of ['gmail','microsoft','imap_smtp']){const compiled=compileEmailQuery(provider,ast);assert.equal(compiled.status,'supported');assert.equal(compiled.original_query,query);assert.deepEqual(nativeMatches(provider,compiled.request),['one']);}
});
test('Unicode stays intact and provider operator-looking words inside phrases remain literals',()=>{
 for(const query of ['subject:"Café 東京" -to:legal@example.test','subject:"Quarterly plan" AND -to:legal@example.test'])for(const provider of ['gmail','microsoft','imap_smtp']){
  const compiled=compileEmailQuery(provider,query);assert.equal(compiled.status,'supported');assert.deepEqual(nativeMatches(provider,compiled.request),['one']);
 }
 assert.equal(compileEmailQuery('gmail','subject:"OR in:anywhere"').request.query,'subject:"OR in:anywhere"');
 assert.equal(compileEmailQuery('microsoft','subject:"Alice AND Bob"').request.query,'subject:"Alice AND Bob"');
});
test('unread/star/size and repeated field conjunction preserve independent IMAP semantics',()=>{
 const query='is:unread is:starred larger:1K smaller:1M subject:Quarterly subject:plan',compiled=compileEmailQuery('imap_smtp',query);
 assert.equal(compiled.status,'supported');assert.deepEqual(nativeMatches('imap_smtp',compiled.request),['one']);
 const actual=searchCompiler({capabilities:new Map([['UTF8=ACCEPT',true]]),enabled:new Set(['UTF8=ACCEPT']),mailbox:{}},compiled.request.search);
 assert.ok(actual.length>0);assert.ok(JSON.stringify(actual).includes('NOT'));assert.equal(compiled.request.uid,true);
 const gmail=compileEmailQuery('gmail',query);assert.deepEqual(nativeMatches('gmail',gmail.request),['one']);
 const graph=compileEmailQuery('microsoft',query);assert.equal(graph.status,'unsupported');assert.equal(Object.hasOwn(graph,'request'),false);
});
test('attachment and byte-size translations preserve known provider limits without partial execution',()=>{
 for(const provider of ['gmail','microsoft']){const result=compileEmailQuery(provider,'has:attachment larger:10K smaller:1M');assert.equal(result.status,'supported');assert.deepEqual(nativeMatches(provider,result.request),['one']);}
 assert.ok(compileEmailQuery('microsoft','has:attachment').limitations.includes('non_inline_attachment_only'));
 const unsupported=compileEmailQuery('imap_smtp','subject:plan has:attachment');assert.equal(unsupported.status,'unsupported');assert.equal(unsupported.original_query,'subject:plan has:attachment');assert.equal(Object.hasOwn(unsupported,'request'),false);
});
test('UTC day windows use epoch seconds across a DST transition and never become IMAP internal-date or ambiguous Graph dates',()=>{
 const query='on:2026-11-01',result=compileEmailQuery('gmail',query),start=Date.parse('2026-11-01T00:00:00Z')/1000;
 assert.equal(result.request.query,`(after:${start} before:${start+86400})`);assert.deepEqual(nativeMatches('gmail',result.request),['one','two']);
 const offset=compileEmailQuery('gmail','after:2026-11-01T05:30:00+05:30 before:2026-11-02');assert.equal(offset.request.query,`after:${start} before:${start+86400}`);
 for(const provider of ['microsoft','imap_smtp']){const limited=compileEmailQuery(provider,query);assert.equal(limited.status,'unsupported');assert.equal(Object.hasOwn(limited,'request'),false);assert.equal(limited.ast.date_basis,'received_utc');}
});
test('escaped quote/backslash are parsed exactly and only execute through typed IMAP strings',()=>{
 const query='subject:"Quoted \\"plan\\"" subject:"C:\\\\Work"',ast=parseEmailQuery(query);
 assert.equal(ast.terms[0].value,'Quoted "plan"');assert.equal(ast.terms[1].value,'C:\\Work');
 const result=compileEmailQuery('imap_smtp',ast);assert.equal(result.status,'supported');assert.deepEqual(nativeMatches('imap_smtp',result.request),['four']);
 for(const provider of ['gmail','microsoft']){const limited=compileEmailQuery(provider,ast);assert.equal(limited.status,'unsupported');assert.equal(limited.original_query,query);assert.equal(Object.hasOwn(limited,'request'),false);}
});
test('unsupported operators, groups and wildcards retain the exact original without returning an executable partial query',()=>{
 for(const query of ['  subject:plan label:private  ','subject:plan OR from:other','(subject:plan)','has:drive','is:important','subject:plan*','-on:2026-11-01']){
  const result=compileEmailQuery('gmail',query);assert.equal(result.status,'unsupported');assert.equal(result.original_query,query);assert.equal(Object.hasOwn(result,'request'),false);assert.ok(result.unsupported.length);
 }
});
test('malformed/bounded queries and altered ASTs fail rather than lose constraints',()=>{
 for(const query of ['', ' ', 'from:', 'from: "alice"', 'subject:"unclosed', 'subject:"x"tail','subject:"x\\q"','-','AND subject:plan','subject:plan AND','subject:plan AND AND to:x','on:2026-02-30','after:2026-02-30T00:00:00Z','larger:0','smaller:4Gx','subject:x\nfrom:y','a'.repeat(2049),Array(33).fill('word').join(' ')])assert.throws(()=>parseEmailQuery(query),error=>error instanceof EmailQueryError&&error.code==='EMAIL_QUERY_INVALID');
 const ast=structuredClone(parseEmailQuery('subject:plan'));ast.terms[0].value='different';assert.throws(()=>compileEmailQuery('gmail',ast),/EMAIL_QUERY_AST_INVALID/);
});

test('M22 canonical positive folder scopes compile independently from remaining predicates and preserve exact original',()=>{
 for(const provider of ['gmail','microsoft','imap_smtp'])for(const role of ['inbox','sent','drafts','spam','trash']){
  const original=`  in:${role.toUpperCase()} subject:proof  `,v=compileEmailQuery(provider,original);assert.equal(v.status,'supported');assert.equal(v.original_query,original);assert.equal(v.request.folder_role,role);
  assert.equal(v.request.query??JSON.stringify(v.request.search),provider==='imap_smtp'?JSON.stringify({subject:'proof'}):'subject:"proof"');
  const only=compileEmailQuery(provider,'in:'+role);assert.equal(only.status,'supported');assert.equal(only.request.folder_role,role);assert.deepEqual(only.request.search??only.request.query,provider==='imap_smtp'?{all:true}:'');
 }
 assert.equal(compileEmailQuery('gmail','in:drafts in:DRAFTS subject:proof').request.folder_role,'drafts');
 for(const [query,reason]of [['in:archive subject:proof','folder_scope_not_supported'],['in:all','folder_scope_not_supported'],['in:private','folder_scope_not_supported'],['-in:trash subject:proof','negated_folder_scope_not_supported'],['in:inbox in:sent subject:proof','conflicting_folder_scopes']])for(const provider of ['gmail','microsoft','imap_smtp']){const v=compileEmailQuery(provider,query);assert.equal(v.status,'unsupported');assert.equal(v.original_query,query);assert.equal(Object.hasOwn(v,'request'),false);assert.ok(v.unsupported.some(row=>row.reason===reason));}
 assert.equal(Object.hasOwn(compileEmailQuery('gmail','subject:"in:drafts"').request,'folder_role'),false);
});
