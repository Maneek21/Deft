import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { injectPublicEnv } from './inject-public-env.mjs';

test('injects public URLs into nested Next.js output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deft-public-env-'));
  try {
    await mkdir(join(root, 'static', 'chunks'), { recursive: true });
    const chunk = join(root, 'static', 'chunks', 'app.js');
    await writeFile(chunk, '"__DEFT_APP_URL__"+"__DEFT_API_URL__"+"__DEFT_WS_URL__"');

    const result = await injectPublicEnv(root, {
      NEXT_PUBLIC_APP_URL: 'https://deft.example/',
      NEXT_PUBLIC_API_URL: 'https://deft.example/',
      NEXT_PUBLIC_WS_URL: 'https://deft.example/',
    });

    assert.deepEqual(result, { filesChanged: 1, replacementsMade: 3 });
    assert.equal(
      await readFile(chunk, 'utf8'),
      '"https://deft.example"+"https://deft.example"+"https://deft.example"',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fails clearly when a required runtime URL is absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deft-public-env-'));
  try {
    await assert.rejects(
      injectPublicEnv(root, {
        NEXT_PUBLIC_APP_URL: 'https://deft.example',
        NEXT_PUBLIC_API_URL: 'https://deft.example',
      }),
      /NEXT_PUBLIC_WS_URL is required/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
