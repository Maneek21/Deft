import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKnowledgeAnswerContext, KNOWLEDGE_SOURCE_CONTEXT_LIMIT, KNOWLEDGE_TOTAL_CONTEXT_LIMIT, type KnowledgeAnswerSource } from '../src/lib/knowledge-answer-context.js';
import { toPlainText } from '../src/lib/plain-text.js';
const actualBody = "LIVE261019 E1 planning note. This is a human-authored synthetic note, not an email capture.\n\nParticipants: 25. Technical review: 21 October 2026. Customer demo: 23 October 2026.\n\nRequested start: 20 October 2026 remains unresolved because it precedes the technical review.\n\nOwners: Noah engineering, Amina onboarding, Leo commercial, Priya finance review, Maya coordination.\n\nNext action: verify readiness and ask Noah to clarify the start-date conflict.\n\nEditorial update: Maya reviewed the owner list; this edit does not change the accepted E1 dates or participant count.\n\nElena Morris is the pilot sponsor and launch approver. Noah Chen remains responsible for technical readiness.";
function source(content:string, index=1):KnowledgeAnswerSource { return {index,source_id:`source-${index}`,title:'Launch readiness',type:'decision',scope:'org',confidence:0.9,score:0.9,summary:'Initial planning note.',excerpt:toPlainText(content).slice(0,500),content}; }
test('ordinary Knowledge answer context preserves actual current tail facts and public excerpt', () => {
 const input=source(actualBody);const before=JSON.stringify(input);const normalized=toPlainText(actualBody);
 assert.equal(normalized.length,678);assert.equal(normalized.indexOf('Elena Morris is the pilot sponsor'),569);
 assert.equal(input.excerpt.length,500);assert.ok(!input.excerpt.includes('Elena Morris'));
 const result=buildKnowledgeAnswerContext([input]);assert.ok(result.text.includes('Elena Morris is the pilot sponsor and launch approver.'));
 assert.ok(result.text.includes('Noah Chen remains responsible for technical readiness.'));assert.equal(JSON.stringify(input),before);
 assert.deepEqual(result.coverage,[{source_id:'source-1',included_characters:678,total_characters:678,truncated:false}]);
});
test('ordinary Knowledge answer context bounds all emitted source text including long titles', () => {
 const input={...source('x'.repeat(100000)),title:'t'.repeat(100000),summary:'s'.repeat(100000)};
 const result=buildKnowledgeAnswerContext([input]);assert.ok(result.text.length<=KNOWLEDGE_SOURCE_CONTEXT_LIMIT);assert.ok(result.text.length<=KNOWLEDGE_TOTAL_CONTEXT_LIMIT);assert.equal(result.coverage[0].truncated,true);
 assert.ok(result.text.includes('truncated'));assert.ok(result.coverage[0].included_characters<result.coverage[0].total_characters);
});
test('ordinary Knowledge answer context fairly bounds twelve ranked sources and separators', () => {
 const inputs=Array.from({length:12},(_,i)=>source(`source-${i+1} `+'x'.repeat(10000),i+1));
 const result=buildKnowledgeAnswerContext(inputs);assert.ok(result.text.length<=KNOWLEDGE_TOTAL_CONTEXT_LIMIT);assert.equal(result.coverage.length,12);
 const two=buildKnowledgeAnswerContext(inputs.slice(0,2));assert.ok(two.text.length<=2*KNOWLEDGE_SOURCE_CONTEXT_LIMIT);
 for(const block of two.text.split('\n\n'))assert.ok(block.length<=KNOWLEDGE_SOURCE_CONTEXT_LIMIT);
 for(let i=0;i<12;i++){assert.equal(result.coverage[i].source_id,`source-${i+1}`);assert.ok(result.coverage[i].included_characters>0);assert.equal(result.coverage[i].truncated,true);}
 assert.ok(result.text.indexOf('[1]')<result.text.indexOf('[12]'));assert.ok(result.text.includes('[12]'));
});
test('ordinary Knowledge answer context empty sources are safe',()=>{assert.deepEqual(buildKnowledgeAnswerContext([]),{text:'',coverage:[]});});
test('ordinary Knowledge answer context preserves complete small sources across the ranked set',()=>{
 const result=buildKnowledgeAnswerContext([source(actualBody),source('Independent short note.',2)]);assert.ok(result.text.includes('Independent short note.'));assert.ok(result.coverage.every(c=>!c.truncated));
});
