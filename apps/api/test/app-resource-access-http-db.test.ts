import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after } from "node:test";
import { createReviewedResourceSyncFixture } from "./fixtures/resource-sync-v5.js";
const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = (() => {
    try {
        if (!target || target !== process.env.DATABASE_URL) {
            return false;
        }
        const u = new URL(target);
        return ["postgres:", "postgresql:"].includes(u.protocol) && u.username === "gate_g_test" && !u.password && u.hostname === "127.0.0.1" && u.port === "55435" && /^\/gate_g_20260927_c16_private_sharing_test(?:_v[0-9]+)?$/.test(u.pathname) && !u.search && !u.hash;
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
    DEFT_APP_PRIVATE_SHARING_ENABLED: "true"
});
const ring = (purpose: string) => ({ current: purpose, keys: { [purpose]: createHash("sha256").update(`c16-private-sharing:${purpose}`).digest("base64") } });
process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({
    schema_version: "deft.app_run_keyring.v1",
    run_encryption: ring("enc"),
    receipt_signing: ring("sign"),
    fingerprint: ring("fp")
});
after(async () => {
    await (await import("../src/lib/app-run-runtime.js")).shutdownAppRunRuntime();
    await (await import("../src/lib/db.js")).closeDb();
});
async function fixture() {
    const [{ db }, s, { eq, and, sql }, runtimeModule, web, routes, { Hono }] = await Promise.all([import("../src/lib/db.js"), import("@deft/db/schema"), import("drizzle-orm"), import("../src/lib/app-run-runtime.js"), import("../src/lib/web-sessions.js"), import("../src/routes/app-resource-access.js"), import("hono")]);
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
    app.route("/api/app-resource-access", routes.appResourceAccessRoutes);
    const call = async (path: string, method = "GET", body?: unknown, token = owner.accessToken) => {
        const response = await app.request("http://local.test/api/app-resource-access" + path, { method, headers: { Authorization: "Bearer " + token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, body: await response.json() as any };
    };
    const request = {
        schema_version: "deft.app_resource_access_review.v1",
        ref,
        destination: { kind: "human", user_id: owned.operator_user_id },
        operations: ["read"],
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
        request
    };
}
test("Human exact-record sharing requires explicit immutable consent and current recipient authority", { skip: !safe }, async (t) => {
    const h = await fixture();
    let review: any, grant: string;
    await t.test("Default off and closed human-only review; cancellation creates no authority", async () => {
        process.env.DEFT_APP_PRIVATE_SHARING_ENABLED = "false";
        assert.equal((await h.call("/reviews", "POST", h.request)).status, 404);
        process.env.DEFT_APP_PRIVATE_SHARING_ENABLED = "true";
        assert.equal((await h.call("/reviews", "POST", { ...h.request, destination: { kind: "agent", employee_id: h.owned.operator_user_id } })).status, 400);
        assert.equal((await h.call("/reviews?extra=1", "POST", h.request)).status, 400);
        const r = await h.call("/reviews", "POST", h.request);
        assert.equal(r.status, 200);
        review = r.body;
        assert.deepEqual(Object.keys(review.selected_data), ["body"]);
        const signed = JSON.parse(Buffer.from(review.review_token.split(".")[0], "base64url").toString());
        assert.equal(Object.hasOwn(signed.value, "selected_data"), false);
        assert.ok(!JSON.stringify(signed).includes(String(review.selected_data.body)));
        assert.equal(review.record_label, "Shared App record");
        assert.equal(Object.hasOwn(review.snapshot, "record_label"), false);
        assert.equal((await h.db.select().from(h.s.appResourceAccessGrants).where(h.eq(h.s.appResourceAccessGrants.org_id, h.owned.org_id))).length, 0);
    });
    await t.test("Accept is idempotent; recipient gets only selected plain scalar and generic label; owner wrapper is not inherited", async () => {
        const input = { review_token: review.review_token, review_digest: review.review_digest, accept_access: true };
        const a = await h.call("/grants", "POST", input);
        assert.equal(a.status, 201);
        grant = a.body.grant_id;
        assert.equal((await h.call("/grants", "POST", input)).body.grant_id, grant);
        const r = await h.call(`/grants/${grant}/resource`, "GET", undefined, h.recipient.accessToken);
        assert.equal(r.status, 200);
        assert.equal(r.body.label, "Shared App record");
        assert.deepEqual(Object.keys(r.body.data), ["body"]);
        assert.equal(Object.hasOwn(r.body.data, "subject"), false);
        assert.equal((await h.call(`/grants/${grant}/resource`)).status, 404);
        const [g] = await h.db.select().from(h.s.appResourceAccessGrants).where(h.eq(h.s.appResourceAccessGrants.id, grant));
        assert.ok(!JSON.stringify(g!.snapshot).includes("Private subject"));
        assert.ok(!JSON.stringify(g!.snapshot).includes("Explicit selected"));
    });
    await t.test("Revocation still works after recipient removal and feature withdrawal, audit atomic, no decryption needed", async () => {
        await h.db.update(h.s.orgMembers).set({ is_active: false }).where(h.and(h.eq(h.s.orgMembers.org_id, h.owned.org_id), h.eq(h.s.orgMembers.user_id, h.owned.operator_user_id)));
        process.env.DEFT_APP_PRIVATE_SHARING_ENABLED = "false";
        assert.equal((await h.call(`/grants/${grant}`, "DELETE")).status, 200);
        assert.equal((await h.call(`/grants/${grant}`, "DELETE")).status, 200);
        process.env.DEFT_APP_PRIVATE_SHARING_ENABLED = "true";
        assert.notEqual((await h.call(`/grants/${grant}/resource`, "GET", undefined, h.recipient.accessToken)).status, 200);
        const audit = await h.db.select().from(h.s.auditLog).where(h.and(h.eq(h.s.auditLog.org_id, h.owned.org_id), h.eq(h.s.auditLog.entity_id, grant), h.eq(h.s.auditLog.action, "app_resource_access.revoke")));
        assert.equal(audit.length, 1);
    });
});
test("Accept rolls back authority when sharing gate is withdrawn during its final audit INSERT wait", { skip: !safe }, async () => {
    const h = await fixture();
    const { default: pg } = await import("pg");
    const blocker = new pg.Client({ connectionString: target }), observer = new pg.Client({ connectionString: target });
    await blocker.connect();
    await observer.connect();
    try {
        const review = await h.call("/reviews", "POST", h.request);
        assert.equal(review.status, 200);
        await blocker.query("BEGIN");
        await blocker.query("LOCK TABLE audit_log IN ACCESS EXCLUSIVE MODE");
        const pending = h.call("/grants", "POST", { review_token: review.body.review_token, review_digest: review.body.review_digest, accept_access: true });
        let held = false;
        for (let i = 0; i < 100; i++) {
            const r = await observer.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%insert%audit_log%'");
            if (r.rowCount) {
                held = true;
                break;
            }
            await new Promise(r => setTimeout(r, 5));
        }
        assert.ok(held, "Actual final audit INSERT must wait on held table lock");
        process.env.DEFT_APP_PRIVATE_SHARING_ENABLED = "false";
        await blocker.query("COMMIT");
        const result = await pending;
        process.env.DEFT_APP_PRIVATE_SHARING_ENABLED = "true";
        assert.equal(result.status, 404, "Withdrawal during final awaited write must deny inside transaction");
        assert.equal((await h.db.select().from(h.s.appResourceAccessGrants).where(h.eq(h.s.appResourceAccessGrants.org_id, h.owned.org_id))).length, 0);
    }
    finally {
        process.env.DEFT_APP_PRIVATE_SHARING_ENABLED = "true";
        await blocker.query("ROLLBACK").catch(() => {
        });
        await blocker.end();
        await observer.end();
    }
});
test("Private projection deletion remains forbidden and parent consent withdrawal denies links", { skip: !safe }, async () => {
    const h = await fixture();
    const r = await h.call("/reviews", "POST", { ...h.request, operations: ["cite", "read"] });
    assert.equal(r.status, 200);
    const a = await h.call("/grants", "POST", { review_token: r.body.review_token, review_digest: r.body.review_digest, accept_access: true });
    assert.equal(a.status, 201);
    await assert.rejects(h.db.delete(h.s.appResourceProjections).where(h.eq(h.s.appResourceProjections.id, h.ref.resource_id)), (error: any) => error.cause?.code === "55000");
    const citation = await h.call("/grants/" + a.body.grant_id + "/citation", "GET", undefined, h.recipient.accessToken);
    assert.equal(citation.status, 200);
    assert.equal(Object.hasOwn(citation.body, "data"), false);
    assert.equal(citation.body.label, "Shared App record");
    await h.owned.management.revokeConsent(h.owned.owner_actor, h.owned.binding_id);
    assert.equal((await h.call("/grants/" + a.body.grant_id + "/resource", "GET", undefined, h.recipient.accessToken)).status, 404);
    assert.equal((await h.call("/grants/" + a.body.grant_id + "/citation", "GET", undefined, h.recipient.accessToken)).status, 404);
    assert.equal((await h.call("/grants/" + a.body.grant_id, "DELETE")).status, 200);
});
test("Read-only consent cannot gain search or citation; recipient inventory copies no private content", { skip: !safe }, async () => {
    const h = await fixture();
    const r = await h.call("/reviews", "POST", h.request);
    assert.equal(r.status, 200);
    const a = await h.call("/grants", "POST", { review_token: r.body.review_token, review_digest: r.body.review_digest, accept_access: true });
    assert.equal(a.status, 201);
    assert.equal((await h.call("/grants/" + a.body.grant_id + "/citation", "GET", undefined, h.recipient.accessToken)).status, 404);
    assert.equal((await h.call("/grants/" + a.body.grant_id + "/search", "POST", { query: "body", field_keys: ["body"] }, h.recipient.accessToken)).status, 404);
    const list = await h.call("/inventory", "POST", {}, h.recipient.accessToken);
    assert.equal(list.status, 200);
    assert.equal(list.body.complete, true);
    assert.deepEqual(Object.keys(list.body.items[0]).sort(), ["expires_at", "grant_id", "label", "state"]);
    assert.equal(list.body.items[0].label, "Shared App record");
});
test("Revoke rolls back when owner human identity changes during final audit write", { skip: !safe }, async () => {
    const h = await fixture();
    const { default: pg } = await import("pg");
    const blocker = new pg.Client({ connectionString: target }), observer = new pg.Client({ connectionString: target });
    await blocker.connect();
    await observer.connect();
    let grant;
    try {
        const r = await h.call("/reviews", "POST", h.request);
        assert.equal(r.status, 200);
        const a = await h.call("/grants", "POST", { review_token: r.body.review_token, review_digest: r.body.review_digest, accept_access: true });
        assert.equal(a.status, 201);
        grant = a.body.grant_id;
        await blocker.query("BEGIN");
        await blocker.query("LOCK TABLE audit_log IN ACCESS EXCLUSIVE MODE");
        const pending = h.call("/grants/" + grant, "DELETE");
        let held = false;
        for (let i = 0; i < 100; i++) {
            if ((await observer.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%insert%audit_log%'")).rowCount) {
                held = true;
                break;
            }
            await new Promise(r => setTimeout(r, 5));
        }
        assert.ok(held);
        await observer.query("UPDATE users SET kind='agent' WHERE id=$1", [h.owned.owner_user_id]);
        await blocker.query("COMMIT");
        assert.equal((await pending).status, 403);
        const [g] = await h.db.select().from(h.s.appResourceAccessGrants).where(h.eq(h.s.appResourceAccessGrants.id, grant));
        assert.equal(g.revoked_at, null);
        assert.equal((await h.db.select().from(h.s.auditLog).where(h.and(h.eq(h.s.auditLog.entity_id, grant), h.eq(h.s.auditLog.action, "app_resource_access.revoke")))).length, 0);
    }
    finally {
        await blocker.query("ROLLBACK").catch(() => {
        });
        await observer.query("UPDATE users SET kind='human' WHERE id=$1", [h.owned.owner_user_id]);
        await blocker.end();
        await observer.end();
    }
});
test("Sequence cutoff survives pruning newest metadata and excludes later accepts without skipping old hits", { skip: !safe }, async () => {
    const h = await fixture();
    const ps = await h.db.select().from(h.s.appResourceProjections).where(h.eq(h.s.appResourceProjections.org_id, h.owned.org_id));
    const accepted = [];
    let serial = 0;
    const accept = async (p: any) => {
        const r = await h.call("/reviews", "POST", {
            ...h.request,
            ref: { ...h.ref, resource_id: p.id },
            operations: ["read", "search"],
            expires_at: new Date(Date.now() + 3500000 + (serial++) * 1000).toISOString()
        });
        assert.equal(r.status, 200);
        const a = await h.call("/grants", "POST", { review_token: r.body.review_token, review_digest: r.body.review_digest, accept_access: true });
        assert.equal(a.status, 201);
        return a.body.grant_id;
    };
    for (let i = 0; i < 26; i++)
        accepted.push(await accept(ps[0]));
    const newest = await accept(ps[1]);
    const [g] = await h.db.select().from(h.s.appResourceAccessGrants).where(h.eq(h.s.appResourceAccessGrants.id, newest));
    const body = (await h.call("/grants/" + accepted[0] + "/resource", "GET", undefined, h.recipient.accessToken)).body.data.body;
    const query = { query: body.slice(0, 6), field_keys: ["body"] };
    const { canonicalCapabilityJson } = await import("@deft/shared");
    const snapshot = { ...g.snapshot as any, expires_at: new Date(Date.now() - 31 * 86400000).toISOString(), review_expires_at: new Date(Date.now() - 31 * 86400000).toISOString() };
    const historical = {
        ...g,
        id: crypto.randomUUID(),
        snapshot,
        review_digest: "sha256:" + createHash("sha256").update(canonicalCapabilityJson(snapshot)).digest("hex"),
        accepted_at: new Date(Date.parse(snapshot.expires_at) - 3600000),
        expires_at: new Date(snapshot.expires_at),
        revoked_at: null,
        revoked_by_user_id: null
    };
    delete (historical as any).accepted_sequence;
    const [expired] = await h.db.insert(h.s.appResourceAccessGrants).values(historical).returning();
    const first = await h.call("/grants/" + accepted[0] + "/search", "POST", query, h.recipient.accessToken);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.hits.length, 25);
    assert.equal(first.body.complete, false);
    await h.call("/grants/" + newest, "DELETE");
    const prune = await h.call("/maintenance/prune", "POST", {});
    assert.equal(prune.status, 200);
    assert.equal(prune.body.removed, 1);
    assert.equal((await h.db.select().from(h.s.appResourceAccessGrants).where(h.eq(h.s.appResourceAccessGrants.id, expired.id))).length, 0);
    const later = await accept(ps[0]);
    const [l] = await h.db.select().from(h.s.appResourceAccessGrants).where(h.eq(h.s.appResourceAccessGrants.id, later));
    assert.ok(l.accepted_sequence > expired.accepted_sequence, "Metadata prune must not reset durable sequence watermark");
    const second = await h.call("/grants/" + accepted[0] + "/search", "POST", { ...query, cursor: first.body.next_cursor }, h.recipient.accessToken);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.deepEqual(second.body.hits.map((v: any) => v.grant_id), [accepted[25]]);
    assert.equal(second.body.complete, true);
    assert.equal(second.body.hits.some((v: any) => v.grant_id === later), false);
});
test("Sharing SQL rejects missing unknown null and duplicate-operation snapshots and protects ordering metadata", { skip: !safe }, async () => {
    const h = await fixture();
    const r = await h.call("/reviews", "POST", h.request);
    assert.equal(r.status, 200);
    const a = await h.call("/grants", "POST", { review_token: r.body.review_token, review_digest: r.body.review_digest, accept_access: true });
    assert.equal(a.status, 201);
    const [g] = await h.db.select().from(h.s.appResourceAccessGrants).where(h.eq(h.s.appResourceAccessGrants.id, a.body.grant_id));
    const valid = g.snapshot as any;
    const missing = { ...valid };
    delete missing.operations;
    for (const snapshot of [null, { ...valid, unknown: true }, missing, { ...valid, operations: ["read", "read"] }, { ...valid, app_version_id: null }, { ...valid, ref: { ...valid.ref, provider: { kind: "native", provider_instance_id: valid.registration_id } } }]) {
        const row = {
            ...g,
            id: crypto.randomUUID(),
            snapshot: h.sql `${JSON.stringify(snapshot)}::jsonb`,
            review_digest: "sha256:" + createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")
        };
        delete (row as any).accepted_sequence;
        await assert.rejects(h.db.insert(h.s.appResourceAccessGrants).values(row), (e: any) => e.cause?.code === "23514" && e.cause?.constraint === "app_resource_access_grants_snapshot_check");
    }
    await assert.rejects(h.db.update(h.s.appResourceAccessGrants).set({ accepted_sequence: g.accepted_sequence + 1n }).where(h.eq(h.s.appResourceAccessGrants.id, g.id)), (e: any) => e.cause?.code === "P0001");
    const catalog = await h.db.execute(h.sql `SELECT seqcache,seqcycle FROM pg_sequence WHERE seqrelid=pg_get_serial_sequence('app_resource_access_grants','accepted_sequence')::regclass`);
    assert.equal(Number(catalog.rows[0].seqcache), 1);
    assert.equal(catalog.rows[0].seqcycle, false);
});
test("Exact recipient SID final wait denies a substituted human with zero private output", { skip: !safe }, async () => {
    const h = await fixture();
    const r = await h.call("/reviews", "POST", { ...h.request, operations: ["read", "search"] });
    assert.equal(r.status, 200);
    const a = await h.call("/grants", "POST", { review_token: r.body.review_token, review_digest: r.body.review_digest, accept_access: true });
    assert.equal(a.status, 201);
    const { default: pg } = await import("pg");
    const blocker = new pg.Client({ connectionString: target }), observer = new pg.Client({ connectionString: target });
    await blocker.connect();
    await observer.connect();
    const sid = JSON.parse(Buffer.from(h.recipient.accessToken.split(".")[1], "base64url").toString()).sid;
    try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT id FROM web_sessions WHERE id=$1 FOR UPDATE", [sid]);
        const pending = h.call("/grants/" + a.body.grant_id + "/resource", "GET", undefined, h.recipient.accessToken);
        let held = false;
        for (let i = 0; i < 100; i++) {
            if ((await observer.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%web_sessions%'")).rowCount) {
                held = true;
                break;
            }
            await new Promise(r => setTimeout(r, 2));
        }
        assert.ok(held);
        await observer.query("UPDATE users SET kind='agent' WHERE id=$1", [h.owned.operator_user_id]);
        await blocker.query("COMMIT");
        const result = await pending;
        assert.equal(result.status, 403);
        assert.equal(Object.hasOwn(result.body, "data"), false);
        assert.equal(JSON.stringify(result.body).includes("Explicit selected"), false);
    }
    finally {
        await blocker.query("ROLLBACK").catch(() => {
        });
        await observer.query("UPDATE users SET kind='human' WHERE id=$1", [h.owned.operator_user_id]);
        await blocker.end();
        await observer.end();
    }
});
test('Actual final audit wait cannot accept after immutable review expiry', { skip: !safe }, async () => {
    const h = await fixture();
    const [{ AppResourceAccessService }, { resourceSyncWebAuthority }] = await Promise.all([import('../src/lib/app-resource-access-service.js'), import('../src/lib/app-resource-sync-web-authority.js')]);
    const verified = await resourceSyncWebAuthority('Bearer ' + h.owner.accessToken);
    const caller = { org_id: verified.actor.org_id, user_id: verified.actor.actor_id, sid: verified.web_session.sid, guard: verified.guard };
    let instant = new Date();
    const service = new AppResourceAccessService(h.runtime.keys, () => instant);
    const review = await service.prepare(caller, h.request);
    const { default: pg } = await import('pg');
    const blocker = new pg.Client({ connectionString: target }), observer = new pg.Client({ connectionString: target });
    await blocker.connect();
    await observer.connect();
    try {
        await blocker.query('BEGIN');
        await blocker.query('LOCK TABLE audit_log IN ACCESS EXCLUSIVE MODE');
        const pending = service.accept(caller, { review_token: review.review_token, review_digest: review.review_digest, accept_access: true });
        let held = false;
        for (let i = 0; i < 100; i++) {
            if ((await observer.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%insert%audit_log%'")).rowCount) {
                held = true;
                break;
            }
            await new Promise(r => setTimeout(r, 2));
        }
        assert.ok(held);
        instant = new Date(Date.parse(review.snapshot.review_expires_at) + 1);
        await blocker.query('COMMIT');
        await assert.rejects(pending, (e: any) => e.code === 'APP_RESOURCE_ACCESS_UNAVAILABLE');
        assert.equal((await h.db.select().from(h.s.appResourceAccessGrants).where(h.eq(h.s.appResourceAccessGrants.org_id, h.owned.org_id))).length, 0);
    }
    finally {
        await blocker.query('ROLLBACK').catch(() => { });
        await blocker.end();
        await observer.end();
    }
});
test('Search and inventory continuation deadlines survive an actual final SID wait', { skip: !safe }, async () => {
    const h = await fixture();
    const [{ AppResourceAccessService }, { resourceSyncWebAuthority }, { default: pg }] = await Promise.all([
        import('../src/lib/app-resource-access-service.js'), import('../src/lib/app-resource-sync-web-authority.js'), import('pg')
    ]);
    let instant = new Date();
    const service = new AppResourceAccessService(h.runtime.keys, () => instant);
    const subject = async (token: string) => {
        const v = await resourceSyncWebAuthority('Bearer ' + token);
        return { org_id: v.actor.org_id, user_id: v.actor.actor_id, sid: v.web_session.sid, guard: v.guard };
    };
    const owner = await subject(h.owner.accessToken), recipient = await subject(h.recipient.accessToken);
    const ids: string[] = [];
    for (let i = 0; i < 26; i++) {
        const review = await service.prepare(owner, { ...h.request, operations: ['read', 'search'], expires_at: new Date(instant.getTime() + 3500000 + i * 1000).toISOString() });
        ids.push((await service.accept(owner, { review_token: review.review_token, review_digest: review.review_digest, accept_access: true })).grant_id);
    }
    const firstRecord = await service.read(recipient, ids[0]);
    const query = { query: (firstRecord as {
            data: Record<string, string>;
        }).data.body!.slice(0, 6), field_keys: ['body'] };
    const firstSearch = await service.search(recipient, ids[0], query);
    const firstInventory = await service.inventory(recipient, { view: 'received' });
    assert.ok(firstSearch.next_cursor);
    assert.ok(firstInventory.next_cursor);
    const blocker = new pg.Client({ connectionString: target }), observer = new pg.Client({ connectionString: target });
    await blocker.connect();
    await observer.connect();
    try {
        const outcomes: string[] = [];
        for (const [operation, cursor] of [['search', firstSearch.next_cursor], ['inventory', firstInventory.next_cursor]] as const) {
            instant = new Date();
            await blocker.query('BEGIN');
            await blocker.query('SELECT id FROM web_sessions WHERE id=$1 FOR UPDATE', [recipient.sid]);
            const pending = (operation === 'search' ? service.search(recipient, ids[0], { ...query, cursor }) : service.inventory(recipient, { view: 'received', cursor })).then(value => ({ value }), error => ({ error }));
            let held = false;
            for (let i = 0; i < 100; i++) {
                if ((await observer.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%web_sessions%'")).rowCount) {
                    held = true;
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 2));
            }
            assert.ok(held, operation + ' must reach the actual final SID lock');
            const payload = JSON.parse(Buffer.from(cursor.split('.')[0], 'base64url').toString());
            instant = new Date(Date.parse(payload.value.expires_at) + 1);
            await blocker.query('COMMIT');
            const result = await pending;
            if (!('error' in result && result.error?.code === 'APP_RESOURCE_ACCESS_UNAVAILABLE'))
                outcomes.push(operation);
        }
        assert.deepEqual(outcomes, [], 'Expired continuations admitted after actual final SID waits');
    }
    finally {
        await blocker.query('ROLLBACK').catch(() => { });
        await blocker.end();
        await observer.end();
    }
});
test('Tenant-scoped active and retained admission bounds never block revoke; maintenance removes at most 100', { skip: !safe }, async () => {
    const h = await fixture();
    const review = await h.call('/reviews', 'POST', h.request);
    const accepted = await h.call('/grants', 'POST', { review_token: review.body.review_token, review_digest: review.body.review_digest, accept_access: true });
    assert.equal(accepted.status, 201);
    const [seed] = await h.db.select().from(h.s.appResourceAccessGrants).where(h.eq(h.s.appResourceAccessGrants.id, accepted.body.grant_id));
    const { canonicalCapabilityJson } = await import('@deft/shared');
    const historicalBase = Date.now() - 31 * 86400000;
    const metadata = (i: number, historical: boolean) => {
        const expiry = historical ? new Date(historicalBase - i) : new Date(seed.expires_at.getTime() - i - 1);
        const snapshot = { ...seed.snapshot as any, expires_at: expiry.toISOString(), review_expires_at: historical ? expiry.toISOString() : (seed.snapshot as any).review_expires_at };
        const row = { ...seed, id: crypto.randomUUID(), snapshot, review_digest: 'sha256:' + createHash('sha256').update(canonicalCapabilityJson(snapshot)).digest('hex'), expires_at: expiry, accepted_at: historical ? new Date(expiry.getTime() - 3600000) : seed.accepted_at };
        delete (row as any).accepted_sequence;
        return row;
    };
    // Direct, explicitly synthetic metadata fixtures exercise database admission counts;
    // they are not evidence of normal consent acceptance or independent provider effects.
    await h.db.insert(h.s.appResourceAccessGrants).values(Array.from({ length: 255 }, (_, i) => metadata(i, false)));
    const fresh = await h.call('/reviews', 'POST', { ...h.request, operations: ['cite', 'read'] });
    const input = { review_token: fresh.body.review_token, review_digest: fresh.body.review_digest, accept_access: true };
    const activeDenied = await h.call('/grants', 'POST', input);
    assert.equal(activeDenied.status, 409);
    assert.equal(activeDenied.body.code, 'APP_RESOURCE_ACCESS_LIMIT');
    for (let start = 0; start < 3840; start += 128)
        await h.db.insert(h.s.appResourceAccessGrants).values(Array.from({ length: Math.min(128, 3840 - start) }, (_, i) => metadata(start + i, true)));
    assert.equal((await h.call('/grants/' + accepted.body.grant_id, 'DELETE')).status, 200);
    const retainedDenied = await h.call('/grants', 'POST', input);
    assert.equal(retainedDenied.status, 409);
    assert.equal(retainedDenied.body.code, 'APP_RESOURCE_ACCESS_LIMIT');
    const prune = await h.call('/maintenance/prune', 'POST', {});
    assert.equal(prune.status, 200, JSON.stringify(prune.body));
    assert.equal(prune.body.removed, 100);
    const count = await h.db.execute(h.sql `SELECT count(*)::int AS value FROM app_resource_access_grants WHERE org_id=${h.owned.org_id}`);
    assert.equal(count.rows[0].value, 3996);
});
