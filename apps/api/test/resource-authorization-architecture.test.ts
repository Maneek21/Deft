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

test('Phase 4 Resource authorization stays closed and owns no external effect path', async () => {
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
  const generalizedResourceRoutes: string[] = [];
  for (const path of await typescriptFiles(join(apiSourceRoot, 'routes'))) {
    const source = await readFile(path, 'utf8');
    if (/resource-authorization|ResourceAuthorizationService|ResourceRefV1/.test(source)) {
      routeConsumers.push(relative(apiSourceRoot, path).replaceAll('\\', '/'));
    }
    if (/['"]\/api\/resources(?:\/|['"])/.test(source)) {
      generalizedResourceRoutes.push(relative(apiSourceRoot, path).replaceAll('\\', '/'));
    }
  }
  assert.deepEqual(routeConsumers, ['routes/modules.ts']);
  assert.deepEqual(generalizedResourceRoutes, []);

  const appKitSource = await readFile(join(repositoryRoot, 'packages/app-kit/src/index.ts'), 'utf8');
  assert.doesNotMatch(appKitSource, /ResourceRef/);
});

test('bounded search callers use the live authorization wrapper and relations cannot execute effects', async () => {
  const rawSearchImporters: string[] = [];
  for (const path of await typescriptFiles(apiSourceRoot)) {
    const sourcePath = relative(apiSourceRoot, path).replaceAll('\\', '/');
    const source = await readFile(path, 'utf8');
    if (/import\s*\{\s*searchModuleRecords\s*\}\s*from\s*['"].*module-service\.js['"]/.test(source)) {
      rawSearchImporters.push(sourcePath);
    }
  }
  assert.deepEqual(rawSearchImporters, ['lib/resource-search-service.ts']);

  const search = await readFile(join(apiSourceRoot, 'lib/resource-search-service.ts'), 'utf8');
  assert.match(search, /resourceAuthorizationService\.resolve/);
  assert.match(search, /Search indexes nominate candidates only/);

  const relations = await readFile(join(apiSourceRoot, 'lib/resource-relation-service.ts'), 'utf8');
  assert.match(relations, /resourceAuthorizationService\.resolve/);
  assert.doesNotMatch(
    relations,
    /CapabilityService|capabilityService|mcpClientManager|executeTool|connector|\bfetch\s*\(/,
  );
});
