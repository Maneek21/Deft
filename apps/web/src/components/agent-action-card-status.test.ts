// Lane W2-a2 — review finding 7 (E04): a status the card learned from its
// own request (for example a 202 'executing') must not override refreshed
// server props. The test re-renders the card's real status hook from its
// source with a small hook runtime that keeps state between renders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

type LocalStatus = 'approving' | 'rejecting' | 'approved' | 'rejected' | 'failed' | 'executing' | null;
type StatusHook = (serverStatus: string) => readonly [LocalStatus, (next: LocalStatus) => void];

const source = ts.createSourceFile(
  'card.tsx',
  readFileSync(new URL('./agent-action-card.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const hookDeclaration = source.statements.find((node) => (
  ts.isFunctionDeclaration(node) && node.name?.text === 'useAgentActionLocalStatus'
));
assert.ok(hookDeclaration, 'the card defines useAgentActionLocalStatus');
const hookJs = ts.transpileModule(hookDeclaration.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

/** Minimal hook runtime: state persists across renders, effects run after each render. */
function mountHook() {
  const states: unknown[] = [];
  let cursor = 0;
  let pendingEffects: Array<() => void> = [];
  const runtime = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in states)) states[index] = initial;
      return [states[index], (next: unknown) => { states[index] = next; }];
    },
    useCallback(fn: unknown) {
      cursor++;
      return fn;
    },
    useEffect(effect: () => void) {
      cursor++;
      pendingEffects.push(effect);
    },
  };
  const context = vm.createContext({ ...runtime });
  vm.runInContext(hookJs, context);
  const hook = context.useAgentActionLocalStatus as StatusHook;
  return (serverStatus: string) => {
    cursor = 0;
    pendingEffects = [];
    const result = hook(serverStatus);
    for (const effect of pendingEffects) effect();
    return result;
  };
}

/** Render until the hook output is stable, as React would after an effect's state update. */
function settle(render: (serverStatus: string) => readonly [LocalStatus, (next: LocalStatus) => void], serverStatus: string) {
  let [status, set] = render(serverStatus);
  [status, set] = render(serverStatus);
  return [status, set] as const;
}

test('E04/finding 7: a 202 executing answer gives way once server props change', () => {
  const render = mountHook();
  let [status, set] = settle(render, 'pending');
  assert.equal(status, null);
  set('approving');
  [status, set] = settle(render, 'pending');
  assert.equal(status, 'approving');
  set('executing');
  [status, set] = settle(render, 'pending');
  assert.equal(status, 'executing', 'until the server changes, the local answer is shown');
  [status, set] = settle(render, 'approved');
  assert.equal(status, null, 'refreshed server props win');
  [status] = settle(render, 'pending');
  assert.equal(status, null, 'a dropped local answer does not come back');
});

test('E04/finding 7: an in-flight request stays visible while server props change', () => {
  const render = mountHook();
  // The click handler keeps the setter from the render it was created in.
  const [, clickSet] = settle(render, 'pending');
  clickSet('approving');
  let [status] = settle(render, 'approved');
  assert.equal(status, 'approving');
  clickSet('failed');
  [status] = settle(render, 'approved');
  assert.equal(status, null, 'the outcome was learned against an older server state, so the server wins');
});

test('E04/finding 7: a failed outcome shows until the server reports the failure itself', () => {
  const render = mountHook();
  let [status, set] = settle(render, 'pending');
  set('approving');
  [status, set] = settle(render, 'pending');
  set('failed');
  [status] = settle(render, 'pending');
  assert.equal(status, 'failed');
  [status] = settle(render, 'failed');
  assert.equal(status, null);
});
