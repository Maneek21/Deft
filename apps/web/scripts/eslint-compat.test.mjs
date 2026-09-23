import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ESLint } from 'eslint';

const eslint = new ESLint({ cwd: fileURLToPath(new URL('../', import.meta.url)) });
const filePath = 'src/lint-compat-fixture.tsx';

test('Next, React, hooks and TypeScript rules still report violations', async () => {
  const [result] = await eslint.lintText(`
    import { forwardRef, useState } from 'react';
    const unused = 1;
    export const Anonymous = forwardRef(() => <div />);
    export function Invalid({ enabled }: { enabled: boolean }) {
      if (enabled) useState(0);
      return <div>{[1, 2].map(value => <span>{value}</span>)}<script src="/test.js" /></div>;
    }
  `, { filePath });
  const ruleIds = new Set(result.messages.map(message => message.ruleId));
  for (const rule of [
    'react/display-name',
    'react/jsx-key',
    'react-hooks/rules-of-hooks',
    '@typescript-eslint/no-unused-vars',
    '@next/next/no-sync-scripts',
  ]) assert.ok(ruleIds.has(rule), `${rule} must still report: ${JSON.stringify(result.messages)}`);
});

test('valid typed React components pass the configured rules', async () => {
  const [result] = await eslint.lintText(`
    export function Greeting({ name }: { name: string }) {
      return <p>Hello {name}</p>;
    }
  `, { filePath });
  assert.deepEqual(result.messages, []);
});
