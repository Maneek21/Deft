import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToJson, jsonToMarkdown } from '../src/index.js';

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

test('htmlToJson counts a handler inside a removed element', () => {
  const { json, dropped } = htmlToJson('<form><button onclick="go()">Go</button><script onload="x()"></script></form><p>ok</p>');
  // form, script, and the two handlers.
  assert.equal(dropped, 4);
  assert.ok(!JSON.stringify(json).includes('Go'), 'the form and what was in it are gone');
});

test('htmlToJson counts inside template contents, nested templates included', () => {
  assert.equal(htmlToJson('<template><input onclick=x></template>').dropped, 2);
  const nested = htmlToJson('<p>ok</p><template><div><template><script>alert(1)</script><b onmouseover="y()">z</b></template></div></template>');
  assert.equal(nested.dropped, 2);
  assert.ok(!JSON.stringify(nested.json).includes('alert'));
});

test('a plain TipTap task checkbox is not counted, but a handler on it is', () => {
  const taskList = (input: string) => '<ul data-type="taskList"><li data-checked="false" data-type="taskItem">'
    + `<label>${input}<span></span></label><div><p>Do it</p></div></li></ul>`;
  assert.equal(htmlToJson(taskList('<input type="checkbox">')).dropped, 0);
  assert.equal(htmlToJson(taskList('<input type="checkbox" onclick="steal()">')).dropped, 1);
  assert.equal(htmlToJson('<p>Not a task</p><input type="checkbox">').dropped, 1, 'a checkbox outside a task item counts');
});

test('an image names a Deft file only through data-file-id or a relative /api/files path', () => {
  const image = (html: string) => htmlToJson(html).json.content![0]!.attrs!;
  assert.equal(image('<img src="/api/files/abc?v=2" alt="Ours">').fileId, 'abc');
  const external = image('<img src="https://assets.example/api/files/chart" alt="Theirs">');
  assert.equal(external.fileId, null);
  assert.equal(external.src, 'https://assets.example/api/files/chart');
  assert.equal(image('<img src="//cdn.example/api/files/chart">').fileId, null, 'a protocol-relative URL is another host');
  assert.equal(
    jsonToMarkdown({ type: 'doc', content: [{ type: 'image', attrs: external }] }),
    '![Theirs](https://assets.example/api/files/chart)',
  );
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
