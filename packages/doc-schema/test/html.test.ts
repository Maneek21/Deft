import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToJson } from '../src/index.js';

test('htmlToJson drops script, iframe and onclick and counts them', () => {
  const { json, dropped } = htmlToJson(
    '<p onclick="steal()">Hi there</p><script>alert(1)</script><iframe src="https://evil.test/frame">fallback text</iframe>',
  );
  assert.equal(dropped, 3);
  const serialized = JSON.stringify(json);
  for (const word of ['script', 'onclick', 'steal', 'alert', 'iframe', 'evil.test', 'fallback']) {
    assert.ok(!serialized.includes(word), `${word} is gone`);
  }
  assert.deepEqual(json.content, [{ type: 'paragraph', attrs: { id: null }, content: [{ type: 'text', text: 'Hi there' }] }]);
});

test('htmlToJson counts style, object, embed, form, input, link and meta too', () => {
  const { dropped } = htmlToJson(
    '<style>p{}</style><object data="x"></object><embed src="y"><form><input name="a"></form>'
      + '<link rel="stylesheet" href="z"><meta http-equiv="refresh" content="0"><p onmouseover="a()" onfocus="b()">ok</p>',
  );
  // style, object, embed, form, input (inside the form), link, meta, and two handlers.
  assert.equal(dropped, 9);
});

test('htmlToJson keeps a callout div, a task list and an image with data-file-id', () => {
  // The HTML the notes editor saves today.
  const html = '<div data-emoji="⚠️" data-callout="" class="deft-callout">'
    + '<span class="deft-callout-emoji" contenteditable="false">⚠️</span>'
    + '<div class="deft-callout-body"><p>Careful</p></div></div>'
    + '<ul data-type="taskList"><li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked="checked"><span></span></label>'
    + '<div><p>Ship it</p></div></li></ul>'
    + '<img data-file-id="file_1" data-protected-note-image="" alt="Chart" title="Chart">';
  const { json, dropped } = htmlToJson(html);
  assert.equal(dropped, 0, 'the checkbox a task item draws is not unsafe content');
  const [callout, taskList, image] = json.content!;
  assert.equal(callout!.type, 'callout');
  assert.equal(callout!.attrs!.emoji, '⚠️');
  assert.deepEqual(callout!.content, [{ type: 'paragraph', attrs: { id: null }, content: [{ type: 'text', text: 'Careful' }] }],
    'the emoji is an attribute, not a paragraph');
  assert.equal(taskList!.type, 'taskList');
  assert.deepEqual(taskList!.content![0], {
    type: 'taskItem',
    attrs: { checked: true },
    content: [{ type: 'paragraph', attrs: { id: null }, content: [{ type: 'text', text: 'Ship it' }] }],
  });
  assert.deepEqual(image, {
    type: 'image',
    attrs: { id: null, src: null, alt: 'Chart', title: 'Chart', fileId: 'file_1' },
  });
});

test('htmlToJson reads a native mention, a task view and block ids', () => {
  const { json } = htmlToJson(
    '<p data-id="00000000-0000-4000-8000-000000000001">Ask <span data-deft-ref-kind="person" data-deft-ref-id="user_9">@Person</span></p>'
      + '<div data-task-view="" data-config="{&quot;project_id&quot;:&quot;p1&quot;}"></div>',
  );
  assert.deepEqual(json.content, [
    {
      type: 'paragraph',
      attrs: { id: '00000000-0000-4000-8000-000000000001' },
      content: [{ type: 'text', text: 'Ask ' }, { type: 'nativeMention', attrs: { kind: 'person', id: 'user_9' } }],
    },
    { type: 'taskView', attrs: { id: null, config: { project_id: 'p1' } } },
  ]);
});
