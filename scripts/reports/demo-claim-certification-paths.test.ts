import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  createDemoCertificationReportPaths,
  normalizeDemoCertificationRunId,
  resolvePathInside,
} from './demo-claim-certification-paths.js';

test('normalizes a generated run id deterministically', () => {
  assert.equal(
    normalizeDemoCertificationRunId(
      undefined,
      new Date('2026-07-30T12:34:56.789Z'),
    ),
    '2026-07-30T12-34-56-789Z',
  );
});

test('accepts a conservative explicit run id', () => {
  assert.equal(
    normalizeDemoCertificationRunId('release_2026.07-30'),
    'release_2026.07-30',
  );
});

for (const runId of [
  '../escape',
  '..\\escape',
  '/absolute',
  'C:\\absolute',
  ' leading-space',
  'trailing-space ',
  'contains space',
  'CON',
]) {
  test(`rejects unsafe run id ${JSON.stringify(runId)}`, () => {
    assert.throws(
      () => normalizeDemoCertificationRunId(runId),
      /DEFT_DEMO_CERT_RUN_ID/,
    );
  });
}

test('keeps all generated report paths inside the reports root', () => {
  const cwd = path.resolve('test-workspace');
  const reportsRoot = path.resolve(cwd, 'reports');
  const paths = createDemoCertificationReportPaths('safe-run', cwd);

  for (const target of [paths.outDir, paths.htmlReport, paths.jsonReport]) {
    const relative = path.relative(reportsRoot, target);
    assert.notEqual(relative, '..');
    assert.equal(relative.startsWith(`..${path.sep}`), false);
    assert.equal(path.isAbsolute(relative), false);
  }

  assert.equal(
    paths.htmlReportLogPath,
    'reports/demo-claim-certification-safe-run.html',
  );
  assert.equal(
    paths.jsonReportLogPath,
    'reports/demo-claim-certification-safe-run.json',
  );
});

test('rejects a path that escapes the selected root', () => {
  assert.throws(
    () => resolvePathInside(path.resolve('reports'), '..', 'escape.txt'),
    /escapes the reports directory/,
  );
});
