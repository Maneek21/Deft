// Run by piping this file to `pnpm exec tsx --input-type=module -` from apps/api.
// Requires BASELINE_DATABASE_URL explicitly approved by parent; no default DB.
const databaseUrl = process.env.BASELINE_DATABASE_URL;
if (!databaseUrl) throw new Error('BASELINE_DATABASE_URL is required; no default DB permitted');
const target = new URL(databaseUrl);
if (!['localhost','127.0.0.1'].includes(target.hostname) || !target.pathname.includes('baseline')) throw new Error('Only explicitly designated loopback baseline database allowed');
process.env.DATABASE_URL = databaseUrl;
process.env.JWT_SECRET = 'baseline-test-access-secret-20261003';
process.env.JWT_REFRESH_SECRET = 'baseline-test-refresh-secret-20261003';
process.env.ENCRYPTION_KEY = 'baseline-test-encryption-key-20261003';
process.env.ANTHROPIC_API_KEY = ''; process.env.OPENAI_API_KEY = ''; process.env.RESEND_API_KEY = '';
const { randomUUID } = await import('node:crypto');
const { writeFile } = await import('node:fs/promises');
const { default: pg } = await import('pg');
const { default: bcrypt } = await import('bcryptjs');
const { Hono } = await import('hono');
const { authRoutes } = await import('./src/routes/auth.ts');
const { authMiddleware } = await import('./src/middleware/auth.ts');
const { memberRoutes } = await import('./src/routes/members.ts');
const { auditRoutes } = await import('./src/routes/audit.ts');
const { messageRoutes } = await import('./src/routes/messages.ts');
const { logAuditEvent } = await import('./src/lib/audit.ts');
const { closeDb } = await import('./src/lib/db.ts');
const uid=randomUUID(); const ids={org:`baseline-id-org-${uid}`,foreignOrg:`baseline-id-foreign-org-${uid}`,owner:`baseline-id-owner-${uid}`,member:`baseline-id-member-${uid}`,foreign:`baseline-id-foreign-${uid}`,privateSpace:`baseline-id-private-${uid}`,publicSpace:`baseline-id-public-${uid}`,message:`baseline-id-message-${uid}`};
const password='BaselineTestPassword123!'; const hash=await bcrypt.hash(password,10);
const client=new pg.Client({connectionString:databaseUrl}); await client.connect();
const outcomes=[];
const record=(scenario,expected,actual,pass,detail)=>{outcomes.push({scenario,expected,actual,pass,detail});console.log(JSON.stringify(outcomes.at(-1)));};
const app=new Hono(); app.route('/api/auth',authRoutes);app.use('/api/*',authMiddleware);app.route('/api/members',memberRoutes);app.route('/api/audit',auditRoutes);app.route('/api/messages',messageRoutes);
const request=async(method,path,token,body)=>{const res=await app.request(path,{method,headers:{...(token?{Authorization:`Bearer ${token}`} :{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,body:await res.json()};};
const login=(id)=>request('POST','/api/auth/login',null,{email:`${id}@test.local`,password});
try {
 await client.query('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3),($4,$5,$6)',[ids.org,'Baseline identity org',`baseline-id-${uid}`,ids.foreignOrg,'Foreign baseline org',`baseline-foreign-${uid}`]);
 for(const [id,org,role] of [[ids.owner,ids.org,'owner'],[ids.member,ids.org,'member'],[ids.foreign,ids.foreignOrg,'owner']]) {
  await client.query('INSERT INTO users(id,email,name,password_hash,email_verified) VALUES($1,$2,$3,$4,true)',[id,`${id}@test.local`,id,hash]);
  await client.query('INSERT INTO org_members(id,org_id,user_id,role,is_active) VALUES($1,$2,$3,$4,true)',[randomUUID(),org,id,role]);
 }
 await client.query("INSERT INTO spaces(id,org_id,name,type,created_by,is_default) VALUES($1,$2,'Private leadership','private',$3,false),($4,$2,'Baseline public','public',$3,true)",[ids.privateSpace,ids.org,ids.owner,ids.publicSpace]);
 for(const [space,user] of [[ids.privateSpace,ids.owner],[ids.publicSpace,ids.owner],[ids.publicSpace,ids.member]]) await client.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)',[randomUUID(),space,user]);
 const secret=`PRIVATE_AUDIT_CANARY_${uid}`;
 await client.query('INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,$5)',[ids.message,ids.org,ids.privateSpace,ids.owner,secret]);
 // Persist through the actual audit writer, exactly matching post_message's audit payload.
 await logAuditEvent({orgId:ids.org,actorType:'agent',actorId:ids.owner,action:'post_message',entityType:'message',entityId:ids.message,afterState:{message_id:ids.message,space_id:ids.privateSpace,content:secret},metadata:{space_name:'Private leadership'}});
 const ownerLogin=await login(ids.owner), memberLogin=await login(ids.member), foreignLogin=await login(ids.foreign);
 for(const [name,value] of [['owner',ownerLogin],['member',memberLogin],['foreign',foreignLogin]]) if(value.status!==200 || !value.body.accessToken) throw new Error(`Fixture ${name} login failed: ${JSON.stringify(value)}`);
 const ownerToken=ownerLogin.body.accessToken,memberToken=memberLogin.body.accessToken,foreignToken=foreignLogin.body.accessToken;
 let r=await request('GET',`/api/messages/${ids.privateSpace}`,ownerToken);record('private-message-authorized-control','200 contains canary',r.status,r.status===200&&JSON.stringify(r.body).includes(secret));
 r=await request('GET',`/api/messages/${ids.privateSpace}`,memberToken);record('private-message-member-denial-control',403,r.status,r.status===403);
 r=await request('GET',`/api/audit?entity_type=message&entity_id=${ids.message}`,ownerToken);record('audit-authorized-control','200 contains canary',r.status,r.status===200&&JSON.stringify(r.body).includes(secret));
 r=await request('GET',`/api/audit?entity_type=message&entity_id=${ids.message}`,foreignToken);record('audit-cross-org-denial-control','no canary',r.status,!JSON.stringify(r.body).includes(secret),r.body);
 r=await request('GET',`/api/audit?entity_type=message&entity_id=${ids.message}`,memberToken);record('audit-private-message-denial','403/404 or no private payload',{status:r.status,body:r.body},[403,404].includes(r.status)||!JSON.stringify(r.body).includes(secret));
 r=await request('DELETE',`/api/members/${ids.member}`,ownerToken,{});record('offboarding-success-control',200,r.status,r.status===200,r.body);
 r=await login(ids.member);record('offboarded-login-denial-control',403,r.status,r.status===403,r.body.code);
 r=await request('GET',`/api/messages/${ids.publicSpace}`,memberToken);record('offboarded-existing-session-denial-control','401/403',r.status,[401,403].includes(r.status));
 r=await request('POST','/api/members/invite',ownerToken,{email:`${ids.member}@test.local`,role:'member'});record('reinvite-create-control',201,r.status,r.status===201);
 const pending=(await client.query('SELECT id,accepted_at FROM invites WHERE org_id=$1 AND email=$2 ORDER BY created_at DESC LIMIT 1',[ids.org,`${ids.member}@test.local`])).rows[0];
 if(!pending||pending.accepted_at) throw new Error('Expected pending re-invite fixture');
 r=await login(ids.member);record('pending-reinvite-login-denial','403 until invite accepted',r.status,r.status===403);
 r=await request('DELETE',`/api/members/invites/${pending.id}`,ownerToken);record('pending-reinvite-revoke-control',200,r.status,r.status===200);
 const membership=(await client.query('SELECT is_active,role FROM org_members WHERE org_id=$1 AND user_id=$2',[ids.org,ids.member])).rows[0];
 r=await login(ids.member);record('revoked-reinvite-login-denial',403,{status:r.status,membership},r.status===403&&!membership.is_active);
} catch(error) {record('probe-infrastructure-error','no error',String(error),false,error?.stack);} finally {
 const result={schema:'deft.core.baseline.identity.v1',timestamp:new Date().toISOString(),database:{host:target.hostname,port:target.port,name:target.pathname.slice(1)},fixtures:ids,outcomes,notes:['Actual Hono routes, JWT login/session verification, actual PostgreSQL queries. No database mocks.','Private audit fixture persisted through actual logAuditEvent writer matching agent post_message payload; agent executor not invoked.','Fixtures retained in designated disposable baseline DB for independent inspection.']};
 await writeFile('C:/tmp/deft-core-baseline-20261003/identity-governance-results.json',JSON.stringify(result,null,2));await client.end();await closeDb();
}
