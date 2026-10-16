/**
 * Gate G D0 experiment only. Run against a disposable PostgreSQL database.
 * No Deft routes, migrations, or production contracts are changed here.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(scriptPath, '../../../..');
const requireFromApi = createRequire(resolve(repoRoot, 'apps/api/package.json'));
const { Pool } = requireFromApi('pg');
const databaseUrl = process.env.GATE_G_PUBLIC_DATABASE_URL;
let databaseBinding;
try { databaseBinding = new URL(databaseUrl); } catch { /* fixed error below */ }
if (!databaseBinding || !['postgres:', 'postgresql:'].includes(databaseBinding.protocol)
  || databaseBinding.hostname !== '127.0.0.1'
  || databaseBinding.port !== '55434'
  || databaseBinding.pathname !== '/gate_g_public'
  || databaseBinding.username !== 'gate_g_probe'
  || databaseBinding.search || databaseBinding.hash) {
  throw new Error('GATE_G_PUBLIC_DATABASE_URL must exactly match the assigned loopback disposable DB binding');
}
const pool = new Pool({ connectionString: databaseUrl, max: 24, connectionTimeoutMillis: 10000 });
const schema = 'gate_g_public_probe';
const table = (name) => `${schema}.${name}`;
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const signal = (stage) => { if (process.send) process.send({ stage }); };
const park = () => new Promise(() => {});

async function setup() {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${table('endpoints')} (
    id uuid PRIMARY KEY, org_id uuid NOT NULL, slug text NOT NULL UNIQUE,
    public_label text NOT NULL, enabled boolean NOT NULL DEFAULT false,
    UNIQUE (org_id, id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${table('slots')} (
    id uuid PRIMARY KEY, org_id uuid NOT NULL, endpoint_id uuid NOT NULL,
    starts_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
    private_note text NOT NULL,
    FOREIGN KEY (org_id, endpoint_id) REFERENCES ${table('endpoints')}(org_id, id),
    UNIQUE (org_id, endpoint_id, id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${table('ingress')} (
    id uuid PRIMARY KEY, org_id uuid NOT NULL, endpoint_id uuid NOT NULL,
    request_key text NOT NULL, input_digest text NOT NULL,
    state text NOT NULL CHECK (state IN ('processing','confirmed','conflict')),
    reservation_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, endpoint_id, request_key),
    FOREIGN KEY (org_id, endpoint_id) REFERENCES ${table('endpoints')}(org_id, id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${table('reservations')} (
    id uuid PRIMARY KEY, org_id uuid NOT NULL, endpoint_id uuid NOT NULL,
    slot_id uuid NOT NULL, ingress_id uuid NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, slot_id),
    FOREIGN KEY (org_id, endpoint_id, slot_id) REFERENCES ${table('slots')}(org_id, endpoint_id, id),
    FOREIGN KEY (ingress_id) REFERENCES ${table('ingress')}(id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${table('outbox')} (
    id uuid PRIMARY KEY, org_id uuid NOT NULL, reservation_id uuid NOT NULL UNIQUE,
    event_kind text NOT NULL, payload jsonb NOT NULL,
    state text NOT NULL CHECK (state IN ('pending','delivered','failed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (reservation_id) REFERENCES ${table('reservations')}(id)
  )`);
}

async function fixture(label = 'Synthetic Booking') {
  const orgId = randomUUID(), endpointId = randomUUID(), slotId = randomUUID();
  const slug = randomUUID().replaceAll('-', '');
  await pool.query(`INSERT INTO ${table('endpoints')}(id,org_id,slug,public_label,enabled) VALUES($1,$2,$3,$4,true)`,
    [endpointId, orgId, slug, label]);
  await pool.query(`INSERT INTO ${table('slots')}(id,org_id,endpoint_id,starts_at,expires_at,private_note)
    VALUES($1,$2,$3,now()+interval '1 day',now()+interval '2 days','PRIVATE EMPLOYEE NOTE')`,
  [slotId, orgId, endpointId]);
  return { orgId, endpointId, slotId, slug, label };
}

// Only the server-owned opaque endpoint mapping establishes org and principal.
// Cookie and Authorization are never read by this function or the route.
async function resolvePublicPrincipal(client, slug) {
  const { rows } = await client.query(`SELECT id,org_id,public_label FROM ${table('endpoints')}
    WHERE slug=$1 AND enabled=true FOR SHARE`, [slug]);
  return rows[0] ? { kind: 'public', endpointId: rows[0].id, orgId: rows[0].org_id, label: rows[0].public_label } : null;
}

async function reserve({ slug, slotId, requestKey, faultAt, onStage }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const principal = await resolvePublicPrincipal(client, slug);
    if (!principal) { await client.query('ROLLBACK'); return { status: 404, body: { code: 'NOT_FOUND' } }; }
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(requestKey) || !/^[0-9a-f-]{36}$/.test(slotId)) {
      await client.query('ROLLBACK'); return { status: 400, body: { code: 'INVALID_INPUT' } };
    }
    const inputDigest = digest({ slotId });
    const ingressId = randomUUID();
    const inserted = await client.query(`INSERT INTO ${table('ingress')}
      (id,org_id,endpoint_id,request_key,input_digest,state)
      VALUES($1,$2,$3,$4,$5,'processing')
      ON CONFLICT (org_id,endpoint_id,request_key) DO NOTHING RETURNING id`,
    [ingressId, principal.orgId, principal.endpointId, requestKey, inputDigest]);
    if (inserted.rowCount === 0) {
      const replay = await client.query(`SELECT input_digest,state,reservation_id FROM ${table('ingress')}
        WHERE org_id=$1 AND endpoint_id=$2 AND request_key=$3`,
      [principal.orgId, principal.endpointId, requestKey]);
      await client.query('COMMIT');
      const row = replay.rows[0];
      if (!row || row.input_digest !== inputDigest) return { status: 409, body: { code: 'IDEMPOTENCY_CONFLICT' } };
      return row.state === 'confirmed'
        ? { status: 200, body: { state: 'confirmed', reservation_id: row.reservation_id, calendar_state: 'pending', replay: true } }
        : { status: 409, body: { code: 'SLOT_CONFLICT', replay: true } };
    }
    await onStage?.('after_ingress');
    if (faultAt === 'after_ingress') throw new Error('fault:after_ingress');
    const reservationId = randomUUID();
    const claimed = await client.query(`INSERT INTO ${table('reservations')}
      (id,org_id,endpoint_id,slot_id,ingress_id)
      SELECT $1,s.org_id,s.endpoint_id,s.id,$2 FROM ${table('slots')} s
      WHERE s.id=$3 AND s.org_id=$4 AND s.endpoint_id=$5
        AND s.expires_at>now()
      ON CONFLICT (org_id,slot_id) DO NOTHING RETURNING id`,
    [reservationId, ingressId, slotId, principal.orgId, principal.endpointId]);
    if (claimed.rowCount === 0) {
      await client.query(`UPDATE ${table('ingress')} SET state='conflict' WHERE id=$1`, [ingressId]);
      await client.query('COMMIT');
      return { status: 409, body: { code: 'SLOT_CONFLICT' } };
    }
    await onStage?.('after_reservation');
    if (faultAt === 'after_reservation') throw new Error('fault:after_reservation');
    await client.query(`INSERT INTO ${table('outbox')}
      (id,org_id,reservation_id,event_kind,payload,state)
      VALUES($1,$2,$3,'reservation.committed',$4::jsonb,'pending')`,
    [randomUUID(), principal.orgId, reservationId, JSON.stringify({ endpoint_id: principal.endpointId, reservation_id: reservationId })]);
    await onStage?.('after_outbox');
    if (faultAt === 'after_outbox') throw new Error('fault:after_outbox');
    await client.query(`UPDATE ${table('ingress')} SET state='confirmed',reservation_id=$2 WHERE id=$1`, [ingressId, reservationId]);
    await onStage?.('before_commit');
    if (faultAt === 'before_commit') throw new Error('fault:before_commit');
    await client.query('COMMIT');
    await onStage?.('after_commit');
    if (faultAt === 'after_commit') throw new Error('fault:after_commit');
    return { status: 201, body: { state: 'confirmed', reservation_id: reservationId, calendar_state: 'pending', replay: false } };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* connection may have been killed */ }
    throw error;
  } finally { client.release(); }
}

async function counts({ orgId, endpointId, slotId }) {
  const [i,r,o] = await Promise.all([
    pool.query(`SELECT count(*)::int AS n FROM ${table('ingress')} WHERE org_id=$1 AND endpoint_id=$2`, [orgId, endpointId]),
    pool.query(`SELECT count(*)::int AS n FROM ${table('reservations')} WHERE org_id=$1 AND slot_id=$2`, [orgId, slotId]),
    pool.query(`SELECT count(*)::int AS n FROM ${table('outbox')} WHERE org_id=$1 AND reservation_id IN
      (SELECT id FROM ${table('reservations')} WHERE org_id=$1 AND slot_id=$2)`, [orgId, slotId]),
  ]);
  return { ingress: i.rows[0].n, reservations: r.rows[0].n, outbox: o.rows[0].n };
}

function server() {
  return createServer(async (req,res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const slug = /^\/p\/([a-f0-9]{32})$/.exec(path)?.[1];
    if (!slug) { res.writeHead(404).end(); return; }
    try {
      if (req.method === 'GET') {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const principal = await resolvePublicPrincipal(client, slug);
          if (!principal) { await client.query('ROLLBACK'); res.writeHead(404).end(JSON.stringify({ code: 'NOT_FOUND' })); return; }
          const slots = await client.query(`SELECT s.id,s.starts_at FROM ${table('slots')} s
            WHERE s.org_id=$1 AND s.endpoint_id=$2 AND s.expires_at>now()
              AND NOT EXISTS (SELECT 1 FROM ${table('reservations')} r WHERE r.org_id=s.org_id AND r.slot_id=s.id)`,
          [principal.orgId,principal.endpointId]);
          await client.query('COMMIT');
          res.writeHead(200,{ 'content-type':'application/json','cache-control':'no-store' })
            .end(JSON.stringify({ label: principal.label, slots: slots.rows }));
          return;
        } finally { client.release(); }
      }
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      const chunks = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 1024) { res.writeHead(413).end(JSON.stringify({ code:'PAYLOAD_TOO_LARGE' })); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end(JSON.stringify({ code:'INVALID_INPUT' })); return; }
      if (!body || Object.keys(body).length !== 2 || typeof body.slot_id !== 'string' || typeof body.request_key !== 'string') {
        res.writeHead(400).end(JSON.stringify({ code:'INVALID_INPUT' })); return;
      }
      const result = await reserve({ slug, slotId:body.slot_id, requestKey:body.request_key });
      res.writeHead(result.status,{ 'content-type':'application/json','cache-control':'no-store' }).end(JSON.stringify(result.body));
    } catch { res.writeHead(500,{ 'content-type':'application/json' }).end(JSON.stringify({ code:'INTERNAL_ERROR' })); }
  });
}

async function request(base, f, key, extraHeaders = {}) {
  const response = await fetch(`${base}/p/${f.slug}`, { method:'POST', headers:{ 'content-type':'application/json', ...extraHeaders },
    body: JSON.stringify({ slot_id:f.slotId, request_key:key }) });
  return { status:response.status, body:await response.json() };
}

async function crashChild(f, key, stage) {
  const child = spawn(process.execPath, [scriptPath, '--child', JSON.stringify(f), key, stage],
    { env:process.env, stdio:['ignore','ignore','pipe','ipc'] });
  const stderr=[]; child.stderr.on('data',(x)=>stderr.push(x));
  const closed = new Promise((resolveClose)=>child.once('close',resolveClose));
  let timeout;
  try {
    const message = await new Promise((resolveMessage,rejectMessage) => {
      const cleanup=()=>{
        clearTimeout(timeout);
        child.off('message',onMessage);
        child.off('close',onClose);
        child.off('error',onError);
      };
      const onMessage=(value)=>{ cleanup(); resolveMessage(value); };
      const onClose=()=>{ cleanup(); rejectMessage(new Error(`child exited before ${stage}: ${Buffer.concat(stderr).toString()}`)); };
      const onError=(error)=>{ cleanup(); rejectMessage(error); };
      child.once('message',onMessage);
      child.once('close',onClose);
      child.once('error',onError);
      timeout=setTimeout(()=>{ cleanup(); rejectMessage(new Error(`child timeout at ${stage}`)); },10000);
    });
    assert.equal(message.stage,stage);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode===null && child.signalCode===null) child.kill('SIGKILL');
    await closed;
  }
}

async function run() {
  await setup();
  const output = { revision:'1427f66f84d5cb5f5430c566897a17dda77fe5fc', database:'gate_g_public', schema, cases:{} };
  const http = server(); http.listen(4331,'127.0.0.1'); await once(http,'listening');
  const base='http://127.0.0.1:4331';
  try {
    const f=await fixture();
    const fakeHeaders={ cookie:'deft_session=forged-owner; employee_id=forged-employee', authorization:'Bearer forged-employee-token' };
    const [plain,forged]=await Promise.all([
      fetch(`${base}/p/${f.slug}`).then((r)=>r.json()),
      fetch(`${base}/p/${f.slug}`,{headers:fakeHeaders}).then((r)=>r.json()),
    ]);
    assert.deepEqual(forged,plain);
    assert.deepEqual(Object.keys(plain).sort(),['label','slots']);
    assert.equal(JSON.stringify(plain).includes('PRIVATE EMPLOYEE NOTE'),false);
    assert.equal(JSON.stringify(plain).includes(f.orgId),false);
    const absent=await fetch(`${base}/p/${randomUUID().replaceAll('-','')}`,{headers:fakeHeaders});
    assert.equal(absent.status,404);
    output.cases.public_principal={ forged_cookie_and_bearer_ignored:true, unknown_endpoint:404, projection_keys:Object.keys(plain).sort() };

    const claims=await Promise.all(Array.from({length:100},(_,n)=>request(base,f,`claim-${n}`,n===0?fakeHeaders:{})));
    const wins=claims.filter((x)=>x.status===201), conflicts=claims.filter((x)=>x.status===409);
    assert.equal(wins.length,1); assert.equal(conflicts.length,99);
    assert.deepEqual(await counts(f),{ingress:100,reservations:1,outbox:1});
    assert.equal(wins[0].body.calendar_state,'pending');
    const winnerKey=`claim-${claims.findIndex((x)=>x.status===201)}`;
    const replay=await request(base,f,winnerKey,fakeHeaders);
    assert.equal(replay.status,200); assert.equal(replay.body.reservation_id,wins[0].body.reservation_id);
    assert.equal(replay.body.replay,true);
    const loserKey=`claim-${claims.findIndex((x)=>x.status===409)}`;
    const loserReplay=await request(base,f,loserKey);
    assert.equal(loserReplay.status,409); assert.equal(loserReplay.body.replay,true);
    const altered=await reserve({slug:f.slug,slotId:randomUUID(),requestKey:winnerKey});
    assert.equal(altered.status,409); assert.equal(altered.body.code,'IDEMPOTENCY_CONFLICT');
    assert.deepEqual(await counts(f),{ingress:100,reservations:1,outbox:1});
    output.cases.concurrency={requests:100,winners:wins.length,conflicts:conflicts.length,counts:await counts(f),winner_replay:replay.status,loser_replay:loserReplay.status,altered_replay:altered.body.code};

    const same=await fixture();
    const sameKeyClaims=await Promise.all(Array.from({length:20},()=>request(base,same,'same-key')));
    assert.equal(sameKeyClaims.filter((x)=>x.status===201).length,1);
    assert.equal(sameKeyClaims.filter((x)=>x.status===200 && x.body.replay).length,19);
    assert.equal(new Set(sameKeyClaims.map((x)=>x.body.reservation_id)).size,1);
    assert.deepEqual(await counts(same),{ingress:1,reservations:1,outbox:1});
    output.cases.concurrent_replay={requests:20,created:1,replays:19,counts:await counts(same)};

    const disabled=await fixture();
    await pool.query(`UPDATE ${table('endpoints')} SET enabled=false WHERE id=$1 AND org_id=$2`,[disabled.endpointId,disabled.orgId]);
    const denied=await request(base,disabled,'disabled-key',fakeHeaders);
    assert.equal(denied.status,404);
    assert.deepEqual(await counts(disabled),{ingress:0,reservations:0,outbox:0});
    output.cases.disabled_endpoint={request_status:denied.status,counts:await counts(disabled)};

    const revocation=await fixture();
    let releaseClaim, reachedCommit;
    const claimGate=new Promise((release)=>{ releaseClaim=release; });
    const atCommit=new Promise((reached)=>{ reachedCommit=reached; });
    const claimPromise=reserve({slug:revocation.slug,slotId:revocation.slotId,requestKey:'in-flight',
      onStage:(stage)=>stage==='before_commit' ? (reachedCommit(),claimGate) : undefined});
    await atCommit;
    const disableClient=await pool.connect();
    try {
      await disableClient.query('BEGIN');
      await disableClient.query("SET LOCAL lock_timeout='150ms'");
      await assert.rejects(
        disableClient.query(`UPDATE ${table('endpoints')} SET enabled=false WHERE id=$1 AND org_id=$2`,
          [revocation.endpointId,revocation.orgId]),
        (error)=>error.code==='55P03',
      );
      await disableClient.query('ROLLBACK');
    } finally { disableClient.release(); releaseClaim(); }
    assert.equal((await claimPromise).status,201);
    await pool.query(`UPDATE ${table('endpoints')} SET enabled=false WHERE id=$1 AND org_id=$2`,
      [revocation.endpointId,revocation.orgId]);
    assert.equal((await request(base,revocation,'late-claim')).status,404);
    assert.deepEqual(await counts(revocation),{ingress:1,reservations:1,outbox:1});
    output.cases.disable_claim_ordering={disable_blocked_by_inflight_claim:true,inflight_status:201,after_disable_status:404,
      counts:await counts(revocation)};

    for (const stage of ['after_ingress','after_reservation','after_outbox','before_commit']) {
      const faultFixture=await fixture();
      await assert.rejects(reserve({slug:faultFixture.slug,slotId:faultFixture.slotId,requestKey:`fault-${stage}`,faultAt:stage}),/fault:/);
      assert.deepEqual(await counts(faultFixture),{ingress:0,reservations:0,outbox:0});
      const recovered=await request(base,faultFixture,`fault-${stage}`);
      assert.equal(recovered.status,201);
      assert.deepEqual(await counts(faultFixture),{ingress:1,reservations:1,outbox:1});
      output.cases[stage]={after_fault:{ingress:0,reservations:0,outbox:0},retry_status:201};
    }
    const before=await fixture();
    await crashChild(before,'crash-before','before_commit');
    assert.deepEqual(await counts(before),{ingress:0,reservations:0,outbox:0});
    assert.equal((await request(base,before,'crash-before')).status,201);
    output.cases.crash_before_commit={after_kill:{ingress:0,reservations:0,outbox:0},retry_status:201};
    const after=await fixture();
    await crashChild(after,'crash-after','after_commit');
    assert.deepEqual(await counts(after),{ingress:1,reservations:1,outbox:1});
    const afterReplay=await request(base,after,'crash-after');
    assert.equal(afterReplay.status,200); assert.equal(afterReplay.body.replay,true);
    output.cases.crash_after_commit={after_kill:await counts(after),replay_status:200};
    const other=await fixture();
    const wrongTenant=await reserve({slug:other.slug,slotId:f.slotId,requestKey:'foreign-slot'});
    assert.equal(wrongTenant.status,409);
    assert.deepEqual(await counts(other),{ingress:1,reservations:0,outbox:0});
    output.cases.tenant_isolation={cross_org_slot_status:wrongTenant.status,counts:await counts(other)};
    console.log(JSON.stringify(output,null,2));
  } finally { http.close(); await once(http,'close'); await pool.end(); }
}

if (process.argv[2]==='--child') {
  const f=JSON.parse(process.argv[3]), key=process.argv[4], stage=process.argv[5];
  reserve({slug:f.slug,slotId:f.slotId,requestKey:key,onStage:(at)=>{
    if (at===stage) { signal(at); return park(); }
  }}).catch((error)=>{ process.stderr.write(error.stack); process.exitCode=1; });
} else {
  run().catch((error)=>{ console.error(error); process.exitCode=1; pool.end().catch(()=>{}); });
}
