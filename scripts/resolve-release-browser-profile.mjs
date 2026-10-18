#!/usr/bin/env node

import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function readReleaseBrowserProfile({
  profilePath = 'release/browser-profile.json',
  packagePath = 'package.json',
} = {}) {
  const document = JSON.parse(await readFile(profilePath, 'utf8'));
  if (!document || Array.isArray(document)
    || JSON.stringify(Object.keys(document).sort()) !== JSON.stringify(['profile', 'schema'])
    || document.schema !== 'deft.release.browser-profile.v1'
    || !['core', 'apps-developer-preview'].includes(document.profile)) {
    throw new Error('Invalid commit-pinned release browser profile');
  }
  const { version } = JSON.parse(await readFile(packagePath, 'utf8'));
  const enabled = document.profile === 'apps-developer-preview';
  if (enabled && !/^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(version ?? '')) {
    throw new Error('The Apps developer-preview browser profile requires a prerelease version');
  }
  return {
    ...document,
    version,
    features: { apps: enabled, resource_sync: enabled, attachment_broker: enabled },
  };
}

async function main() {
  const profile = await readReleaseBrowserProfile({
    profilePath: process.env.RELEASE_BROWSER_PROFILE_PATH || 'release/browser-profile.json',
    packagePath: process.env.RELEASE_PACKAGE_PATH || 'package.json',
  });
  if (process.argv.includes('--github-output')) {
    if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
    await appendFile(process.env.GITHUB_OUTPUT, [
      `profile=${profile.profile}`,
      ...Object.entries(profile.features).map(([key, value]) => `${key}=${value}`),
      '',
    ].join('\n'));
  }
  console.log(JSON.stringify(profile));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
