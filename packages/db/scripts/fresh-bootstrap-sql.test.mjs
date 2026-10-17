import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {freshBootstrapSql} from './fresh-bootstrap-sql.mjs';
const reviewed=[['0020_wiki_search_vector.sql','a7db43c255ca1fc7891f9882a55ca39985361d53bd54c593782ca96ec57d5e2e'],['0081_modules_v1.sql','32440cbf255ab9a592634163b19b64a3592109cb0596d7115dcf55b2a2cc3745']];
test('Linux LF and Windows CRLF bootstrap inputs converge to exact reviewed legacy bytes',()=>{
 for(const [file,digest]of reviewed){
  const text=readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8'),lf=text.replace(/\r\n/g,'\n');
  for(const input of [lf,lf.replace(/\n/g,'\r\n')])assert.equal(createHash('sha256').update(freshBootstrapSql(file,input)).digest('hex'),digest);
 }
});
test('unrelated SQL retains its physical line endings and content',()=>{
 for(const sql of ['SELECT 1;\n','SELECT 1;\r\n'])assert.equal(freshBootstrapSql('other.sql',sql),sql);
});
