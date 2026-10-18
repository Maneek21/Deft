#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium } from 'playwright';
import { readReleaseBrowserProfile } from './resolve-release-browser-profile.mjs';

const profile = await readReleaseBrowserProfile();
const baseUrl = process.env.RELEASE_BROWSER_URL || 'http://127.0.0.1:3100';
const image = process.env.RELEASE_IMAGE_REF;
assert.match(image ?? '', /^ghcr\.io\/[a-z0-9_./-]+@sha256:[a-f0-9]{64}$/, 'An immutable release image reference is required');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const chunks = [];
  const pendingChunks = [];
  page.on('response', (response) => {
    if (!new URL(response.url()).pathname.startsWith('/_next/static/')
      || !new URL(response.url()).pathname.endsWith('.js')) return;
    pendingChunks.push((async () => {
      assert.equal(response.status(), 200, `Browser chunk failed: ${response.url()}`);
      const body = await response.body();
      chunks.push({
        path: new URL(response.url()).pathname,
        sha256: createHash('sha256').update(body).digest('hex'),
        contains_diagnostic: body.includes(Buffer.from('data-deft-browser-features')),
      });
    })());
  });
  const response = await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
  assert.equal(response?.status(), 200, 'The exact image must serve the login page');
  // A fresh context has no account, mailbox, injected flags, or saved session.
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-deft-browser-features'), undefined, { timeout: 30_000 });
  const actual = JSON.parse(await page.locator('html').getAttribute('data-deft-browser-features'));
  assert.deepEqual(actual, profile.features, 'Compiled browser flags differ from the release profile');
  await Promise.all(pendingChunks);
  assert.ok(chunks.some((chunk) => chunk.contains_diagnostic), 'The diagnostic must originate from an actual served browser bundle');
  const evidence = {
    schema: 'deft.release.browser-feature-evidence.v1',
    result: 'passed',
    profile: profile.profile,
    version: profile.version,
    image,
    features: actual,
    verified_at: new Date().toISOString(),
    browser_chunks: chunks.sort((left, right) => left.path.localeCompare(right.path)),
  };
  const output = process.env.RELEASE_BROWSER_EVIDENCE_PATH || 'dist/browser-feature-evidence.json';
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ result: evidence.result, profile: evidence.profile, image, features: actual, output }));
} finally {
  await browser.close();
}
