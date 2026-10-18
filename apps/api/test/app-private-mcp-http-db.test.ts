import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import test, { after } from "node:test";
import { createReviewedResourceSyncFixture } from "./fixtures/resource-sync-v5.js";
const target = process.env.DEFT_TEST_DATABASE_URL;
const pgFailures: { code?: string; message?: string }[] = [];
const queryPrototype = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
const originalQuery = queryPrototype.query;
let observeTerminalToken: ((pid: number) => void) | undefined;
let pauseTerminalToken: ((pid: number) => Promise<void>) | undefined;
queryPrototype.query = function (...args: unknown[]) {
    const queryText = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text;
    if (queryText?.includes('SELECT id FROM mcp_tokens') && queryText.includes('FOR SHARE')) {
        observeTerminalToken?.((this as unknown as { processID: number }).processID);
        if (pauseTerminalToken) {
            return pauseTerminalToken((this as unknown as { processID: number }).processID).then(() => Reflect.apply(originalQuery, this, args));
        }
    }
    const result = Reflect.apply(originalQuery, this, args);
    if (result instanceof Promise) return result.catch((error: { code?: string; message?: string }) => {
        const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text;
        if (text?.includes('INSERT INTO app_private_mcp_grants')) pgFailures.push({ code: error.code, message: error.message });
        throw error;
    });
    return result;
};
const safe = (() => {
    try {
        if (!target || target !== process.env.DATABASE_URL) {
            return false;
        }
        const u = new URL(target);
        return ["postgres:", "postgresql:"].includes(u.protocol) && u.username === "gate_g_test" && !u.password && u.hostname === "127.0.0.1" && u.port === "55435" && /^\/gate_g_20260927_c20_private_mcp_test(?:_v[0-9]+)?$/.test(u.pathname) && !u.search && !u.hash;
    }
    catch {
        return false;
    }
})();
Object.assign(process.env, {
    DEFT_APPS_ENABLED: "true",
    DEFT_APP_RUNS_ENABLED: "true",
    DEFT_APP_RUN_APP_ORIGIN_ENABLED: "true",
    DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: "true",
    DEFT_APP_PRIVATE_SHARING_ENABLED: "true", DEFT_APP_PRIVATE_MCP_ENABLED: "true"
});
const ring = (purpose: string) => ({ current: purpose, keys: { [purpose]: createHash("sha256").update(`c20-private-mcp:${purpose}`).digest("base64") } });
process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({
    schema_version: "deft.app_run_keyring.v1",
    run_encryption: ring("enc"),
    receipt_signing: ring("sign"),
    fingerprint: ring("fp")
});
after(async () => {
    queryPrototype.query = originalQuery;
    await (await import("../src/lib/app-run-runtime.js")).shutdownAppRunRuntime();
    await (await import("../src/lib/db.js")).closeDb();
});
async function fixture() {
    const [{ db }, s, { eq, and, sql }, runtimeModule, web, routes, { Hono }] = await Promise.all([import("../src/lib/db.js"), import("@deft/db/schema"), import("drizzle-orm"), import("../src/lib/app-run-runtime.js"), import("../src/lib/web-sessions.js"), import("../src/routes/app-private-mcp.js"), import("hono")]);
    const runtime = await runtimeModule.getAppRunRuntime();
    const owned = await createReviewedResourceSyncFixture({ keys: runtime.keys, clock: () => new Date(), descriptor: {
            schema_version: "deft.app_sync_descriptor.v1",
            key: "inbox",
            runtime_requirement_key: "provider",
            resource_type: "email_message",
            requested_visibility: "user_private",
            label_field: "subject",
            record_schema: {
                type: "object",
                properties: { subject: { type: "string", maxLength: 200 }, body: { type: "string", maxLength: 10000 } },
                required: ["subject", "body"],
                additionalProperties: false
            }
        } });
    const sessions = async (userId: string) => {
        const [u] = await db.select().from(s.users).where(eq(s.users.id, userId));
        return web.createWebSession({ id: userId, email: u!.email, org_id: owned.org_id });
    };
    const owner = await sessions(owned.owner_user_id), recipient = await sessions(owned.operator_user_id);
    assert.equal((await runtime.resourceSyncAdmission.admitDue({ org_id: owned.org_id, resource_binding_id: owned.binding_id })).state, "created");
    const credential = await owned.management.issueOperatorSession(owned.operator_actor, owned.binding_id);
    const identity = {
        schema_version: "deft.app_runtime_channel.v2" as const,
        audience: "app_resource_sync" as const,
        session_id: credential.session_id,
        session_token: credential.session_token
    };
    const claim = await runtime.resourceSyncChannel.claim({ ...identity, max_claims: 1 });
    assert.ok(claim);
    const attempt = {
        ...identity,
        run_id: claim.run_id,
        attempt_id: claim.attempt_id,
        claim_token: claim.claim_token,
        sequence: claim.sequence
    };
    assert.ok(await runtime.resourceSyncChannel.start(attempt));
    assert.ok(await runtime.resourceSyncChannel.complete({
        ...attempt,
        status: "returned",
        provider_succeeded: true,
        page: {
            schema_version: "deft.app_sync_page.v1",
            upserts: [{ id: "provider-mail-1", revision: "r1", data: { subject: "Private subject must not persist", body: "Explicit selected plain body" } }, { id: "provider-mail-2", revision: "r1", data: { subject: "Other private subject", body: "Second body" } }],
            tombstones: [],
            next_cursor: null,
            has_more: false
        }
    }));
    const [projection] = await db.select().from(s.appResourceProjections).where(and(eq(s.appResourceProjections.org_id, owned.org_id), eq(s.appResourceProjections.resource_binding_id, owned.binding_id))).limit(1);
    const ref = {
        schema_version: "deft.resource_ref.v2",
        provider: { kind: "app_runtime", provider_instance_id: owned.registration_id },
        resource_type: "email_message",
        resource_id: projection!.id
    };
    const app = new Hono();
    app.route('/api/app-resource-access', (await import('../src/routes/app-resource-access.js')).appResourceAccessRoutes);
    app.route("/api/app-private-mcp", routes.appPrivateMcpRoutes);
    app.route("/api/mcp/v1", (await import("../src/routes/mcp-server-v1.js")).mcpServerV1Routes);
    const personal = await (await import("../src/lib/mcp-token.js")).issuePersonalMcpToken({ orgId: owned.org_id, userId: owned.owner_user_id, name: "Explicit private MCP fixture", scopes: ["read:app-private-resources"], createdBy: owned.owner_user_id });
    const call = async (path: string, method = "GET", body?: unknown, token = owner.accessToken) => {
        const response = await app.request("http://local.test/api/app-private-mcp" + path, { method, headers: { Authorization: "Bearer " + token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, body: await response.json() as any };
    };
    const request = {
        schema_version: "deft.app_private_mcp_review.v1",
        ref,
        destination: { kind: "personal_mcp", token_id: personal.tokenId },
        operations: ["cite", "read", "search"],
        field_keys: ["body"],
        expires_at: new Date(Date.now() + 3600000).toISOString()
    };
    return {
        db,
        s,
        eq,
        and,
        sql,
        runtime,
        owned,
        owner,
        recipient,
        projection: projection!,
        ref,
        call,
        request, app, personal
    };
}

test('Actual issued personal credential receives only independently reviewed private context over MCP TCP', { skip: !safe }, async () => {
    const h = await fixture();
    const { serve } = await import('@hono/node-server');
    const server = serve({ fetch: h.app.fetch, port: 0 });
    try {
        if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const base = `http://127.0.0.1:${address.port}`;
        const mcp = async (name: string, args: unknown, raw = h.personal.raw, rpc = true) => {
            const response = await fetch(base + '/api/mcp/v1' + (rpc ? '' : '/tools/call'), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + raw }, body: JSON.stringify(rpc ? { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } : { name, arguments: args }) });
            assert.equal(response.status, 200);
            const body = await response.json() as any;
            return rpc ? body.result : body;
        };
        const readArgs = (id: string) => ({ schema_version: 'deft.app_private_mcp_read.v1', grant_id: id });
        // A live, scoped first-class token is insufficient without separate consent.
        assert.equal((await mcp('app_private_resource_read', readArgs('00000000-0000-4000-8000-000000000001'))).isError, true);
        const humanCall = async (path: string, body: unknown) => {
            const response = await h.app.request('http://local.test/api/app-resource-access' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + h.owner.accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            assert.equal(response.status, path === '/reviews' ? 200 : 201);
            return await response.json() as any;
        };
        const humanReview = await humanCall('/reviews', { ...h.request, schema_version: 'deft.app_resource_access_review.v1', destination: { kind: 'human', user_id: h.owned.operator_user_id } });
        const humanGrant = await humanCall('/grants', { review_token: humanReview.review_token, review_digest: humanReview.review_digest, accept_access: true });
        assert.equal((await mcp('app_private_resource_read', readArgs(humanGrant.grant_id))).isError, true, 'accepted human access never grants MCP-purpose authority');
        const review = await h.call('/reviews', 'POST', h.request);
        assert.equal(review.status, 200, JSON.stringify(review.body));
        assert.equal(review.body.snapshot.purpose, 'mcp_private_context');
        assert.ok(Date.parse(review.body.snapshot.expires_at) <= Date.now() + 900000);
        assert.deepEqual(review.body.selected_data, { body: 'Explicit selected plain body' });
        assert.ok(!JSON.stringify(review.body.snapshot).includes('Explicit selected plain body'));
        assert.ok(!JSON.stringify(review.body.snapshot).includes('Private subject must not persist'));
        const accept = { review_token: review.body.review_token, review_digest: review.body.review_digest, accept_access: true };
        const grant = await h.call('/grants', 'POST', accept);
        assert.equal(grant.status, 201, JSON.stringify(pgFailures));
        assert.deepEqual((await h.call('/grants', 'POST', accept)).body, grant.body);
        for (const rpc of [true, false]) {
            const result = await mcp('app_private_resource_read', readArgs(grant.body.grant_id), h.personal.raw, rpc);
            assert.notEqual(result.isError, true, JSON.stringify(result));
            const record = JSON.parse(result.content[0].text);
            assert.deepEqual(record.data, { body: 'Explicit selected plain body' });
            assert.equal(record.label, 'Private App record');
            assert.equal(Object.hasOwn(record, 'ref'), false);
            assert.ok(!JSON.stringify(record).includes('Private subject must not persist'));
        }
        const other = await (await import('../src/lib/mcp-token.js')).issuePersonalMcpToken({ orgId: h.owned.org_id, userId: h.owned.owner_user_id, name: 'Distinct token same owner', scopes: ['read:app-private-resources'], createdBy: h.owned.owner_user_id });
        assert.equal((await mcp('app_private_resource_read', readArgs(grant.body.grant_id), other.raw)).isError, true);
        const citation = await mcp('app_private_resource_cite', { schema_version: 'deft.app_private_mcp_cite.v1', grant_id: grant.body.grant_id });
        assert.notEqual(citation.isError, true);
        const cite = JSON.parse(citation.content[0].text);
        assert.equal((await mcp('app_private_resource_read', { schema_version: 'deft.app_private_mcp_read.v1', citation_token: cite.citation_token })).isError, undefined);
        const search = await mcp('app_private_resource_search', { schema_version: 'deft.app_private_mcp_search.v1', grant_id: grant.body.grant_id, query: 'selected', field_keys: ['body'] });
        assert.notEqual(search.isError, true, JSON.stringify(search));
        assert.equal(JSON.parse(search.content[0].text).hits.length, 1);
        assert.equal((await h.call('/grants/' + grant.body.grant_id, 'DELETE')).status, 200);
        assert.equal((await mcp('app_private_resource_read', readArgs(grant.body.grant_id))).isError, true);
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});

test('MCP grant SQL preserves closed independent purpose immutable pins and fifteen-minute ceiling', { skip: !safe }, async () => {
    const h = await fixture();
    const review = await h.call('/reviews', 'POST', h.request);
    assert.equal(review.status, 200);
    const grant = await h.call('/grants', 'POST', { review_token: review.body.review_token, review_digest: review.body.review_digest, accept_access: true });
    assert.equal(grant.status, 201);
    const row = (await h.db.execute(h.sql`SELECT * FROM app_private_mcp_grants WHERE org_id=${h.owned.org_id} AND id=${grant.body.grant_id}`)).rows[0] as any;
    assert.equal(row.snapshot.purpose, 'mcp_private_context');
    assert.ok(!JSON.stringify(row.snapshot).includes('Explicit selected plain body'));
    assert.ok(!JSON.stringify(row.snapshot).includes('Private subject must not persist'));
    const invalid = async (snapshot: any, expires = row.expires_at) => {
        await assert.rejects(h.db.execute(h.sql`INSERT INTO app_private_mcp_grants(id,org_id,owner_user_id,subject_user_id,mcp_token_id,app_installation_id,resource_binding_id,checkpoint_id,projection_id,review_digest,snapshot,accepted_at,expires_at) VALUES(${randomUUID()},${row.org_id},${row.owner_user_id},${row.subject_user_id},${row.mcp_token_id},${row.app_installation_id},${row.resource_binding_id},${row.checkpoint_id},${row.projection_id},${'sha256:' + createHash('sha256').update(randomUUID()).digest('hex')},${JSON.stringify(snapshot)}::jsonb,clock_timestamp(),${expires}::timestamptz)`));
    };
    const missing = { ...row.snapshot }; delete missing.purpose;
    await invalid(missing);
    await invalid({ ...row.snapshot, purpose: 'human_view' });
    await invalid({ ...row.snapshot, selected_data: { body: 'Forbidden durable plaintext' } });
    await invalid({ ...row.snapshot, destination: { ...row.snapshot.destination, actor: 'defty' } });
    await invalid({ ...row.snapshot, ref: { ...row.snapshot.ref, provider: { ...row.snapshot.ref.provider, secret: 'forbidden' } } });
    await invalid({ ...row.snapshot, operations: ['read', 'read'] });
    await invalid({ ...row.snapshot, field_keys: ['body', 'body'] });
    await invalid({ ...row.snapshot, field_keys: [null] });
    await invalid({ ...row.snapshot, ref: { ...row.snapshot.ref, resource_type: null } });
    await invalid({ ...row.snapshot, subject_user_id: null });
    const tooLate = new Date(Date.now() + 16 * 60000).toISOString();
    await invalid({ ...row.snapshot, expires_at: tooLate }, tooLate);
    await assert.rejects(h.db.execute(h.sql`UPDATE app_private_mcp_grants SET accepted_sequence=accepted_sequence+1 WHERE org_id=${row.org_id} AND id=${row.id}`));
    await assert.rejects(h.db.execute(h.sql`UPDATE app_private_mcp_grants SET snapshot=snapshot||'{}'::jsonb,review_digest=${'sha256:' + 'a'.repeat(64)} WHERE org_id=${row.org_id} AND id=${row.id}`));
    const count = (await h.db.execute(h.sql`SELECT count(*)::int AS count FROM app_private_mcp_grants WHERE org_id=${row.org_id}`)).rows[0]?.count;
    assert.equal(count, 1);
    assert.equal((await h.call('/grants/' + row.id, 'DELETE')).status, 200);
    await assert.rejects(h.db.execute(h.sql`UPDATE app_private_mcp_grants SET revoked_at=NULL,revoked_by_user_id=NULL WHERE org_id=${row.org_id} AND id=${row.id}`));
});

async function createEmployee(h: Awaited<ReturnType<typeof fixture>>) {
    const { authMiddleware } = await import('../src/middleware/auth.js');
    const { agentEmployeeRoutes } = await import('../src/routes/agent-employees.js');
    h.app.use('/api/agent-employees/*', authMiddleware);
    h.app.route('/api/agent-employees', agentEmployeeRoutes);
    const created = await h.app.request('http://local.test/api/agent-employees', {
        method: 'POST', headers: { Authorization: 'Bearer ' + h.owner.accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Exact private MCP employee', role: 'custom', system_prompt: 'Synthetic private context boundary', mcp_resource_scopes: ['read:app-private-resources'] }),
    });
    assert.equal(created.status, 201);
    const employee = await created.json() as any;
    assert.equal(typeof employee.api_key, 'string');
    return employee;
}

test('Actual employee credential requires separate purpose and live employee policy', { skip: !safe }, async () => {
    const h = await fixture();
    const employee = await createEmployee(h);
    const { resolveMcpPrincipal } = await import('../src/lib/mcp-token.js');
    const principal = await resolveMcpPrincipal(employee.api_key);
    assert.ok(principal);
    const tokenId = principal.token_id;
    assert.equal(typeof tokenId, 'string');
    assert.equal(employee.mcp_token_id, tokenId, 'owner issuance exposes the exact nonsecret credential ID');
    const review = await h.call('/reviews', 'POST', { ...h.request, destination: { kind: 'employee_mcp', token_id: tokenId } });
    assert.equal(review.status, 200);
    let grant = await h.call('/grants', 'POST', { review_token: review.body.review_token, review_digest: review.body.review_digest, accept_access: true });
    assert.equal(grant.status, 201);
    const read = async () => {
        const response = await h.app.request('http://local.test/api/mcp/v1/tools/call', {
            method: 'POST', headers: { Authorization: 'Bearer ' + employee.api_key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'app_private_resource_read', arguments: { schema_version: 'deft.app_private_mcp_read.v1', grant_id: grant.body.grant_id } }),
        });
        assert.equal(response.status, 200);
        return await response.json() as any;
    };
    assert.notEqual((await read()).isError, true);
    await h.db.update(h.s.agentEmployees).set({ disabled_tools: ['app_private_resource_read'] }).where(h.and(h.eq(h.s.agentEmployees.org_id, h.owned.org_id), h.eq(h.s.agentEmployees.id, employee.employee.id)));
    assert.equal((await read()).isError, true);
    await h.db.update(h.s.agentEmployees).set({ disabled_tools: [], unhealthy: true }).where(h.eq(h.s.agentEmployees.id, employee.employee.id));
    assert.equal((await read()).isError, true);
    await h.db.update(h.s.agentEmployees).set({ unhealthy: false }).where(h.eq(h.s.agentEmployees.id, employee.employee.id));
    assert.equal((await read()).isError, true, 'restored employee policy never revives an older authorization-version grant');
    const freshReview = await h.call('/reviews', 'POST', { ...h.request, destination: { kind: 'employee_mcp', token_id: tokenId } });
    assert.equal(freshReview.status, 200);
    grant = await h.call('/grants', 'POST', { review_token: freshReview.body.review_token, review_digest: freshReview.body.review_digest, accept_access: true });
    assert.equal(grant.status, 201);
    assert.notEqual((await read()).isError, true, 'fresh explicit consent pins the restored policy');
    process.env.DEFT_APP_PRIVATE_MCP_ENABLED = 'false';
    try { assert.equal((await read()).isError, true); }
    finally { process.env.DEFT_APP_PRIVATE_MCP_ENABLED = 'true'; }
    assert.notEqual((await read()).isError, true, 'operational gate re-enable preserves a still-current grant');
    await h.db.update(h.s.mcpTokens).set({ scopes: ['read:modules'] }).where(h.eq(h.s.mcpTokens.id, tokenId));
    assert.equal((await read()).isError, true);
    await h.db.update(h.s.mcpTokens).set({ scopes: ['read:modules', 'read:app-private-resources'], app_run_authorization_version: h.sql`${h.s.mcpTokens.app_run_authorization_version}+1` }).where(h.eq(h.s.mcpTokens.id, tokenId));
    assert.equal((await read()).isError, true, 'restored scopes never revive an older credential-version consent');
});

test('Employee credential rotation and private read share employee-before-token lock order', { skip: !safe }, async () => {
    const h = await fixture();
    const employee = await createEmployee(h);
    const { resolveMcpPrincipal, createPrivateMcpInvocation, issueScopedEmployeeMcpToken } = await import('../src/lib/mcp-token.js');
    const principal = await resolveMcpPrincipal(employee.api_key);
    const invocation = createPrivateMcpInvocation(principal, new AbortController().signal);
    assert.ok(invocation);
    const review = await h.call('/reviews', 'POST', { ...h.request, destination: { kind: 'employee_mcp', token_id: principal.token_id } });
    assert.equal(review.status, 200);
    const grant = await h.call('/grants', 'POST', { review_token: review.body.review_token, review_digest: review.body.review_digest, accept_access: true });
    assert.equal(grant.status, 201);
    const observer = new pg.Client({ connectionString: target });
    await observer.connect();
    let readerPid = 0;
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const proceed = new Promise<void>(resolve => { release = resolve; });
    pauseTerminalToken = async pid => { readerPid = pid; entered(); await proceed; };
    try {
        const { AppPrivateMcpService } = await import('../src/lib/app-private-mcp-service.js');
        const reading = new AppPrivateMcpService(h.runtime.keys).read(invocation, grant.body.grant_id);
        const readingSettled = reading.then(() => ({ allowed: true }), error => ({ allowed: false, error: String(error) }));
        await ready;
        const rotation = issueScopedEmployeeMcpToken({ orgId: h.owned.org_id, employeeId: employee.employee.id, resourceScopes: ['read:app-private-resources'], revokeExisting: true, bcryptRounds: 4 });
        const rotationSettled = rotation.then(() => true, () => false);
        let managerPid = 0;
        for (let attempt = 0; attempt < 100; attempt++) {
            const rows = await observer.query('SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))', [readerPid]);
            if (rows.rows.length) { managerPid = rows.rows[0].pid; break; }
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(managerPid, 'actual issuer must wait on the reader employee row');
        release();
        const [readResult, rotated] = await Promise.all([readingSettled, rotationSettled]);
        assert.equal(rotated, true, 'credential manager must finish');
        assert.equal(readResult.allowed, true, 'read already holding employee authority must settle before rotation');
    } finally {
        release(); pauseTerminalToken = undefined;
        await observer.end();
    }
});

test('Captured actual credential denies withdrawal after a real terminal token row wait', { skip: !safe }, async () => {
    const h = await fixture();
    const review = await h.call('/reviews', 'POST', h.request);
    assert.equal(review.status, 200);
    const grant = await h.call('/grants', 'POST', { review_token: review.body.review_token, review_digest: review.body.review_digest, accept_access: true });
    assert.equal(grant.status, 201);
    const { resolveMcpPrincipal, createPrivateMcpInvocation } = await import('../src/lib/mcp-token.js');
    const principal = await resolveMcpPrincipal(h.personal.raw);
    const invocation = createPrivateMcpInvocation(principal, new AbortController().signal);
    assert.ok(invocation);
    const blocker = new pg.Client({ connectionString: target });
    const observer = new pg.Client({ connectionString: target });
    await blocker.connect(); await observer.connect();
    const { AppPrivateMcpService } = await import('../src/lib/app-private-mcp-service.js');
    try {
        await blocker.query('BEGIN');
        await blocker.query('UPDATE mcp_tokens SET revoked_at=clock_timestamp(),app_run_authorization_version=app_run_authorization_version+1 WHERE org_id=$1 AND id=$2', [h.owned.org_id, h.personal.tokenId]);
        let terminalPid = 0;
        let entered!: () => void;
        const terminal = new Promise<void>(resolve => { entered = resolve; });
        observeTerminalToken = pid => { terminalPid = pid; entered(); };
        const result = new AppPrivateMcpService(h.runtime.keys).read(invocation, grant.body.grant_id);
        const denied = assert.rejects(result, /unavailable/i);
        await terminal;
        const blockers = await observer.query('SELECT pg_blocking_pids($1) AS blockers', [terminalPid]);
        assert.ok(blockers.rows[0].blockers.includes((blocker as unknown as { processID: number }).processID), 'actual terminal token query must wait on credential manager');
        await blocker.query('COMMIT');
        await denied;
        const audits = await h.db.execute(h.sql`SELECT count(*)::int AS count FROM audit_log WHERE org_id=${h.owned.org_id} AND action='app_private_mcp.read'`);
        assert.equal(audits.rows[0]?.count, 0);
    } finally {
        observeTerminalToken = undefined;
        await blocker.query('ROLLBACK').catch(() => undefined);
        await blocker.end(); await observer.end();
    }
});

test('MCP owner inventory and thirty-day metadata retention remain bounded and independently revocable', { skip: !safe }, async () => {
    const h = await fixture();
    const review = await h.call('/reviews', 'POST', h.request);
    assert.equal(review.status, 200);
    const grant = await h.call('/grants', 'POST', { review_token: review.body.review_token, review_digest: review.body.review_digest, accept_access: true });
    assert.equal(grant.status, 201);
    const row = (await h.db.execute(h.sql`SELECT * FROM app_private_mcp_grants WHERE org_id=${h.owned.org_id} AND id=${grant.body.grant_id}`)).rows[0] as any;
    const accepted = new Date(Date.now() - 31 * 86400000), expired = new Date(accepted.getTime() + 600000);
    const oldId = randomUUID();
    const oldSnapshot = { ...row.snapshot, expires_at: expired.toISOString(), review_expires_at: new Date(accepted.getTime() + 300000).toISOString() };
    const { canonicalCapabilityJson } = await import('@deft/shared');
    const oldDigest = 'sha256:' + createHash('sha256').update(canonicalCapabilityJson(oldSnapshot)).digest('hex');
    await h.db.execute(h.sql`INSERT INTO app_private_mcp_grants(id,org_id,owner_user_id,subject_user_id,mcp_token_id,app_installation_id,resource_binding_id,checkpoint_id,projection_id,review_digest,snapshot,accepted_at,expires_at) VALUES(${oldId},${row.org_id},${row.owner_user_id},${row.subject_user_id},${row.mcp_token_id},${row.app_installation_id},${row.resource_binding_id},${row.checkpoint_id},${row.projection_id},${oldDigest},${JSON.stringify(oldSnapshot)}::jsonb,${accepted.toISOString()}::timestamptz,${expired.toISOString()}::timestamptz)`);
    const input = { app_installation_id: row.app_installation_id };
    const before = await h.call('/inventory', 'POST', input);
    assert.equal(before.status, 200);
    assert.equal(before.body.items.length, 2);
    assert.equal(before.body.next_cursor, null);
    assert.ok(!JSON.stringify(before.body).includes('Explicit selected plain body'));
    assert.deepEqual((await h.call('/prune', 'POST', {})).body, { removed: 1 });
    const after = await h.call('/inventory', 'POST', input);
    assert.equal(after.status, 200);
    assert.deepEqual(after.body.items.map((item: any) => item.grant_id), [grant.body.grant_id]);
    process.env.DEFT_APP_PRIVATE_MCP_ENABLED = 'false';
    try { assert.equal((await h.call('/grants/' + grant.body.grant_id, 'DELETE')).status, 200); }
    finally { process.env.DEFT_APP_PRIVATE_MCP_ENABLED = 'true'; }
    const retained = await h.db.execute(h.sql`SELECT count(*)::int AS count FROM audit_log WHERE org_id=${h.owned.org_id} AND action='app_private_mcp.prune'`);
    assert.equal(retained.rows[0]?.count, 1);
});

test('Maximum MCP grant remains within the database ceiling when application clock is ahead', { skip: !safe }, async () => {
    const h = await fixture();
    const { resourceSyncWebAuthority } = await import('../src/lib/app-resource-sync-web-authority.js');
    const { AppPrivateMcpService } = await import('../src/lib/app-private-mcp-service.js');
    const { actor, guard, web_session } = await resourceSyncWebAuthority('Bearer ' + h.owner.accessToken);
    const caller = { org_id: actor.org_id, user_id: actor.actor_id, sid: web_session.sid, guard };
    // Inject only this service clock; neither host nor PostgreSQL clock changes.
    const service = new AppPrivateMcpService(h.runtime.keys, () => new Date(Date.now() + 30000));
    const review = await service.prepare(caller, h.request);
    const grant = await service.accept(caller, { review_token: review.review_token, review_digest: review.review_digest, accept_access: true });
    const row = (await h.db.execute(h.sql`SELECT expires_at<=accepted_at+interval '15 minutes' AS bounded FROM app_private_mcp_grants WHERE org_id=${h.owned.org_id} AND id=${grant.grant_id}`)).rows[0];
    assert.equal(row?.bounded, true);
});

test('Database-expired MCP grant denies disclosure when application clock is behind', { skip: !safe }, async () => {
    const h = await fixture();
    const review = await h.call('/reviews', 'POST', { ...h.request, expires_at: new Date(Date.now() + 600000).toISOString() });
    assert.equal(review.status, 200);
    const { canonicalCapabilityJson } = await import('@deft/shared');
    const accepted = new Date(Date.now() - 300000), expires = new Date(Date.now() - 60000);
    const snapshot = { ...review.body.snapshot, expires_at: expires.toISOString(), review_expires_at: new Date(accepted.getTime() + 60000).toISOString() };
    const id = randomUUID(), digest = 'sha256:' + createHash('sha256').update(canonicalCapabilityJson(snapshot)).digest('hex');
    await h.db.execute(h.sql`INSERT INTO app_private_mcp_grants(id,org_id,owner_user_id,subject_user_id,mcp_token_id,app_installation_id,resource_binding_id,checkpoint_id,projection_id,review_digest,snapshot,accepted_at,expires_at) VALUES(${id},${snapshot.org_id},${snapshot.owner_user_id},${snapshot.subject_user_id},${snapshot.destination.token_id},${snapshot.app_installation_id},${snapshot.resource_binding_id},${snapshot.checkpoint_id},${snapshot.ref.resource_id},${digest},${JSON.stringify(snapshot)}::jsonb,${accepted.toISOString()}::timestamptz,${expires.toISOString()}::timestamptz)`);
    const { resolveMcpPrincipal, createPrivateMcpInvocation } = await import('../src/lib/mcp-token.js');
    const invocation = createPrivateMcpInvocation(await resolveMcpPrincipal(h.personal.raw), new AbortController().signal);
    assert.ok(invocation);
    const { AppPrivateMcpService } = await import('../src/lib/app-private-mcp-service.js');
    await assert.rejects(new AppPrivateMcpService(h.runtime.keys, () => new Date(Date.now() - 120000)).read(invocation, id), /unavailable/i);
    const audits = await h.db.execute(h.sql`SELECT count(*)::int AS count FROM audit_log WHERE org_id=${h.owned.org_id} AND action='app_private_mcp.read'`);
    assert.equal(audits.rows[0]?.count, 0);
});
