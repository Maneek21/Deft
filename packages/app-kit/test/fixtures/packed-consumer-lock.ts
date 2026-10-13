import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Seed only the recorded Kit/Zod graph. A frozen offline install then needs
 * cached package bytes, not registry metadata or an invented registry entry. */
export async function seedPackedConsumerLock(input: {
  packageRoot: string; consumerDir: string; archive: string;
}) {
  const metadata = JSON.parse(await readFile(resolve(input.packageRoot, 'package.json'), 'utf8'));
  assert.equal(metadata.name, '@deft/app-kit');
  assert.deepEqual(Object.keys(metadata.dependencies), ['zod'],
    'Update this fixture deliberately if the packed Kit runtime dependency graph changes');
  const zodVersion = metadata.dependencies.zod as string;
  assert.match(zodVersion, /^\d+\.\d+\.\d+$/u, 'Kit must pin the recorded exact Zod version');
  const rootLock = (await readFile(resolve(input.packageRoot, '..', '..', 'pnpm-lock.yaml'), 'utf8'))
    .replaceAll('\r\n', '\n');
  assert.match(rootLock, /^lockfileVersion: '9\.0'\n/u);

  // Extract only exact, dependency-free blocks from the validated root lock.
  // Fail closed on a changed layout/graph rather than silently dropping fields.
  const block = (section: string, key: string) => {
    const heading = `\n${section}:\n`;
    const start = rootLock.indexOf(heading);
    assert.ok(start >= 0, `Missing root lock ${section}`);
    const sectionText = rootLock.slice(start + heading.length).split(/\n(?=\S)/u)[0]!;
    const lines = sectionText.split('\n');
    const index = lines.findIndex(line => line === `  ${key}:` || line === `  ${key}: {}`);
    assert.ok(index >= 0, `Missing recorded root lock ${section}/${key}`);
    const content = [lines[index]!];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]!;
      if (line.startsWith('  ') && !line.startsWith('    ')) break;
      if (line.trim()) content.push(line);
    }
    return content.join('\n');
  };
  const escapedVersion = zodVersion.replaceAll('.', '\\.');
  assert.match(block('importers', 'packages/app-kit'), new RegExp(
    `^  packages/app-kit:\\n    dependencies:\\n      zod:\\n        specifier: ${escapedVersion}\\n        version: ${escapedVersion}(?:\\n|$)`, 'u'),
  'Kit dependency must match the root lock importer');
  const zodKey = `zod@${zodVersion}`;
  const resolution = block('packages', zodKey).match(new RegExp(
    `^  zod@${escapedVersion}:\\n    resolution: \\{integrity: (sha512-[A-Za-z0-9+/]+={0,2})\\}$`, 'u'));
  assert.ok(resolution, 'Expected an exact recorded dependency-free Zod resolution');
  assert.equal(block('snapshots', zodKey), `  ${zodKey}: {}`,
    'Unexpected Zod transitive dependencies require a fixture update');

  const consumer = JSON.parse(await readFile(resolve(input.consumerDir, 'package.json'), 'utf8'));
  const section = consumer.dependencies?.[metadata.name] ? 'dependencies' : 'devDependencies';
  const dependency = consumer[section]?.[metadata.name];
  assert.equal(dependency, `file:${resolve(input.archive).replaceAll('\\', '/')}`);
  assert.deepEqual(Object.keys(consumer[section]), [metadata.name], 'Fixture seeds only the packed Kit');
  assert.equal(Object.keys(consumer[section === 'dependencies' ? 'devDependencies' : 'dependencies'] ?? {}).length, 0);
  const kitKey = `${metadata.name}@${dependency}`;
  const archiveIntegrity = `sha512-${createHash('sha512').update(await readFile(input.archive)).digest('base64')}`;
  const lock = {
    lockfileVersion: '9.0',
    settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
    importers: { '.': { [section]: { [metadata.name]: { specifier: dependency, version: dependency } } } },
    packages: {
      [kitKey]: { resolution: { integrity: archiveIntegrity, tarball: dependency },
        version: metadata.version, hasBin: Boolean(metadata.bin) },
      [zodKey]: { resolution: { integrity: resolution[1] } },
    },
    snapshots: { [kitKey]: { dependencies: { zod: zodVersion } }, [zodKey]: {} },
  };
  // JSON is valid YAML and avoids platform/path quoting ambiguities.
  await writeFile(resolve(input.consumerDir, 'pnpm-lock.yaml'), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}
