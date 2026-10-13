import assert from 'node:assert/strict';
import test from 'node:test';
import {Hono} from 'hono';
import {createEmailTemplateRoutes} from '../src/routes/email-templates.js';
import {EmailTemplateError} from '../src/lib/email-template-service.js';

const account='account-native',id='c7e0372e-1fd7-4fb5-8667-5a5290da78a4';
const document={title:'Welcome',subject:'Hello {{name}}',body:'Hello {{name}}',body_html:'<p>Hello {{name}}</p>'};
function appFor({valid=true,conflict=false}:{valid?:boolean;conflict?:boolean}={}){
  const calls:any[]=[];
  const templates=async(actor:any)=>({
    async create(_actor:any,scope:any,templateId:string,content:any){calls.push(['create',actor,scope,templateId,content]);if(conflict)throw new EmailTemplateError('EMAIL_TEMPLATE_CONFLICT');
      return {template_id:templateId,account_id:scope.account_id,revision:1,status:'active',content,created_at:'2026-10-04T00:00:00.000Z',updated_at:'2026-10-04T00:00:00.000Z'};},
    async list(_actor:any,scope:any,cursor:any,limit:any){calls.push(['list',scope,cursor,limit]);return {items:[],next_cursor:null,has_more:false};},
    async read(_actor:any,scope:any,templateId:string){calls.push(['read',scope,templateId]);return {template_id:templateId,account_id:scope.account_id,revision:1,status:'active',content:document};},
    async update(_actor:any,scope:any,templateId:string,revision:number,content:any){calls.push(['update',scope,templateId,revision,content]);return {template_id:templateId,account_id:scope.account_id,revision:revision+1,status:'active',content};},
    async archive(_actor:any,scope:any,templateId:string,revision:number){calls.push(['archive',scope,templateId,revision]);return {template_id:templateId,account_id:scope.account_id,revision:revision+1,status:'archived'};},
    async render(_actor:any,scope:any,templateId:string,values:any){calls.push(['render',scope,templateId,values]);return {subject:'Hello',body:'Hello',body_html:'<p>Hello</p>',unresolved_placeholders:[]};},
  });
  const routes=createEmailTemplateRoutes({verify:async token=>{if(!valid||token!=='valid')throw Error();return {id:'owner-1',org_id:'org-1',sid:'session-1',exp:Date.now()/1000+60};},templates:templates as any});
  const app=new Hono();app.route('/api/email',routes);return {app,calls};
}
const json=(body:unknown)=>({method:'POST',headers:{authorization:'Bearer valid','content-type':'application/json'},body:JSON.stringify(body)});

test('template HTTP surface derives owner scope, rejects invalid inputs and exposes explicit render results',async()=>{
  const {app,calls}=appFor();
  const noAuth=await app.request('/api/email/accounts/'+account+'/templates');assert.equal(noAuth.status,401);
  const created=await app.request('/api/email/accounts/'+account+'/templates',json({template_id:id,content:document}));
  assert.equal(created.status,201);assert.equal((await created.json() as any).template_id,id);
  assert.deepEqual(calls[0]?.slice(0,4),['create',{user_id:'owner-1',web_session_id:'session-1',access_expires_at:calls[0]?.[1]?.access_expires_at},
    {org_id:'org-1',owner_user_id:'owner-1',account_id:account},id]);
  const listed=await app.request('/api/email/accounts/'+account+'/templates?limit=1',{headers:{authorization:'Bearer valid'}});
  assert.equal(listed.status,200);assert.deepEqual(calls[1],['list',{org_id:'org-1',owner_user_id:'owner-1',account_id:account},null,1]);
  const rendered=await app.request('/api/email/accounts/'+account+'/templates/'+id+'/render',json({values:{name:'A'}}));
  assert.equal(rendered.status,200);assert.deepEqual((await rendered.json() as any).unresolved_placeholders,[]);
  const badPlaceholder=await app.request('/api/email/accounts/'+account+'/templates',json({template_id:id,content:{...document,subject:'{{oops'}}));
  assert.equal(badPlaceholder.status,400);
  const wrongQuery=await app.request('/api/email/accounts/'+account+'/templates?org_id=other',{headers:{authorization:'Bearer valid'}});
  assert.equal(wrongQuery.status,400);
});
test('template UUID create conflict maps to 409 without exposing internals',async()=>{
  const {app}=appFor({conflict:true});
  const response=await app.request('/api/email/accounts/'+account+'/templates',json({template_id:id,content:document}));
  assert.equal(response.status,409);assert.deepEqual(await response.json(),{code:'EMAIL_TEMPLATE_CONFLICT'});
});
