/**
 * The notes move's split (plan Task F14, fix round 1, I2): a paragraph over
 * the live size cap is cut in one pass, in order. Nothing moves: text and
 * marks come out exactly as they went in, whitespace included, and every
 * line break stays a boundary (a hard break or a paragraph break). Pure: no
 * database.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { jsonToText } from '@deft/doc-schema';
import { finishContent, fitsSizeCap, measureContent, splitToFit, type JSONContent } from '../src/lib/drives-move/convert-note.js';

type Run = { marks: string; text: string };

/** The text runs of the parts' paragraphs, in order, with each line break or paragraph end as a `\n` run, adjacent equal marks merged. */
function runsOf(parts: JSONContent[], boundaries: boolean): Run[] {
  const runs: Run[] = [];
  const push = (run: Run) => {
    const last = runs[runs.length - 1];
    if (last && last.marks === run.marks && run.marks !== 'BOUNDARY') last.text += run.text;
    else runs.push({ ...run });
  };
  for (const part of parts) {
    for (const block of part.content ?? []) {
      for (const inline of block.content ?? []) {
        if (inline.type === 'hardBreak') { if (boundaries) push({ marks: 'BOUNDARY', text: '\n' }); }
        else push({ marks: JSON.stringify((inline.marks ?? []).map((mark) => mark.type)), text: inline.text ?? '' });
      }
      if (boundaries) push({ marks: 'BOUNDARY', text: '\n' });
    }
  }
  return runs;
}

const sentence = (n: number) => `Sentence ${n} keeps its words, its  double spaces and its order. `;
const bigText = (count: number, from = 0) => Array.from({ length: count }, (_, n) => sentence(from + n)).join('');

test('a bold prefix and a huge plain run split in order, with exact text and marks', () => {
  const huge = bigText(42_000);
  assert.ok(huge.length > 2_400_000);
  const doc: JSONContent = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Prefix: ' }, { type: 'text', text: huge }] }],
  };
  const { parts, splitBlocks } = splitToFit(finishContent(doc, 'prefix'), 'Prefixed', 'prefix');
  assert.ok(parts.length >= 2, `split (${parts.length} parts)`);
  assert.equal(splitBlocks, 1);
  for (const part of parts) assert.ok(fitsSizeCap(measureContent(part.json).bound));
  assert.deepEqual(runsOf(parts.map((part) => part.json), false), [
    { marks: '["bold"]', text: 'Prefix: ' },
    { marks: '[]', text: huge },
  ]);
});

test('every line break of a huge paragraph stays a boundary, an empty line included', () => {
  const lines = ['Start', bigText(18_000), 'Middle', bigText(18_000, 18_000), '', 'End'];
  const content: JSONContent[] = [];
  lines.forEach((line, index) => {
    if (index > 0) content.push({ type: 'hardBreak' });
    if (line) content.push({ type: 'text', text: line });
  });
  const doc: JSONContent = { type: 'doc', content: [{ type: 'paragraph', content }] };
  const { parts } = splitToFit(finishContent(doc, 'lines'), 'Lines', 'lines');
  assert.ok(parts.length >= 2);
  // The text, boundaries aside, is exactly the original, in order.
  const out = runsOf(parts.map((part) => part.json), true);
  const text = out.filter((run) => run.marks !== 'BOUNDARY').map((run) => run.text).join('');
  assert.equal(text, lines.join(''));
  // Every original line break is a boundary at the same place (a split inside a line may add more).
  const positions = (runs: Run[]) => {
    const found = new Map<number, number>();
    let offset = 0;
    for (const run of runs) {
      if (run.marks === 'BOUNDARY') found.set(offset, (found.get(offset) ?? 0) + 1);
      else offset += run.text.length;
    }
    return found;
  };
  const wanted = new Map<number, number>();
  let offset = 0;
  lines.forEach((line, index) => {
    if (index > 0) wanted.set(offset, (wanted.get(offset) ?? 0) + 1);
    offset += line.length;
  });
  const got = positions(out);
  for (const [at, count] of wanted) assert.ok((got.get(at) ?? 0) >= count, `the line break at ${at} is kept (${got.get(at) ?? 0} of ${count})`);
  assert.match(jsonToText(parts[parts.length - 1]!.json), /End$/);
});
