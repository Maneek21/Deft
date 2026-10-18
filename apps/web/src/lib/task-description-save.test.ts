import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../components/task-detail.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('task-detail.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function initializer(name: string) {
  let found: string | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) found = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found, `Actual TaskDetail ${name} must exist`);
  return ts.transpileModule(`globalThis.actual = ${found};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(api: any) {
  const state = { task: { id: 'A', description: 'Initial' } as any, description: 'Edited', notice: '', updates: [] as any[] };
  const context: any = { api, taskId: 'A', task: state.task, descValue: 'Edited',
    activeTaskId: { current: 'A' }, descriptionRevision: { current: 1 }, descriptionDirty: { current: true },
    descriptionQueue: { current: Promise.resolve() }, savedDescriptionContents: { current: new Map() },
    pendingDescriptionSave: { current: null }, descriptionDebounce: { current: undefined },
    clearTimeout, useCallback: (fn: any) => fn, normalizeTaskDetailPayload: (value: any) => value,
    rememberSavedDescription() { assert.fail('A stale load cannot adopt description bytes'); },
    setSaveNotice: (value: string) => { state.notice = value; },
    setTask: (value: any) => { state.task = typeof value === 'function' ? value(state.task) : value; },
    setDescValue: (value: string) => { state.description = value; },
    onUpdated: (value: any) => { state.updates.push(value); },
    setLoading() {}, setTitleValue() {}, setSubtasks() {}, setParentTask() {}, setAgentProgress() {}, setAgentOutcome() {},
  };
  vm.createContext(context);
  function actual(name: string) { vm.runInContext(initializer(name), context); return context.actual; }
  return { state, context, actual };
}
const response = (description: string) => ({ ok: true, json: async () => ({ id: 'A', description }) });

test('late task loads cannot replace another task or its description', async () => {
  const held = deferred<any>(), fx = fixture({ get: () => held.promise });
  const pending = fx.actual('loadTask')();
  fx.context.activeTaskId.current = 'B'; fx.state.task = { id: 'B' };
  held.resolve(response('Old A')); await pending;
  assert.equal(fx.state.task.id, 'B'); assert.equal(fx.state.description, 'Edited');
});

test('a load started before an edit cannot overwrite the newer description', async () => {
  const held = deferred<any>(), fx = fixture({ get: () => held.promise });
  fx.context.descriptionDirty.current = false;
  const pending = fx.actual('loadTask')();
  fx.context.descriptionRevision.current++; fx.context.descriptionDirty.current = true;
  held.resolve(response('Old saved text')); await pending;
  assert.equal(fx.state.description, 'Edited');
});

test('switching tasks while response JSON decodes cannot apply the old task', async () => {
  const body = deferred<any>(), entered = deferred<void>();
  const fx = fixture({ get: async () => ({ ok: true, json: () => { entered.resolve(undefined); return body.promise; } }) });
  const pending = fx.actual('loadTask')(); await entered.promise;
  fx.context.activeTaskId.current = 'B'; fx.state.task = { id: 'B' };
  body.resolve({ id: 'A', description: 'Old A' }); await pending;
  assert.equal(fx.state.task.id, 'B'); assert.equal(fx.state.description, 'Edited');
});

test('actual description saves serialize requests and only the latest revision clears dirty state', async () => {
  const first = deferred<any>(), second = deferred<any>(), calls: string[] = [];
  const fx = fixture({ patch: (_url: string, input: any) => { calls.push(input.description); return calls.length === 1 ? first.promise : second.promise; } });
  fx.context.rememberSavedDescription = fx.actual('rememberSavedDescription');
  const save = fx.actual('saveDescription'), one = save('First');
  await Promise.resolve(); assert.deepEqual(calls, ['First']);
  fx.context.descriptionRevision.current++;
  const two = save('Second'); await Promise.resolve(); assert.deepEqual(calls, ['First']);
  first.resolve(response('First')); await one;
  assert.equal(fx.context.descriptionDirty.current, true);
  await Promise.resolve(); assert.deepEqual(calls, ['First', 'Second']);
  second.resolve(response('Second')); await two;
  assert.equal(fx.context.descriptionDirty.current, false); assert.equal(fx.state.notice, 'Description saved');
  assert.equal(fx.state.task.description, 'Second');
});

test('failed saves remain dirty and explicit flush retries the retained current text', async () => {
  let calls = 0;
  const fx = fixture({ patch: async () => ++calls === 1 ? { ok: false } : response('Edited') });
  fx.context.rememberSavedDescription = fx.actual('rememberSavedDescription');
  fx.context.saveDescription = fx.actual('saveDescription');
  await assert.rejects(fx.context.saveDescription('Edited'), /Description could not be saved/);
  assert.equal(fx.context.descriptionDirty.current, true); assert.match(fx.state.notice, /not saved/);
  await fx.actual('flushDescription')();
  assert.equal(calls, 2); assert.equal(fx.context.descriptionDirty.current, false);
  assert.equal(fx.state.notice, 'Description saved');
});

test('a save completed after switching tasks cannot publish an update or notice into the new task', async () => {
  const held = deferred<any>(), fx = fixture({ patch: () => held.promise });
  fx.context.rememberSavedDescription = fx.actual('rememberSavedDescription');
  const pending = fx.actual('saveDescription')('A text'); await Promise.resolve();
  fx.context.activeTaskId.current = 'B'; fx.context.descriptionRevision.current++;
  fx.state.task = { id: 'B' }; fx.state.notice = 'B notice';
  held.resolve(response('A text')); await pending;
  assert.equal(fx.state.task.id, 'B'); assert.equal(fx.state.notice, 'B notice');
  assert.equal(fx.state.updates.length, 0); assert.equal(fx.context.descriptionDirty.current, true);
});
