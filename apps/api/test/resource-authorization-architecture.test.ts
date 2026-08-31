import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const apiSourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  }));
  return nested.flat();
}

test('PR A Resource authorization seam is dormant and owns no data or effect path', async () => {
  const service = await readFile(join(apiSourceRoot, 'lib/resource-authorization.ts'), 'utf8');
  assert.doesNotMatch(
    service,
    /@deft\/db|drizzle-orm|CapabilityService|AppRun|executeTool|mcpClientManager|\bfetch\s*\(/,
  );
  assert.doesNotMatch(service, /\bregister\s*\(/);

  const providers = await readFile(join(apiSourceRoot, 'lib/resource-provider-adapters.ts'), 'utf8');
  assert.match(providers, /module:\s*moduleResourceProviderAdapter/);
  assert.match(providers, /tasks:\s*taskResourceProviderAdapter/);
  assert.doesNotMatch(providers, /\bregister\s*\(/);

  const routeConsumers: string[] = [];
  for (const path of await typescriptFiles(join(apiSourceRoot, 'routes'))) {
    const source = await readFile(path, 'utf8');
    if (/resource-authorization|ResourceAuthorizationService|ResourceRefV1/.test(source)) {
      routeConsumers.push(relative(apiSourceRoot, path).replaceAll('\\', '/'));
    }
  }
  assert.deepEqual(routeConsumers, []);

  const appKitSource = await readFile(join(repositoryRoot, 'packages/app-kit/src/index.ts'), 'utf8');
  assert.doesNotMatch(appKitSource, /ResourceRef|resource_requirements|capability_requirements/);
});
