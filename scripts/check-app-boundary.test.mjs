import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scanBoundary, validateAllowlist } from './check-app-boundary.mjs';

function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deft-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  for (const [file, content] of Object.entries(files)) write(file, content);
  return { root, write, scan: () => scanBoundary(root) };
}
const exception = ({ line, context, ...finding }) => ({ ...finding,
  reason: 'Retained migration: permanent historical schema; never replay-edit.',
  owner: '@Maneek21', issue: 'https://github.com/Maneek21/Deft/issues/1', milestone: 'permanent historical',
});
const reject = (findings, rule) => {
  assert.ok(findings.some((finding) => finding.rule === rule), JSON.stringify(findings));
  assert.ok(validateAllowlist(findings, []).length);
};

test('rejects Email filenames, nested segments and case/rename bypasses', (t) => {
  for (const file of ['email.ts', 'EMAIL.ts', 'native-email.ts', 'eMaIl-helper.ts', 'emailHelpers.ts', 'EmAiLHelpers.ts', 'emails/neutral.ts', 'EMAIL.svg', 'EMAIL2.ts', 'NativeEmailView.ts', 'nAtIvEeMaIl2.ts']) {
    const f = fixture(t, { [`apps/api/src/${file}`]: 'export const value = 1;' });
    reject(f.scan(), 'email-path');
  }
});

test('mailbox and compose filenames cannot bypass token rules with empty content', (t) => {
  for (const file of ['mailbox.ts', 'getMailbox.ts', 'MAILBOX-LIST.ts', 'safe-compose-html.ts']) {
    const f = fixture(t, { [`apps/api/src/${file}`]: 'export const value = 1;' });
    assert.ok(f.scan().some((finding) => finding.rule.endsWith('-path')), file);
    assert.ok(validateAllowlist(f.scan(), []).length, file);
  }
});

test('rejects mailbox content added to an existing neutral file and detects changed digest/count', (t) => {
  const f = fixture(t, { 'apps/web/src/neutral.ts': 'export const label = "mailbox";' });
  const entries = f.scan().map(exception);
  assert.deepEqual(validateAllowlist(f.scan(), entries), []);
  f.write('apps/web/src/neutral.ts', 'export const label = "mailbox settings";');
  assert.match(validateAllowlist(f.scan(), entries).join('\n'), /Stale or changed/);
  f.write('apps/web/src/neutral.ts', 'export const label = "mailbox";\nexport const label = "mailbox";');
  assert.match(validateAllowlist(f.scan(), entries).join('\n'), /occurrence count/);
});

test('renaming a file invalidates its exception', (t) => {
  const f = fixture(t, { 'apps/api/src/neutral.ts': 'export const value = "MAILBOX";' });
  const entries = f.scan().map(exception);
  fs.renameSync(path.join(f.root, 'apps/api/src/neutral.ts'), path.join(f.root, 'apps/api/src/renamed.ts'));
  assert.match(validateAllowlist(f.scan(), entries).join('\n'), /Unapproved.*renamed/);
});

test('mail tokens remain forbidden under casing and camel-case changes', (t) => {
  for (const token of ['EMAIL_MESSAGES', 'emailAccounts', 'EmailMailboxError', 'SMTP', 'SandboxEmailSendRequest', '/API/EMAIL', 'SAFE-COMPOSE-HTML']) {
    const f = fixture(t, { 'apps/api/src/neutral.ts': `export const label = ${JSON.stringify(token)};` });
    assert.ok(f.scan().length, token);
  }
});

test('follows neutral barrels, export types, require, import types and literal dynamic imports', (t) => {
  for (const statement of [
    'export * from "../../../optional/barrel.js";',
    'export type { Result } from "../../../optional/barrel.js";',
    'const value = import("../../../optional/barrel.js");',
    'const value = require("../../../optional/barrel.js");',
    'type Result = import("../../../optional/barrel.js").Result;',
  ]) {
    const f = fixture(t, {
      'apps/api/src/neutral.ts': statement,
      'optional/barrel.ts': 'export * from "./renamed.js";',
      'optional/renamed.ts': 'export const value = "email_messages";',
    });
    const findings = f.scan();
    reject(findings, 'mail-storage');
    assert.ok(findings.some((finding) => finding.path === 'optional/renamed.ts'));
  }
});

test('flags computed dynamic imports even in generic-looking modules', (t) => {
  const f = fixture(t, { 'apps/api/src/loader.ts': 'const load = (name) => import(`./${name}.js`);' });
  reject(f.scan(), 'computed-import');
});

test('computed loader exceptions pin the surrounding verification and normalize line endings', (t) => {
  const source = 'async function load(name) {\n  assertPinnedHash(name);\n  return import(name);\n}';
  const f = fixture(t, { 'apps/api/src/loader.ts': source });
  const entries = f.scan().map(exception);
  f.write('apps/api/src/loader.ts', source.replaceAll('\n', '\r\n'));
  assert.deepEqual(validateAllowlist(f.scan(), entries), []);
  f.write('apps/api/src/loader.ts', source.replace('  assertPinnedHash(name);\n', ''));
  assert.match(validateAllowlist(f.scan(), entries).join('\n'), /Stale or changed/);
});

test('allows login/contact addresses, z.email(), mailto and transactional delivery', (t) => {
  const f = fixture(t, {
    'apps/web/src/contacts.ts': 'const email = z.email(); const url = "mailto:person@gmail.com"; const label = "Contacts"; const addresses = ["person@outlook.com", "mailbox@example.com", "smtp@example.com", "gmail+login@example.com"];',
    'apps/api/src/notifications.ts': 'const contact = { email: "a@example.com" }; const delivery = "Resend transactional notification email";',
  });
  assert.deepEqual(f.scan(), []);
});

test('an address never exempts provider IDs, mailbox wording or routes elsewhere on its line', (t) => {
  const f = fixture(t, {
    'apps/api/src/neutral.ts': 'const config = {contact:"user@gmail.com", provider:"gmail", label:"mailbox", route:"/api/email?to=mailbox@example.com"};',
  });
  const findings = f.scan();
  reject(findings, 'mail-provider');
  reject(findings, 'mailbox');
  reject(findings, 'mail-route');
  assert.equal(findings.find((finding) => finding.rule === 'mail-provider').occurrences, 1);
  assert.equal(findings.find((finding) => finding.rule === 'mailbox').occurrences, 1);
});

test('retained migrations require exact historical exceptions; stale, missing, duplicate and broad entries fail', (t) => {
  const f = fixture(t, { 'packages/db/drizzle/0042_email_accounts.sql': 'CREATE TABLE email_accounts (id text);' });
  const findings = f.scan();
  const entries = findings.map(exception);
  assert.deepEqual(validateAllowlist(findings, entries), []);
  assert.ok(validateAllowlist(findings, entries.slice(1)).length);
  assert.match(validateAllowlist(findings, [...entries, entries[0]]).join('\n'), /Duplicate/);
  assert.match(validateAllowlist([], entries).join('\n'), /Stale/);
  assert.match(validateAllowlist(findings, [{ ...entries[0], path: 'packages/db/**' }]).join('\n'), /broadened/);
  for (const field of ['reason', 'owner', 'issue', 'milestone', 'digest', 'token']) {
    assert.ok(validateAllowlist(findings, [{ ...entries[0], [field]: '' }]).length, field);
  }
});

function kitFixture(t) {
  return fixture(t, {
    'packages/app-kit/package.json': JSON.stringify({ name: '@deft/app-kit', exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './experience': { types: './dist/experience-sdk.d.ts', import: './dist/experience-sdk.js' },
      './examples/email': './dist/examples/email.js',
    } }),
    'packages/app-kit/src/index.ts': 'export const version = 1;',
    'packages/app-kit/src/experience-sdk.ts': 'export const render = 1;',
    'packages/app-kit/dist/index.js': 'export const version = 1;',
    'packages/app-kit/dist/index.d.ts': 'export declare const version = 1;',
    'packages/app-kit/dist/experience-sdk.js': 'export const render = 1;',
    'packages/app-kit/dist/experience-sdk.d.ts': 'export declare const render = 1;',
    'packages/app-kit/src/examples/email.ts': 'export const mailbox = 1;',
    'packages/app-kit/dist/examples/email.js': 'export const mailbox = 1;',
  });
}

test('self-contained optional example is accepted; core source importing it is rejected', (t) => {
  const f = kitFixture(t);
  assert.deepEqual(f.scan(), []);
  f.write('packages/app-kit/src/index.ts', 'export * from "./examples/email.js";');
  reject(f.scan(), 'email-import');
  reject(f.scan(), 'mailbox');
});

test('experience entry point and generated declarations cannot leak optional code', (t) => {
  const f = kitFixture(t);
  f.write('packages/app-kit/src/experience-sdk.ts', 'export * from "./examples/email.js";');
  reject(f.scan(), 'email-import');
  f.write('packages/app-kit/src/experience-sdk.ts', 'export const render = 1;');
  f.write('packages/app-kit/dist/index.d.ts', 'export * from "./examples/email.js";');
  reject(f.scan(), 'email-import');
});

test('workspace subpath, TS path alias and neutral wrapper cannot hide optional imports', (t) => {
  const f = kitFixture(t);
  f.write('apps/web/tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));
  f.write('apps/web/src/page.ts', 'import "@/wrapper";');
  f.write('apps/web/src/wrapper.ts', 'export * from "@deft/app-kit/examples/email";');
  reject(f.scan(), 'email-import');
  reject(f.scan(), 'mailbox');
});

test('all workspace export conditions are traversed, including runtime behind neutral declarations', (t) => {
  const f = kitFixture(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.root, 'packages/app-kit/package.json'), 'utf8'));
  manifest.exports['./neutral'] = { types: './dist/neutral.d.ts', import: './dist/worker.js' };
  f.write('packages/app-kit/package.json', JSON.stringify(manifest));
  f.write('packages/app-kit/dist/neutral.d.ts', 'export declare const worker: () => void;');
  f.write('packages/app-kit/src/worker.ts', 'export const worker = () => "mailbox";');
  f.write('apps/api/src/consumer.ts', 'import "@deft/app-kit/neutral";');
  reject(f.scan(), 'mailbox');
});

test('auxiliary scripts/workflows expose Host references without banning optional fixture prose', (t) => {
  const f = fixture(t, { 'scripts/review.mjs': 'const path = "apps/api/src/lib/email-legacy.ts";' });
  reject(f.scan(), 'host-import-reference');
});

test('missing generated entries and unresolved relative imports fail closed', (t) => {
  const f = kitFixture(t);
  fs.unlinkSync(path.join(f.root, 'packages/app-kit/dist/index.d.ts'));
  assert.throws(() => scanBoundary(f.root, { requireBuilt: true }), /Missing generated/);
  f.write('apps/api/src/index.ts', 'export * from "./missing.js";');
  reject(f.scan(), 'unresolved-local-import');
});


test('preapproved compatibility exports cannot authorize a Host import of a deprecated facade', (t) => {
  const base = {
    'packages/app-kit/package.json': JSON.stringify({ name: '@deft/app-kit', exports: {
      '.': './dist/index.js', './core': './dist/core.js', './experience': './dist/experience-sdk.js',
      './experience/core': './dist/experience-core.js', './examples/email': './dist/examples/email/index.js',
    }}),
    'packages/app-kit/src/index.ts': 'export * from "./core.js"; export * from "./compatibility.js";',
    'packages/app-kit/src/core.ts': 'export const version = 1;',
    'packages/app-kit/src/experience-core.ts': 'export const sdk = 1;',
    'packages/app-kit/src/experience-sdk.ts': 'export * from "./experience-core.js"; export * from "./compatibility.js";',
    'packages/app-kit/src/compatibility.ts': 'export * from "./examples/email/index.js";',
    'packages/app-kit/src/examples/email/index.ts': 'export const SandboxEmailSendInputSchema = {};',
  };
  for (const statement of [
    'import {version} from "@deft/app-kit";',
    'import type {sdk} from "@deft/app-kit/experience";',
    'const kit = import("@deft/app-kit");',
    'const kit = require("@deft/app-kit");',
    'export * from "../../../packages/app-kit/src/index.js";',
  ]) {
    const f = fixture(t, base);
    const approved = f.scan().map(exception);
    f.write('apps/api/src/neutral.ts', statement);
    reject(f.scan(), 'compatibility-facade-import');
    assert.match(validateAllowlist(f.scan(), approved).join('\n'), /Unapproved/);
  }
  const clean = fixture(t, base), approved = clean.scan().map(exception);
  clean.write('apps/api/src/neutral.ts', 'import {version} from "@deft/app-kit/core";');
  assert.deepEqual(validateAllowlist(clean.scan(), approved), []);
  clean.write('apps/api/src/neutral.ts', 'export * from "../../../optional/neutral.js";');
  clean.write('optional/neutral.ts', 'export * from "@deft/app-kit";');
  reject(clean.scan(), 'compatibility-facade-import');
});
