import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  }));
  return nested.flat();
}

async function surfaceAdapterFiles(): Promise<string[]> {
  const routes = await typescriptFiles(join(sourceRoot, 'routes'));
  const libFiles = await typescriptFiles(join(sourceRoot, 'lib'));
  return [...routes, ...libFiles.filter((path) => {
    const sourcePath = relative(sourceRoot, path).replaceAll('\\', '/');
    return (
      (/^lib\/agent(?:-|\.)/.test(sourcePath) && !sourcePath.includes('/test/'))
      || sourcePath === 'lib/mcp-tools.ts'
      || sourcePath.startsWith('lib/mcp-tools/')
      || sourcePath === 'lib/app-action-operations.ts'
      || sourcePath === 'lib/app-service.ts'
      || sourcePath === 'lib/app-review-service.ts'
    );
  })];
}

function schemaImportBlocks(source: string): string[] {
  return [...source.matchAll(
    /import\s*\{([\s\S]*?)\}\s*from\s*['"]@deft\/db\/schema['"]/g,
  )].map((match) => match[1] ?? '');
}

test('AppActionService composes authorization, discovery, relation, and App Run preparation without effects', async () => {
  const service = await readFile(join(sourceRoot, 'lib/app-action-service.ts'), 'utf8');

  assert.match(service, /resourceAuthorizationService\.resolve\s*\(/);
  assert.match(service, /listResourceRelation\s*\(/);
  assert.match(service, /private readonly capability:\s*AppActionCapabilityPort\s*=\s*lazyCapability/);
  assert.match(service, /await import\(['"]\.\/capability-service\.js['"]\)/);
  assert.match(service, /this\.capability\.discover\s*\(/);
  assert.match(service, /getAppRunRuntime\s*\(/);
  assert.match(service, /inputPreparation\.protect\s*\(/);
  assert.match(service, /inputPreparation\.open\s*\(/);
  assert.match(service, /service\.submitPreparedApp\s*\(/);

  const prepareStart = service.indexOf('async prepare(');
  const prepareResolve = service.indexOf('const resolved = await this.#resolve', prepareStart);
  const firstFieldRead = service.indexOf('this.fieldReader.read', prepareStart);
  assert.ok(prepareStart >= 0 && prepareResolve > prepareStart && firstFieldRead > prepareResolve);

  const resolveStart = service.indexOf('async #resolve(');
  const resolveContext = service.indexOf('loadActionContext(', resolveStart);
  const resolveResource = service.indexOf('resourceAuthorizationService.resolve', resolveStart);
  assert.ok(resolveStart >= 0 && resolveContext > resolveStart && resolveResource > resolveContext);

  const invokeStart = service.indexOf('async invoke(');
  const invokePrepare = service.indexOf('await this.prepare(', invokeStart);
  const invokeFreshOpen = service.indexOf('this.preparedInput.open', invokePrepare);
  const invokeSubmit = service.indexOf('this.runs.submitPreparedApp', invokeFreshOpen);
  assert.ok(
    invokeStart >= 0
      && invokePrepare > invokeStart
      && invokeFreshOpen > invokePrepare
      && invokeSubmit > invokeFreshOpen,
  );
  assert.match(service.slice(invokeSubmit), /current\.input_candidate/);

  const contextStart = service.indexOf('async function loadActionContext(');
  const contextEnd = service.indexOf('\nfunction assertPlacement(', contextStart);
  const contextSource = service.slice(contextStart, contextEnd);
  assert.match(contextSource, /installation\.active_grant_snapshot_id !== binding\.grant_snapshot_id/);
  assert.match(contextSource, /connection\.app_run_authorization_version !== binding\.connector_authorization_version/);
  assert.match(contextSource, /dependencyInstallation\.lifecycle_epoch !== lock\.dependency_lifecycle_epoch/);
  assert.match(contextSource, /await assertGrantAuthoritySurface\s*\(/);

  assert.doesNotMatch(service, /\bmcpClientManager\b/);
  assert.doesNotMatch(service, /\.executeTool\s*\(/);
  assert.doesNotMatch(service, /(?:PinnedMcp)?AppRunProviderExecutor|capability-providers\/mcp/);
  assert.doesNotMatch(service, /capabilityService\.invoke\s*\(/);
  assert.doesNotMatch(service, /(?:AppRunService|appRunService|\.service)\.submit\s*\(/);
  assert.doesNotMatch(service, /\.insert\s*\(\s*(?:appRuns|agentActions)\s*\)/);
});

test('routes, agent, MCP, and App lifecycle code cannot bypass the AppActionService authority seam', async () => {
  const appAuthorityTables = [
    'appInstallations',
    'appVersions',
    'appModuleBindings',
    'appGrantSnapshots',
    'appDependencyLocks',
    'appActionBindings',
    'appRuns',
  ] as const;
  const allowedAuthorityImports = new Map<string, ReadonlySet<string>>([
    // The connector management route must prevent deletion of a connector
    // retained by an immutable reviewed App binding.
    ['routes/mcp-connections.ts', new Set(['appActionBindings'])],
  ]);
  const authorityImportViolations: string[] = [];
  const appActionBypassViolations: string[] = [];
  const reviewManagementConsumers: string[] = [];

  for (const path of await surfaceAdapterFiles()) {
    const sourcePath = relative(sourceRoot, path).replaceAll('\\', '/');
    const source = await readFile(path, 'utf8');
    const appLifecycleOwner = sourcePath === 'lib/app-service.ts'
      || sourcePath === 'lib/app-review-service.ts';
    const importedSchema = schemaImportBlocks(source).join('\n');
    for (const table of appAuthorityTables) {
      if (
        !appLifecycleOwner
        && new RegExp(`\\b${table}\\b`).test(importedSchema)
        && !allowedAuthorityImports.get(sourcePath)?.has(table)
      ) authorityImportViolations.push(`${sourcePath}:${table}`);
    }

    if (!appLifecycleOwner && /app-review-service\.js['"]/.test(source)) {
      reviewManagementConsumers.push(sourcePath);
    }

    if (/\.submitPreparedApp\s*\(/.test(source)) {
      appActionBypassViolations.push(`${sourcePath}:submitPreparedApp`);
    }

    // Existing legacy/native Capability Service and agent_actions paths remain
    // out of scope. Once an adapter names AppActionService, it must not also
    // compose any lower-level App action execution or persistence boundary.
    if (!appLifecycleOwner && !/app-action-service\.js['"]|\bappActionService\b/.test(source)) continue;
    const forbidden = [
      /\bmcpClientManager\b/,
      /\.executeTool\s*\(/,
      /capabilityService\.invoke\s*\(/,
      /(?:PinnedMcp)?AppRunProviderExecutor|capability-providers\/mcp/,
      /(?:AppRunService|appRunService|\.service)\.submit\s*\(/,
      /\.submitPreparedApp\s*\(/,
      /\.insert\s*\(\s*(?:appRuns|agentActions)\s*\)/,
    ];
    for (const pattern of forbidden) {
      if (pattern.test(source)) appActionBypassViolations.push(`${sourcePath}:${pattern.source}`);
    }
  }

  assert.deepEqual(authorityImportViolations, []);
  assert.deepEqual(appActionBypassViolations, []);
  assert.deepEqual(reviewManagementConsumers, ['routes/apps.ts']);
});

test('App Run approve and reject routes stay on the governed approval resolver', async () => {
  const routes = await readFile(join(sourceRoot, 'routes/agent.ts'), 'utf8');
  const uses = routes.match(/if \(isApprovalResolverAction\(action\.action\)\)/g) ?? [];
  assert.equal(uses.length, 2, 'approve and reject must share the App Run-aware resolver predicate');

  const resolver = await readFile(join(sourceRoot, 'lib/agent-approval-resolver.ts'), 'utf8');
  assert.match(
    resolver,
    /return action === APP_RUN_APPROVAL_ACTION \|\| MCP_ACTION_KINDS\.has\(action\)/,
  );
});
