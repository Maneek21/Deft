// One-shot retirement evidence, not the proposed product-boundary CI gate.
// pnpm exec node scripts/audit-email-reachability.mjs <git revision> > audit.json
import {execFileSync, spawnSync} from 'node:child_process';
import path from 'node:path';
import ts from 'typescript';

const revision = process.argv[2];
if (!revision || !/^[a-f0-9]{40}$/u.test(revision)) throw Error('Pass a full audited commit SHA');
const git = args => execFileSync('git', args, {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
const files = git(['ls-tree', '-r', '--name-only', revision]).trim().split('\n');
const batch = spawnSync('git', ['cat-file', '--batch'], {
  input: files.map(file => `${revision}:${file}\n`).join(''),
  maxBuffer: 128 * 1024 * 1024,
});
if (batch.status !== 0) throw Error(batch.stderr.toString());
let offset = 0;
const contents = new Map(files.map(file => {
  const end = batch.stdout.indexOf(10, offset);
  const header = batch.stdout.subarray(offset, end).toString().split(' ');
  if (header[1] !== 'blob') throw Error(`Expected blob: ${file}`);
  const start = end + 1, size = Number(header[2]);
  offset = start + size + 1;
  return [file, batch.stdout.subarray(start, start + size).toString('utf8')];
}));
function resolve(from, specifier) {
  let candidate;
  if (specifier.startsWith('.')) candidate = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  else if (specifier.startsWith('@/') && from.startsWith('apps/web/')) candidate = `apps/web/src/${specifier.slice(2)}`;
  else if (specifier.startsWith('@deft/')) {
    const [name, ...rest] = specifier.slice(6).split('/');
    candidate = `packages/${name}/src/${rest.join('/') || 'index'}`;
    // Public subpath points at the experience SDK, not a same-named file.
    if (specifier === '@deft/app-kit/experience') candidate = 'packages/app-kit/src/experience-sdk';
  } else return;
  return [candidate, candidate.replace(/\.js$/u, '.ts'), candidate.replace(/\.js$/u, '.tsx'),
    `${candidate}.ts`, `${candidate}.tsx`, `${candidate}.js`, `${candidate}/index.ts`,
    `${candidate}/index.tsx`].find(file => contents.has(file));
}
const edges = new Map(), computedImports = [];
for (const [file, text] of contents) {
  if (!/\.[cm]?[jt]sx?$/u.test(file)) continue;
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const targets = new Set();
  function visit(node) {
    // Conservatively includes type-only imports, re-exports, require, literal
    // dynamic import, module mocks and new URL('relative/file', import.meta.url).
    // Treating every resolvable string as an edge overcounts, never prunes one.
    if (ts.isStringLiteralLike(node)) {
      const target = resolve(file, node.text);
      if (target) targets.add(target);
    }
    if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(ast) === 'require')
      && !ts.isStringLiteralLike(node.arguments[0] ?? node)) {
      computedImports.push({file, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
        expression: node.getText(ast)});
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  edges.set(file, targets);
}
const roots = ['apps/api/src/server.ts', 'apps/api/src/index.ts', 'apps/api/src/workers/index.ts'];
const reached = new Map();
function visit(file, parent = null) {
  if (reached.has(file)) return;
  reached.set(file, parent);
  for (const target of edges.get(file) ?? []) visit(target, file);
}
roots.forEach(file => visit(file));
const candidates = files.filter(file => file.startsWith('apps/api/src/') && /email[^/]*\.ts$/iu.test(file));
const unreachable = candidates.filter(file => !reached.has(file));
const evidence = unreachable.map(file => {
  const stem = path.posix.basename(file, '.ts');
  return {
    file,
    lines: contents.get(file).split('\n').length - 1,
    importers: [...edges].filter(([, targets]) => targets.has(file)).map(([from]) => from),
    // Exact stem boundaries avoid confusing email-knowledge with its retained
    // email-knowledge-visibility sibling; SQL schema filenames still need review.
    references: [...contents].filter(([from, text]) => from !== file
      && new RegExp(`(?<![\\w-])${stem}(?![\\w-])`, 'u').test(text)).map(([from]) => from),
  };
});
console.log(JSON.stringify({
  revision, roots, candidate_count: candidates.length,
  unreachable_count: unreachable.length, reachable_count: candidates.length - unreachable.length,
  reachable: candidates.filter(file => reached.has(file)).map(file => {
    const chain = [file];
    for (let parent = reached.get(file); parent; parent = reached.get(parent)) chain.unshift(parent);
    return {file, chain};
  }),
  computed_imports: computedImports,
  unreachable: evidence,
}, null, 2));
