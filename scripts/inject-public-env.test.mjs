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

test('fills the page policy origins, with WebSocket forms, from the public URLs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deft-public-env-'));
  try {
    const manifest = join(root, 'routes-manifest.json');
    await writeFile(manifest, `"connect-src 'self' __DEFT_API_ORIGIN__ __DEFT_API_WS_ORIGIN__ __DEFT_WS_ORIGIN__ __DEFT_WS_WS_ORIGIN__"`);
    await injectPublicEnv(root, {
      NEXT_PUBLIC_APP_URL: 'https://deft.example',
      NEXT_PUBLIC_API_URL: 'https://api.deft.example/base/',
      NEXT_PUBLIC_WS_URL: 'http://live.deft.example:8080',
    });
    assert.equal(
      await readFile(manifest, 'utf8'),
      `"connect-src 'self' https://api.deft.example wss://api.deft.example http://live.deft.example:8080 ws://live.deft.example:8080"`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses an API or live-connection address that is not an http or https URL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deft-public-env-'));
  try {
    await assert.rejects(
      injectPublicEnv(root, { NEXT_PUBLIC_APP_URL: 'https://deft.example', NEXT_PUBLIC_API_URL: 'api.deft.example', NEXT_PUBLIC_WS_URL: 'https://deft.example' }),
      /NEXT_PUBLIC_API_URL must be an absolute http or https URL/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
