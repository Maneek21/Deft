import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as React from 'react';

const source = readFileSync(new URL('./experience-source-files.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('source.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'ExperienceSourceFiles')!;
const compile = (text: string, context: Record<string, unknown>) => runInNewContext(ts.transpileModule('(' + text + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText, context);

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const timedOut = () => Object.assign(new Error('aborted'), { name: 'TimeoutError' });

const sampleFile = { file_ref: 'f'.repeat(64), filename: 'brief.pdf', media_type: 'application/pdf', size_bytes: 3, disposition: 'attachment', preview: 'unsupported' };
const links: Array<{ href: string; download: string }> = [];

type FetchEntry = { url: string; init: Record<string, unknown>; resolve: (r: unknown) => void; reject: (e: unknown) => void };
function mount() {
  const fetches: FetchEntry[] = [];
  const timeoutControllers: AbortController[] = [];
  const api = {
    getAccessToken: () => 'test-token',
    fetch: (url: string, init: Record<string, unknown>) => new Promise((resolve, reject) => {
      const signal = init.signal as AbortSignal | undefined;
      if (signal?.aborted) { reject(timedOut()); return; }
      signal?.addEventListener('abort', () => reject(timedOut()), { once: true });
      fetches.push({ url, init, resolve, reject });
    }),
  };
  const AbortSignalMock = {
    timeout: (ms: number) => { const c = new AbortController(); (c as unknown as { __ms: number }).__ms = ms; timeoutControllers.push(c); return c.signal; },
    any: (signals: AbortSignal[]) => { const c = new AbortController(); for (const s of signals) s.addEventListener('abort', () => c.abort(), { once: true }); return c.signal; },
  };
  const document = { hidden: false, createElement: () => { const link = { href: '', download: '', click() {} }; links.push(link); return link; }, addEventListener() {}, removeEventListener() {} };
  const slots: any[] = [];
  let index = 0;
  const slot = (initial: any) => { const n = index++; return slots[n] ?? (slots[n] = { value: typeof initial === 'function' ? initial() : initial }); };
  const useState = (initial: any) => { const s = slot(initial); return [s.value, (next: any) => { s.value = typeof next === 'function' ? next(s.value) : next; }]; };
  const useRef = (initial: any) => slot({ current: initial }).value;
  const effects: Array<() => void> = [];
  const useEffect = (fn: () => void | (() => void), deps?: readonly unknown[]) => {
    const s = slot(null);
    if (!s.deps || !deps || deps.some((v, i) => !Object.is(v, s.deps[i]))) { s.deps = deps; effects.push(() => { s.cleanup?.(); s.cleanup = fn(); }); }
  };
  const parseSourceView = (raw: { files: unknown[]; omitted_file_count?: number; expires_at?: string }) => ({ files: raw.files, omitted_file_count: raw.omitted_file_count ?? 0, expires_at: raw.expires_at ?? new Date(Date.now() + 1000).toISOString() });
  const readSourceBinary = async () => new Uint8Array([1, 2, 3]);
  const fn = compile(component.getText(tree).replace(/^export\s+/u, ''), {
    React, useState, useRef, useEffect,
    api, isSameWebSession: () => true, parseSourceView, readSourceBinary,
    withTimeout: (controller: AbortController) => AbortSignalMock.any([controller.signal, AbortSignalMock.timeout(45_000)]),
    isTimedOut: (error: unknown) => error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'),
    AbortSignal: AbortSignalMock, AbortController, document,
    URL: { createObjectURL: () => 'blob:mock', revokeObjectURL() {} }, Blob, TextDecoder, setTimeout, clearTimeout,
  });
  const props = { sessionId: 'session', resourceKey: 'inbox', recordId: 'record', exposure: { exposure_id: 'scope', exposure_epoch: 2 }, ensureAuthority: async () => true };
  const render = () => { index = 0; const out = fn(props); while (effects.length) effects.shift()!(); return out; };
  return { render, fetches, timeoutControllers };
}
const find = (node: unknown, predicate: (n: any) => boolean): any => {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const child of React.Children.toArray((node as any).props?.children)) { const found = find(child, predicate); if (found) return found; }
  return null;
};
const status = (out: unknown) => { const node = find(out, (n: any) => n?.props?.role === 'status'); return node ? String(node.props.children) : ''; };
const button = (out: unknown, label: string) => find(out, (n: any) => n?.type === 'button' && String(n.props.children).includes(label));

test('the attachment panel composes a 45 s timeout and names a timeout, busy and gone state in the source', () => {
  assert.match(source, /const withTimeout=\(controller:AbortController\)=>AbortSignal\.any\(\[controller\.signal,AbortSignal\.timeout\(45_000\)\]\)/);
  assert.match(source, /The download took too long\. Try the original message or a single file\./);
  assert.match(source, /Try again/);
  assert.match(source, /This file is unavailable or changed\. Reload attachment details before trying again\./);
});

test('a download whose fetch aborts shows the named timeout message', async () => {
  const f = mount();
  let out = f.render();
  await flush(); // let the mount load() run and reach api.fetch
  // resolve the list_files fetch so the Download button renders
  f.fetches[0].resolve({ ok: true, status: 200, json: async () => ({ files: [sampleFile], expires_at: new Date(Date.now() + 1000).toISOString() }) });
  await flush();
  out = f.render();
  const download = button(out, 'Download');
  assert.ok(download, 'Download button must render once files load');
  download.props.onClick(); // open(file, true)
  await flush();
  const readFetch = f.fetches.find(entry => JSON.parse(String(entry.init.body)).operation === 'read_file');
  assert.ok(readFetch, 'read_file fetch must be issued');
  assert.ok(f.timeoutControllers.length >= 2, 'each read composes its own 45 s timeout signal');
  f.timeoutControllers.at(-1)!.abort(); // simulate the 45 s timeout on the read_file fetch
  await flush();
  out = f.render();
  assert.equal(status(out), 'The download took too long. Try the original message or a single file.');
});

test('a 503 on download shows a retry action that re-runs the same read', async () => {
  const f = mount();
  let out = f.render();
  await flush();
  f.fetches[0].resolve({ ok: true, status: 200, json: async () => ({ files: [sampleFile], expires_at: new Date(Date.now() + 1000).toISOString() }) });
  await flush();
  out = f.render();
  button(out, 'Download').props.onClick();
  await flush();
  const readFetch = f.fetches.find(entry => JSON.parse(String(entry.init.body)).operation === 'read_file')!;
  readFetch.resolve({ status: 503 });
  await flush();
  out = f.render();
  assert.match(status(out), /busy right now/);
  const retry = button(out, 'Try again');
  assert.ok(retry, 'a 503 busy download shows a Retry button');
  retry.props.onClick();
  await flush();
  assert.ok(f.fetches.some(entry => entry !== readFetch && JSON.parse(String(entry.init.body)).operation === 'read_file'), 'retry re-issues the read_file fetch');
});

test('a 409 on download shows the gone copy without a retry action', async () => {
  const f = mount();
  let out = f.render();
  await flush();
  f.fetches[0].resolve({ ok: true, status: 200, json: async () => ({ files: [sampleFile], expires_at: new Date(Date.now() + 1000).toISOString() }) });
  await flush();
  out = f.render();
  button(out, 'Download').props.onClick();
  await flush();
  const readFetch = f.fetches.find(entry => JSON.parse(String(entry.init.body)).operation === 'read_file')!;
  readFetch.resolve({ status: 409 });
  await flush();
  out = f.render();
  assert.equal(status(out), 'This file is unavailable or changed. Reload attachment details before trying again.');
  assert.equal(button(out, 'Try again'), null, 'a gone file must not offer a retry');
});

test('a successful download preserves the filename and confirms completion', async () => {
  const f = mount();
  let out = f.render();
  await flush();
  f.fetches[0].resolve({ ok: true, status: 200, json: async () => ({ files: [sampleFile], expires_at: new Date(Date.now() + 1000).toISOString() }) });
  await flush();
  out = f.render();
  button(out, 'Download').props.onClick();
  await flush();
  const readFetch = f.fetches.find(entry => JSON.parse(String(entry.init.body)).operation === 'read_file')!;
  const headers = new Headers({ 'content-type': 'application/octet-stream', 'content-length': '3', 'x-deft-exposure-id': 'scope', 'x-deft-exposure-epoch': '2', 'x-content-type-options': 'nosniff', 'content-disposition': 'attachment; filename="brief.pdf"' });
  readFetch.resolve({ ok: true, status: 200, headers, body: null, json: async () => ({}) });
  await flush();
  out = f.render();
  assert.match(status(out), /Downloaded/);
  assert.equal(links.at(-1)?.download, 'brief.pdf', 'the saved filename is preserved');
});
