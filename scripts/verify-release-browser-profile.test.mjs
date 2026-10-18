import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import vm from 'node:vm';

const verifier = new URL('./verify-release-browser-profile.mjs', import.meta.url);
const features = { apps: true, resource_sync: true, attachment_broker: true };
const diagnostic = Buffer.from('compiled data-deft-browser-features marker');

async function scenario(name) {
  const source = (await readFile(verifier, 'utf8')).replace(/^#!.*\r?\n/, '').replace(/^import .*;\r?$/gm, '');
  const page = new EventEmitter();
  const evidence = [];
  const events = [];
  let lateBodyReads = 0;
  let rejectBody;
  const initial = {
    url: () => 'http://127.0.0.1:3100/_next/static/initial.js',
    status: () => name === 'bad-status' ? 503 : 200,
    body: () => {
      events.push('initial-body');
      if (name === 'early-rejection') return Promise.reject(new Error('synthetic body read failed'));
      if (name === 'hung-body') return new Promise((resolve, reject) => { rejectBody = reject; });
      return Promise.resolve(name === 'no-diagnostic' ? Buffer.from('ordinary chunk') : diagnostic);
    },
  };
  const late = {
    url: () => 'http://127.0.0.1:3100/_next/static/late.js', status: () => 200,
    body: () => { lateBodyReads++; return new Promise((resolve, reject) => { rejectBody = reject; }); },
  };
  page.goto = async () => {
    page.emit('response', initial);
    // Give a rejection an event-loop turn before the verifier reaches its drain.
    if (name === 'early-rejection') await new Promise(resolve => setImmediate(resolve));
    return { status: () => 200 };
  };
  page.waitForFunction = async () => {};
  page.locator = () => ({ getAttribute: async () => JSON.stringify(features) });
  const browser = { newPage: async () => page, close: async () => {
    events.push('close');
    rejectBody?.(new Error('response.body: Target page, context or browser has been closed'));
  } };
  const sandbox = {
    assert, createHash, Buffer, URL, JSON, chromium: { launch: async () => browser },
    readReleaseBrowserProfile: async () => ({ profile: 'apps-developer-preview', version: '0.3.0-preview.120', features }),
    dirname: () => '.', mkdir: async () => {},
    writeFile: async (file, contents) => {
      // This is after the old Promise.all snapshot and before browser.close().
      if (name === 'late-response') page.emit('response', late);
      evidence.push(JSON.parse(contents));
    },
    process: { env: { RELEASE_IMAGE_REF: 'ghcr.io/maneek21/deft@sha256:' + 'a'.repeat(64) } },
    console: { log: () => events.push('passed-output') },
    setTimeout: (callback, ms) => setTimeout(callback, Math.min(ms, 25)), clearTimeout,
  };
  let outcome;
  try {
    await vm.runInNewContext(`(async () => {\n${source}\n})()`, sandbox, { filename: verifier.pathname });
    outcome = { result: 'passed' };
  } catch (error) {
    outcome = { result: 'failed', error: error.message };
  }
  // Let an unhandled late body rejection become fatal in the isolated child.
  await new Promise(resolve => setImmediate(resolve));
  return { ...outcome, lateBodyReads, evidence, events, listenersAfterClose: page.listenerCount('response') };
}

if (process.argv[2] === '--scenario') {
  process.stdout.write(JSON.stringify(await scenario(process.argv[3])) + '\n');
} else {
  function run(name) {
    const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', import.meta.filename, '--scenario', name], {
      encoding: 'utf8', timeout: 5_000, windowsHide: true,
    });
    assert.equal(child.status, 0, child.stderr || child.error?.message || 'Verifier child did not finish');
    return JSON.parse(child.stdout);
  }
  test('late response after capture does not start a body read or outlive browser close', () => {
    const result = run('late-response');
    assert.equal(result.result, 'passed');
    assert.equal(result.lateBodyReads, 0);
    assert.equal(result.listenersAfterClose, 0);
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].browser_chunks[0].sha256, createHash('sha256').update(diagnostic).digest('hex'));
    assert.equal(result.evidence[0].browser_chunks[0].contains_diagnostic, true);
  });
  test('body rejection is handled immediately and fails verification before evidence', () => {
    const result = run('early-rejection');
    assert.equal(result.result, 'failed');
    assert.match(result.error, /synthetic body read failed/);
    assert.deepEqual(result.evidence, []);
    assert.equal(result.listenersAfterClose, 0);
    assert.equal(result.events.at(-1), 'close');
  });
  test('collected failed chunk status still rejects verification', () => {
    const result = run('bad-status');
    assert.equal(result.result, 'failed');
    assert.match(result.error, /Browser chunk failed/);
    assert.deepEqual(result.evidence, []);
  });
  test('diagnostic must still come from actual collected bundle bytes', () => {
    const result = run('no-diagnostic');
    assert.equal(result.result, 'failed');
    assert.match(result.error, /diagnostic must originate/);
    assert.deepEqual(result.evidence, []);
  });
  test('hung body drain is bounded, fails closed, and handles close-time rejection', () => {
    const result = run('hung-body');
    assert.equal(result.result, 'failed');
    assert.match(result.error, /chunk.*timed out/i);
    assert.deepEqual(result.evidence, []);
    assert.equal(result.listenersAfterClose, 0);
    assert.equal(result.events.at(-1), 'close');
  });
}
