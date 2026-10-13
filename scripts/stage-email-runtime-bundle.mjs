#!/usr/bin/env node
// Freeze installed production dependency versions; never install, send or deploy.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, createReadStream } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!['--output', '--consumer', '--host-manifest', '--wsl'].includes(key) || !process.argv[i + 1]) throw new Error('Expected --output, --consumer, optional --host-manifest and --wsl value pairs.');
  options[key.slice(2)] = process.argv[i + 1];
}
for (const key of ['output', 'consumer']) if (!options[key] || !isAbsolute(options[key])) throw new Error(`--${key} must be an absolute local directory.`);
const output = resolve(options.output), consumer = resolve(options.consumer), distribution = options.wsl ?? 'Deft-CRM-Test';
if (existsSync(output)) throw new Error('Refusing to overwrite a frozen bundle.');
if (!relative(repo, output).startsWith('..') || !/^[A-Za-z0-9_.-]+$/.test(distribution)) throw new Error('Keep staging outside the worktree and use a valid WSL distribution.');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = async file => { const digest = createHash('sha256'); for await (const chunk of createReadStream(file)) digest.update(chunk); return digest.digest('hex'); };
const slash = path => path.replaceAll('\\', '/');
const wslPath = path => { const p = slash(path); if (!/^[A-Za-z]:\//.test(p)) throw new Error('Windows drive paths required.'); return `/mnt/${p[0].toLowerCase()}${p.slice(2)}`; };
const locate = (name, from) => {
  const require = createRequire(join(from, 'package.json'));
  const found = require.resolve.paths(name)?.map(base => join(base, name, 'package.json')).find(existsSync);
  if (!found) throw new Error(`Required installed dependency unavailable: ${name}`);
  const path = realpathSync(dirname(found)), pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
  if (pkg.name !== name || typeof pkg.version !== 'string') throw new Error('Installed dependency identity mismatch.');
  return { path, pkg };
};
const roots = ['@deft/app-kit', 'nodemailer', 'mailparser', 'imapflow'];
const packages = new Map(), rootLinks = [], queue = [];
const add = (name, from) => {
  const located = locate(name, from), key = hash(Buffer.from(`${located.pkg.name}\0${located.pkg.version}\0${located.path}`)).slice(0, 24);
  if (!packages.has(key)) { packages.set(key, { key, ...located, links: [] }); queue.push(key); }
  return key;
};
for (const name of roots) rootLinks.push({ name, key: add(name, consumer) });
while (queue.length) {
  const current = packages.get(queue.shift());
  for (const name of [...new Set([...Object.keys(current.pkg.dependencies ?? {}), ...Object.keys(current.pkg.optionalDependencies ?? {}), ...Object.keys(current.pkg.peerDependencies ?? {})])].sort()) {
    try { current.links.push({ name, key: add(name, current.path) }); }
    catch (error) { if (Object.hasOwn(current.pkg.optionalDependencies ?? {}, name) || current.pkg.peerDependenciesMeta?.[name]?.optional === true) continue; throw error; }
  }
}
const source = resolve(output, 'bundle'), files = [], originalFiles = [], links = [];
mkdirSync(source, { recursive: true });
function copyFile(current, name) {
  const bytes = readFileSync(current), target = resolve(source, name);
  mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes);
  const entry = { path: slash(name), byte_length: bytes.length, sha256: hash(bytes) };
  files.push(entry); originalFiles.push({ current, sha256: entry.sha256 });
}
function copyPackage(current, target, prefix = '') {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const src = join(current, entry.name), dest = join(target, prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Package contains a non-dependency symlink; inspect before staging.');
    if (entry.isDirectory()) copyPackage(src, target, join(prefix, entry.name));
    else if (entry.isFile()) copyFile(src, dest);
  }
}
const email = resolve(repo, 'examples/apps/email');
for (const directory of ['', 'providers']) {
  for (const entry of readdirSync(join(email, directory), { withFileTypes: true })) {
    if (entry.isFile() && (entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs') || !directory && entry.name === 'package.json')) {
      copyFile(join(email, directory, entry.name), join('email', directory, entry.name));
    }
  }
}
for (const pkg of packages.values()) {
  copyPackage(pkg.path, join('packages', pkg.key));
  for (const dependency of pkg.links) {
    const link = join('packages', pkg.key, 'node_modules', dependency.name);
    links.push({ link: slash(link), target: slash(relative(dirname(link), join('packages', dependency.key))) });
  }
}
for (const dependency of rootLinks) {
  const link = join('node_modules', dependency.name);
  links.push({ link: slash(link), target: slash(relative(dirname(link), join('packages', dependency.key))) });
}
// Exact source bytes plus installed dependency resolution are the frozen unit.
for (const file of originalFiles) if (!existsSync(file.current) || hash(readFileSync(file.current)) !== file.sha256) throw new Error(`Source or installed package changed while freezing: ${file.current}`);
files.sort((a, b) => a.path.localeCompare(b.path));
links.sort((a, b) => a.link.localeCompare(b.link));
const linkBytes = JSON.stringify(links, null, 2) + '\n';
const linkDigest = hash(Buffer.from(linkBytes));
const sourceDigest = hash(Buffer.from(files.map(file => `${file.path}\0${file.byte_length}\0${file.sha256}\n`).join('') + `runtime-links.json\0${Buffer.byteLength(linkBytes)}\0${linkDigest}\n`));
writeFileSync(join(output, 'bundle-files.json'), JSON.stringify(files, null, 2) + '\n');
writeFileSync(join(output, 'runtime-links.json'), linkBytes);
const hostManifest = options['host-manifest'] ? JSON.parse(readFileSync(options['host-manifest'], 'utf8')) : null;
const hostFiles = hostManifest ? JSON.parse(readFileSync(join(dirname(options['host-manifest']), hostManifest.source_file_manifest), 'utf8')) : [];
const hostByPath = new Map(hostFiles.map(file => [file.path, file.sha256]));
const mismatches = files.filter(file => file.path.startsWith('email/')).filter(file => hostByPath.get(`examples/apps/${file.path}`) !== file.sha256).map(file => file.path);
const manifest = { schema_version: 'deft.email_runtime_bundle.v1', provisional: true, created_at: new Date().toISOString(),
  source_digest: sourceDigest, file_count: files.length, byte_length: files.reduce((sum, file) => sum + file.byte_length, 0),
  roots: rootLinks, packages: [...packages.values()].map(pkg => ({ key: pkg.key, name: pkg.pkg.name, version: pkg.pkg.version, dependencies: pkg.links })),
  package_count: packages.size, nested_dependency_links: [...packages.values()].reduce((sum, pkg) => sum + pkg.links.length, 0),
  source_file_manifest: 'bundle-files.json', link_manifest: 'runtime-links.json', link_manifest_sha256: linkDigest,
  connection_entry: { path: '/opt/deft-email-module/email/providers/connection-http.mjs', sha256: hash(readFileSync(join(source, 'email/providers/connection-http.mjs'))) },
  host_source_digest: hostManifest?.source_digest ?? null, host_email_source_matches: hostManifest ? mismatches.length === 0 : null, host_email_source_mismatches: mismatches,
  app_kit_source_match: 'Not attested by version alone; final freeze must compare matching host-built Kit artifacts with these installed bytes.',
  runtime_credential_files: [], remote_actions: [], mount_policy: 'Read-only module/dependency mount; separate private writable custody and configuration; no node_modules flattening.',
};
writeFileSync(join(output, 'bundle-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const linuxRoot = `/var/tmp/deft-email-runtime-bundle-${sourceDigest.slice(0, 16)}`;
const script = `import json,os,shutil,tarfile\nsource=${JSON.stringify(wslPath(source))}\nroot=${JSON.stringify(linuxRoot)}\nif os.path.exists(root): raise RuntimeError('Refusing to overwrite existing Linux bundle')\nshutil.copytree(source,root)\nlinks=json.load(open(${JSON.stringify(wslPath(join(output, 'runtime-links.json')))}))\nfor item in links:\n p=os.path.join(root,item['link']);os.makedirs(os.path.dirname(p),exist_ok=True);os.symlink(item['target'],p)\nwith tarfile.open(${JSON.stringify(wslPath(join(output, 'runtime.tar.gz')))},'w:gz') as archive: archive.add(root,arcname='.')\nprint(json.dumps({'linux_bundle':root,'links':len(links)}))\n`;
writeFileSync(join(output, 'assemble-linux.py'), script);
const assembled = spawnSync('wsl.exe', ['-d', distribution, '--', 'python3', wslPath(join(output, 'assemble-linux.py'))], { encoding: 'utf8' });
if (assembled.status !== 0) throw new Error(assembled.stderr.trim().slice(0, 1200));
manifest.linux_bundle = linuxRoot;
manifest.archive = { path: 'runtime.tar.gz', sha256: await fileHash(join(output, 'runtime.tar.gz')), byte_length: lstatSync(join(output, 'runtime.tar.gz')).size };
writeFileSync(join(output, 'bundle-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ output, source_digest: sourceDigest, packages: packages.size, nested_dependency_links: manifest.nested_dependency_links, archive: manifest.archive, host_email_source_matches: manifest.host_email_source_matches }));
