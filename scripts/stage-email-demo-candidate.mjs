#!/usr/bin/env node
// Local-only preparation: no SSH, database connection, deployment or cleanup.
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let output, migrationBaselinePath, build = false, ownerConnections = false, distribution = 'Deft-CRM-Test';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--output') output = args[++i];
  else if (args[i] === '--wsl') distribution = args[++i];
  else if (args[i] === '--build') build = true;
  else if (args[i] === '--owner-connections') ownerConnections = true;
  else if (args[i] === '--migration-baseline') migrationBaselinePath = args[++i];
  else throw new Error(`Unknown argument: ${args[i]}`);
}
if (!output || !isAbsolute(output)) throw new Error('--output must name a new absolute local directory.');
output = resolve(output);
if (relative(repo, output) === '' || !relative(repo, output).startsWith('..')) throw new Error('Keep generated candidate artifacts outside the worktree.');
if (existsSync(output)) throw new Error('Refusing to overwrite an existing candidate directory.');
if (!/^[A-Za-z0-9_.-]+$/.test(distribution)) throw new Error('Invalid WSL distribution name.');
if (ownerConnections && !migrationBaselinePath) throw new Error('Final owner-connection candidates require an explicitly verified deployed migration baseline.');

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const shaFile = async path => {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
};
const run = (command, argv, capture = true) => {
  const result = spawnSync(command, argv, { cwd: repo, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${capture ? result.stderr.trim().slice(0, 1200) : 'see build log'}`);
  return capture ? result.stdout.trim() : '';
};
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const wslPath = path => {
  const normalized = path.replaceAll('\\', '/');
  if (!/^[A-Za-z]:\//.test(normalized)) throw new Error('Candidate preparation currently supports Windows drive paths only.');
  return `/mnt/${normalized[0].toLowerCase()}${normalized.slice(2)}`;
};
const head = run('git', ['rev-parse', 'HEAD']);
const status = run('git', ['status', '--porcelain=v1']);
const listed = run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
const migrationOverrides = new Map();
let historicalMigrationBaseline = null;
if (migrationBaselinePath) {
  if (!isAbsolute(migrationBaselinePath)) throw new Error('--migration-baseline must be an absolute public manifest path.');
  const baselineBytes = readFileSync(migrationBaselinePath);
  const baseline = JSON.parse(baselineBytes);
  if (baseline.schema_version !== 'deft.demo_migration_baseline.v1' || baseline.schema_head !== '0.3.0-preview.56'
    || !Array.isArray(baseline.ledger) || !Array.isArray(baseline.files)
    || !/^sha256:[a-f0-9]{64}$/.test(baseline.image_id ?? '')) throw new Error('Invalid deployed migration baseline.');
  const declared = new Map([...readFileSync(resolve(repo, 'packages/db/upgrades/manifest.ts'), 'utf8')
    .matchAll(/version:\s*'([^']+)',\s*file:\s*'([^']+)'/g)].map(match => [match[1], `packages/db/upgrades/${match[2]}`]));
  const applied = baseline.ledger.filter(row => row.kind === 'migration');
  if (new Set(applied.map(row => row.version)).size !== applied.length || applied.length !== baseline.files.length
    || !applied.some(row => row.version === baseline.schema_head)) throw new Error('Incomplete applied migration baseline.');
  const lf = bytes => Buffer.from(bytes.toString('latin1').replaceAll('\r\n', '\n'), 'latin1');
  for (const row of applied) {
    if (!/^0\.2\.0-preview\.\d+$/.test(row.version) && (!/^0\.3\.0-preview\.\d+$/.test(row.version)
      || Number(row.version.match(/\.(\d+)$/)[1]) > 56)) throw new Error('Applied migration exceeds the observed deployed baseline.');
    const file = baseline.files.find(item => item.version === row.version);
    if (!file || file.path !== declared.get(row.version) || !/^[a-f0-9]{64}$/.test(row.checksum ?? '')
      || !/^packages\/db\/upgrades\/0\.[23]\.0-preview\.\d+-[a-z0-9-]+\.sql$/.test(file.path)
      || file.export_path !== `sql/${file.path.split('/').at(-1)}`) throw new Error('Unknown historical migration override.');
    const sourceBytes = readFileSync(resolve(repo, file.path));
    const deployedBytes = readFileSync(resolve(dirname(migrationBaselinePath), file.export_path));
    if (sha(deployedBytes) !== row.checksum || file.sha256 !== row.checksum || file.byte_length !== deployedBytes.length
      || sha(sourceBytes) !== file.source_sha256 || !lf(sourceBytes).equals(lf(deployedBytes))) throw new Error(`Deployed migration checksum/content mismatch: ${row.version}`);
    migrationOverrides.set(file.path, { bytes: deployedBytes, version: row.version, checksum: row.checksum, worktree_sha256: sha(sourceBytes) });
  }
  historicalMigrationBaseline = { schema_head: baseline.schema_head, deployment: baseline.deployment, image_id: baseline.image_id,
    manifest_sha256: sha(baselineBytes), applied_sql_count: applied.length,
    overridden_file_count: [...migrationOverrides.values()].filter(item => sha(item.bytes) !== item.worktree_sha256).length,
    all_applied_sql_checksums_verified: true, all_source_content_equal_modulo_crlf_lf: true,
    ledger_edits: [], worktree_edits: [] };
}
const files = [];
const source = resolve(output, 'source');
mkdirSync(source, { recursive: true });
for (const name of [...new Set(listed)].sort()) {
  if (name.startsWith('/') || name.split('/').includes('..')) throw new Error('Unsafe Git path.');
  if (/(^|\/)(node_modules|\.next|dist|coverage|uploads|backups|\.git)(\/|$)/.test(name)) continue;
  if (/(^|\/)\.env($|\.)/.test(name) && !/(^|\/)\.env\.example$/.test(name)) continue;
  if (/\.(pem|key|p12|pfx)$/i.test(name) || /(^|\/)(auth|cookies|credentials)\.json$/i.test(name)) throw new Error(`Private-looking file cannot enter public source archive: ${name}`);
  const current = resolve(repo, name);
  if (!existsSync(current)) continue; // Tracked deletions remain deleted in the snapshot.
  const stat = lstatSync(current);
  if (!stat.isFile()) throw new Error(`Only regular source files are supported: ${name}`);
  const worktreeBytes = readFileSync(current);
  const override = migrationOverrides.get(name);
  if (override && sha(worktreeBytes) !== override.worktree_sha256) throw new Error(`Historical source changed while freezing: ${name}`);
  const bytes = override?.bytes ?? worktreeBytes;
  const target = resolve(source, name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  files.push({ path: name, byte_length: bytes.length, sha256: sha(bytes),
    ...(override && !bytes.equals(worktreeBytes) ? { worktree_sha256: sha(worktreeBytes), baseline_override: { version: override.version, checksum: override.checksum, source: 'read-only deployed SQL export' } } : {}) });
}
// Refuse a racing source edit. Only explicitly attested deployed historical bytes
// may differ from the checkout; both representations remain identified.
for (const file of files) {
  if (!existsSync(resolve(repo, file.path)) || sha(readFileSync(resolve(repo, file.path))) !== (file.worktree_sha256 ?? file.sha256)) throw new Error(`Source changed while freezing: ${file.path}`);
}
if (run('git', ['rev-parse', 'HEAD']) !== head || run('git', ['status', '--porcelain=v1']) !== status) throw new Error('Git state changed while freezing. Retry in a new output directory.');
const sourceDigest = sha(Buffer.from(files.map(file => `${file.path}\0${file.byte_length}\0${file.sha256}\n`).join('')));
const suffix = sourceDigest.slice(0, 12);
const image = `deft:email-stage1-${suffix}`;
const identity = `${head}-email-stage1-${suffix}`;
const version = `0.3.0-preview.16+email-stage1.${suffix}`;
const publicArchive = `deft-source-email-stage1-${sourceDigest}.tar.gz`;
const sourceUrl = `https://demo.deft.ing/releases/${publicArchive}`;
const declaredMigrations = [...readFileSync(resolve(source, 'packages/db/upgrades/manifest.ts'), 'utf8')
  .matchAll(/version:\s*'([^']+)',\s*file:\s*'([^']+)'/g)].map(match => ({ version: match[1], file: match[2] }));
const neededMigrations = declaredMigrations.filter(item => /^0\.3\.0-preview\.(\d+)$/.test(item.version)
  && Number(item.version.match(/\.(\d+)$/)[1]) > 56);
if (!neededMigrations.length) throw new Error('No supported migrations after the observed demo56 baseline.');
const targetSchema = declaredMigrations.at(-1)?.version;
if (!/^0\.3\.0-preview\.\d+$/.test(targetSchema ?? '')) throw new Error('Unsupported frozen target schema identity.');
const declaredHealthSchema = readFileSync(resolve(source, 'apps/api/src/lib/agent-channel.ts'), 'utf8')
  .match(/export const DEFT_SCHEMA_HEAD\s*=\s*['"]([^'"]+)['"]/u)?.[1];
if (declaredHealthSchema !== targetSchema) throw new Error(`Declared health schema ${declaredHealthSchema ?? 'missing'} does not match migration target ${targetSchema}.`);
if (ownerConnections && Number(targetSchema?.match(/\.(\d+)$/)?.[1]) < 60) throw new Error('Owner connections require a frozen supported preview60+ manifest.');
const manifestPath = resolve(output, 'candidate-manifest.json');
const manifest = {
  schema_version: 'deft.demo_candidate.v1', provisional: true, created_at: new Date().toISOString(),
  base_commit: head, worktree_dirty: status.length > 0, source_digest: sourceDigest,
  source_digest_format: 'SHA256 of sorted UTF-8 path NUL byte_length NUL SHA256 LF records',
  source_file_count: files.length, source_file_manifest: 'source-files.json',
  source_bytes: files.reduce((total, file) => total + file.byte_length, 0),
  image_tag: image, build_identity: identity, version,
  platform: 'linux/amd64', builder: { wsl_distribution: distribution },
  source_offer: { url: sourceUrl, embedded_path: `/app/apps/web/public/releases/${publicArchive}`, available_after_candidate_start: true },
  expected_previous_schema: '0.3.0-preview.56', target_schema: targetSchema,
  declared_health_schema: { schema_head: declaredHealthSchema, matches_migration_target: true, actual_http_readiness: 'Requires separate restored-host rehearsal.' },
  historical_migration_baseline: historicalMigrationBaseline,
  runtime_opt_ins: { owner_connections: ownerConnections },
  migrations: neededMigrations.map(item => ({ version: item.version, file: `packages/db/upgrades/${item.file}`, sha256: sha(readFileSync(resolve(source, 'packages/db/upgrades', item.file))) })),
  build_args: { VCS_REF: identity, SOURCE_URL: sourceUrl, DEFT_RELEASE_VERSION: version, NEXT_PUBLIC_FEATURE_HUDDLES: 'true', NEXT_PUBLIC_FEATURE_APPS: 'true', NEXT_PUBLIC_FEATURE_APP_RESOURCE_SYNC: 'true', NEXT_PUBLIC_FEATURE_APP_ATTACHMENT_BROKER: 'true', NEXT_PUBLIC_DEFT_SELF_HOSTED: 'true' },
  remote_actions: [], database_actions: [], built: false,
};
writeFileSync(resolve(output, 'source-files.json'), JSON.stringify(files, null, 2) + '\n');
writeFileSync(resolve(output, 'source-git-status.txt'), status + '\n');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
const archive = resolve(output, 'source.tar.gz');
run('wsl.exe', ['-d', distribution, '--', 'tar', '-czf', wslPath(archive), '-C', wslPath(source), '.']);
manifest.source_archive = { path: 'source.tar.gz', sha256: sha(readFileSync(archive)), byte_length: lstatSync(archive).size };
const releases = resolve(source, 'apps/web/public/releases');
mkdirSync(releases, { recursive: true });
copyFileSync(archive, resolve(releases, publicArchive));
const overlay = `# Append LAST to the reviewed live Compose stack. No build/pull on demo.\nx-candidate-image: &candidate-image\n  image: ${image}\n  pull_policy: never\n  build: !reset null\nservices:\n  deft:\n    <<: *candidate-image\n    environment:\n      DEFT_SOURCE_CODE_URL: ${sourceUrl}\n${ownerConnections ? '      DEFT_APP_OWNER_CONNECTIONS_ENABLED: "true"\n' : ''}  init:\n    <<: *candidate-image\n  upgrade:\n    <<: *candidate-image\n  doctor:\n    <<: *candidate-image\n  smoke:\n    <<: *candidate-image\n`;
writeFileSync(resolve(output, 'compose.email-stage1.yml'), overlay);
const buildScript = `#!/bin/bash\nset -euo pipefail\ncd ${quote(wslPath(output))}\ndocker version --format '{{.Server.Version}} {{.Server.Os}} {{.Server.Arch}}'\ndocker build --platform linux/amd64 --progress=plain --tag ${quote(image)} ${Object.entries(manifest.build_args).map(([key, value]) => `--build-arg ${quote(`${key}=${value}`)}`).join(' ')} ${quote(wslPath(source))} 2>&1 | tee build.log\ndocker image inspect ${quote(image)} > image-inspect.json\ndocker save ${quote(image)} | gzip -1 > image.tar.gz\nsha256sum source.tar.gz image.tar.gz > SHA256SUMS\n`;
writeFileSync(resolve(output, 'build-local.sh'), buildScript);
manifest.compose_overlay = { path: 'compose.email-stage1.yml', sha256: sha(Buffer.from(overlay)) };
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ output, source_digest: sourceDigest, image, target_schema: manifest.target_schema, built: false }));
if (build) {
  run('wsl.exe', ['-d', distribution, '--', 'bash', wslPath(resolve(output, 'build-local.sh'))], false);
  const inspected = JSON.parse(readFileSync(resolve(output, 'image-inspect.json'), 'utf8'))[0];
  manifest.built = true;
  manifest.image_id = inspected.Id;
  manifest.image_size = inspected.Size;
  const healthProbe = `const fs=require('node:fs');const head=fs.readFileSync('/app/apps/api/src/lib/agent-channel.ts','utf8').match(/export const DEFT_SCHEMA_HEAD\\s*=\\s*['"]([^'"]+)['"]/u)?.[1];if(head!==${JSON.stringify(targetSchema)})throw new Error('Packaged health schema mismatch');process.stdout.write(JSON.stringify({schema_head:head,matches_migration_target:true,network:'none',database_actions:[]}));`;
  manifest.packaged_declared_health_schema = JSON.parse(run('wsl.exe', ['-d', distribution, '--', 'docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'node', image, '-e', healthProbe]));
  const savedImages = JSON.parse(run('wsl.exe', ['-d', distribution, '--', 'tar', '-xOzf', wslPath(resolve(output, 'image.tar.gz')), 'manifest.json']));
  const configDigest = savedImages.length === 1 && savedImages[0].Config.match(/(?:^|\/)([a-f0-9]{64})(?:\.json)?$/)?.[1];
  if (!configDigest) throw new Error('Saved platform configuration identity unavailable.');
  manifest.saved_platform_config_digest = `sha256:${configDigest}`;
  manifest.image_archive = { path: 'image.tar.gz', sha256: await shaFile(resolve(output, 'image.tar.gz')), byte_length: lstatSync(resolve(output, 'image.tar.gz')).size };
  manifest.built_at = new Date().toISOString();
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ output, image_id: manifest.image_id, archive: manifest.image_archive, built: true }));
}
