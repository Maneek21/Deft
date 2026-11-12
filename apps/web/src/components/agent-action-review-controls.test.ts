// The approval card offers Approve and Dismiss only to a viewer the server
// says may take that decision; a viewer who may take neither sees a neutral
// "Waiting for review" line. Without the server's flags the card keeps both
// controls. The card's own helper runs here with data passed as arguments.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const cardText = readFileSync(new URL('./agent-action-card.tsx', import.meta.url), 'utf8');
const card = ts.createSourceFile('card.tsx', cardText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const helper = card.statements.find((node) => (
  ts.isFunctionDeclaration(node) && node.name?.text === 'getViewerReviewControls'
));
assert.ok(helper, 'the card defines getViewerReviewControls');
const controlsFor = vm.runInNewContext(
  `${ts.transpileModule(helper.getText(card), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText};getViewerReviewControls`,
  {},
) as (action: Record<string, unknown>) => { approve: boolean; reject: boolean; waiting: boolean };

test('B-review: review controls follow the viewer flags', () => {
  const cases: Array<[Record<string, unknown>, { approve: boolean; reject: boolean; waiting: boolean }]> = [
    [{}, { approve: true, reject: true, waiting: false }],
    [{ viewer_can_approve: true, viewer_can_reject: true }, { approve: true, reject: true, waiting: false }],
    [{ viewer_can_approve: false, viewer_can_reject: false }, { approve: false, reject: false, waiting: true }],
    [{ viewer_can_approve: false, viewer_can_reject: true }, { approve: false, reject: true, waiting: false }],
    [{ viewer_can_approve: true, viewer_can_reject: false }, { approve: true, reject: false, waiting: false }],
  ];
  for (const [action, expected] of cases) {
    assert.deepEqual({ ...controlsFor(action) }, expected, JSON.stringify(action));
  }
});

test('B-review: every Approve and Dismiss control in the card is gated by the viewer flags', () => {
  const approveButtons: ts.JsxElement[] = [];
  const rejectButtons: ts.JsxElement[] = [];
  function visit(node: ts.Node) {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(card) === 'button') {
      const onClick = node.openingElement.attributes.properties.find((attr) => (
        ts.isJsxAttribute(attr) && attr.name.getText(card) === 'onClick'
      ));
      const handler = onClick && ts.isJsxAttribute(onClick) ? onClick.initializer?.getText(card) : '';
      if (handler === '{handleApprove}') approveButtons.push(node);
      if (handler === '{handleReject}') rejectButtons.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(card);
  assert.equal(approveButtons.length, 2);
  assert.equal(rejectButtons.length, 2);
  const guardOf = (button: ts.JsxElement) => {
    let parent: ts.Node = button.parent;
    while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
    assert.ok(ts.isBinaryExpression(parent), 'the button is rendered behind a condition');
    return parent.left.getText(card);
  };
  for (const button of approveButtons) assert.equal(guardOf(button), 'reviewControls.approve');
  for (const button of rejectButtons) assert.equal(guardOf(button), 'reviewControls.reject');
  assert.equal(cardText.match(/\{waitingForReview\}/g)?.length, 2);
  assert.match(cardText, />Waiting for review</);
});

test('B-review: Inbox and the notification panel pass the viewer flags to the card', () => {
  for (const path of ['../app/(app)/inbox/page.tsx', './notification-panel.tsx']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    const tree = ts.createSourceFile('view.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let expression: ts.Expression | undefined;
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'action' && node.type?.getText(tree) === 'AgentAction') {
        expression = node.initializer;
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
    assert.ok(expression, path);
    for (const flags of [{ viewer_can_approve: false, viewer_can_reject: true }, {}]) {
      const item = { created_at: 'now', approval: { id: 'a', action: 'task_update', params: {}, ...flags } };
      const result = vm.runInNewContext(`(${expression.getText(tree)})`, { item }) as Record<string, unknown>;
      assert.equal(result.viewer_can_approve, (flags as Record<string, unknown>).viewer_can_approve, path);
      assert.equal(result.viewer_can_reject, (flags as Record<string, unknown>).viewer_can_reject, path);
    }
  }
});
