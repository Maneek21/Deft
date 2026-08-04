import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWindowsPnpmCommandArgs } from './windows-pnpm-command.js';

test('builds cmd.exe arguments without constructing a shell command string', () => {
  assert.deepEqual(
    buildWindowsPnpmCommandArgs([
      '--filter',
      '@deft/web',
      'exec',
      'next',
      'dev',
      '--port',
      '3000',
    ]),
    [
      '/d',
      '/c',
      'pnpm.cmd',
      '--filter',
      '@deft/web',
      'exec',
      'next',
      'dev',
      '--port',
      '3000',
    ],
  );
});

for (const unsafeArg of [
  'dev & whoami',
  '$(whoami)',
  '%PATH%',
  '!PATH!',
  'quoted"value',
  'line\nbreak',
]) {
  test(`rejects cmd.exe metacharacters in ${JSON.stringify(unsafeArg)}`, () => {
    assert.throws(
      () => buildWindowsPnpmCommandArgs(['dev', unsafeArg]),
      /unsafe argument/,
    );
  });
}
