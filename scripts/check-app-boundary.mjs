import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const slash = (value) => value.split(path.sep).join('/');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const codeFile = /\.(?:[cm]?[jt]sx?)$/i;
const textFile = /\.(?:[cm]?[jt]sx?|sql|json|ya?ml|sh|ps1)$/i;
const ignored = new Set(['node_modules', '.git', '.next', 'coverage', 'dist', 'build']);
const rules = [
  ['mailbox', /mailbox[a-z0-9_-]*/gi],
  ['mail-protocol', /\b(?:imap|smtp)[a-z0-9_-]*\b/gi],
  ['mail-storage', /\bemail_(?:accounts|messages|invitation|knowledge_auto)[a-z0-9_]*\b|\bemail(?:Accounts|Messages|Invitation|KnowledgeAuto)[a-zA-Z0-9_]*\b/gi],
  ['mail-route', /\/api\/emails?\b/gi],
  ['sandbox-send', /\bSandboxEmailSend[a-z0-9_]*\b/gi],
  ['mail-provider', /\b(?:gmail|outlook|google-mail|microsoft-graph-mail|sandbox-email|email-provider)[a-z0-9_-]*\b/gi],
  ['mail-compose', /\b(?:native-compose|safe-compose|mailbox-list)[a-z0-9_-]*\b/gi],
];

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) throw new Error(`Symlink requires boundary review: ${path.join(dir, entry.name)}`);
    if (entry.isDirectory()) return ignored.has(entry.name) ? [] : walk(path.join(dir, entry.name));
    return [path.join(dir, entry.name)];
  });
}

// Email prefixes and legacy NativeEmail forms; contact/auth fields are not path rules.
function emailSegments(value) {
  return value.replaceAll('\\', '/').split('/').filter((part) =>
    /^(?:native[-_]?)?emails?/i.test(part));
}

function exportTargets(value) {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(exportTargets);
  return [];
}

function sourceTarget(file) {
  return file.replace(`${path.sep}dist${path.sep}`, `${path.sep}src${path.sep}`)
    .replace(/\.d\.([cm]?)ts$/, '.$1ts').replace(/\.([cm]?)js$/, '.$1ts');
}

/** Full-tree findings. Does not read or write the exception file and uses no network. */
export function scanBoundary(root, { requireBuilt = false } = {}) {
  root = path.resolve(root);
  const files = walk(root);
  const packages = new Map();
  // Match the repository's apps/* and packages/* workspaces. Consumer fixture
  // manifests can repeat package names and must never shadow a core package.
  for (const file of files.filter((file) => /^(?:apps|packages)\/[^/]+\/package\.json$/.test(slash(path.relative(root, file))))) {
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (pkg.name) {
      if (packages.has(pkg.name)) throw new Error(`Duplicate workspace package name requires review: ${pkg.name}`);
      packages.set(pkg.name, { dir: path.dirname(file), ...pkg });
    }
  }
  const kit = packages.get('@deft/app-kit');
  if (requireBuilt && !kit) throw new Error('Missing core Kit package manifest');
  const sourceFiles = files.filter((file) => /^(?:apps\/(?:api|web)\/src\/|packages\/(?:shared\/src|db\/(?:src|drizzle|upgrades))\/)/.test(slash(path.relative(root, file))));
  const queue = sourceFiles.filter((file) => textFile.test(file));
  if (kit) {
    // Optional examples are separate entry points, never implicit core roots.
    const targets = Object.entries(kit.exports ?? {}).filter(([key]) => !/^\.\/(?:examples|email)(?:\/|$)/i.test(key))
      .flatMap(([, value]) => exportTargets(value));
    targets.push(...exportTargets(kit.bin));
    for (const target of targets) {
      if (target.includes('*')) throw new Error(`Unreviewed wildcard Kit export: ${target}`);
      const built = path.resolve(kit.dir, target);
      const source = candidate(sourceTarget(built));
      if (source) queue.push(source);
      if (fs.existsSync(built)) queue.push(built);
      else if (requireBuilt) throw new Error(`Missing generated Kit entry point: ${target}; build Kit first`);
    }
    for (const name of ['runtime-authoring.ts', 'experience-capabilities.ts']) {
      const file = path.join(kit.dir, 'src', name);
      if (fs.existsSync(file)) queue.push(file);
    }
  }
  const findings = new Map();
  function add(file, rule, token, context, line) {
    const finding = { path: slash(path.relative(root, file)), rule, token, digest: hash(context), occurrences: 1, line, context };
    const key = [finding.path, rule, token, finding.digest].join('\0');
    if (findings.has(key)) findings.get(key).occurrences++;
    else findings.set(key, finding);
  }
  function scanPath(file) {
    const relative = slash(path.relative(root, file));
    for (const token of emailSegments(relative)) add(file, 'email-path', token, relative, 1);
    for (const [rule, pattern] of rules) {
      for (const match of relative.matchAll(pattern)) add(file, `${rule}-path`, match[0], relative, 1);
    }
  }
  for (const file of sourceFiles.filter((file) => !textFile.test(file))) {
    scanPath(file);
  }
  const configCache = new Map();
  const resolutionCache = ts.createModuleResolutionCache(root, (name) => ts.sys.useCaseSensitiveFileNames ? name : name.toLowerCase());
  function resolve(specifier, from) {
    const pkgName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
    const pkg = packages.get(pkgName);
    if (pkg) {
      const subpath = specifier.slice(pkgName.length);
      const entry = pkg.exports?.[subpath ? `.${subpath}` : '.'];
      const targets = exportTargets(entry ?? (subpath ? `.${subpath}` : (pkg.source ?? pkg.main ?? './src/index.ts')));
      const found = new Set();
      for (const target of targets) {
        const base = path.resolve(pkg.dir, target);
        // Follow source alongside built declarations; nothing in node_modules is scanned.
        const source = sourceTarget(base);
        for (const file of [candidate(source), candidate(base)]) if (file) found.add(file);
      }
      if (found.size) return [...found];
    }
    const dir = path.dirname(from);
    const config = ts.findConfigFile(dir, fs.existsSync);
    if (!configCache.has(config)) {
      const read = config && ts.readConfigFile(config, ts.sys.readFile);
      const options = read && !read.error ? ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(config)).options : {};
      configCache.set(config, { moduleResolution: ts.ModuleResolutionKind.Bundler, ...options });
    }
    const resolved = ts.resolveModuleName(specifier, from, configCache.get(config), ts.sys, resolutionCache).resolvedModule?.resolvedFileName;
    const found = new Set();
    if (resolved && !slash(resolved).includes('/node_modules/')) found.add(resolved);
    if (specifier.startsWith('.')) {
      const runtime = candidate(path.resolve(dir, specifier));
      if (runtime) found.add(runtime);
    }
    return [...found];
  }
  function candidate(base) {
    const stem = base.replace(/\.(?:[cm]?[jt]sx?)$/, '');
    return [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`, `${base}.js`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`]
      .find((file) => fs.existsSync(file) && fs.statSync(file).isFile());
  }
  const visited = new Set();
  function imports(file, content, traverse) {
    const tree = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
    function visit(node) {
      let specifier;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) specifier = node.moduleSpecifier;
      else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) specifier = node.moduleReference.expression;
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal;
      else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        specifier = node.arguments[0];
        if (!specifier || !ts.isStringLiteralLike(specifier)) {
          let scope = node.parent;
          while (scope.parent && !ts.isFunctionLike(scope)) scope = scope.parent;
          // Pin the enclosing loader too, so removing its hash/authority checks
          // invalidates the exception even if the import expression is unchanged.
          add(file, 'computed-import', node.getText(tree), scope.getText(tree), tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1);
          specifier = undefined;
        }
      }
      if (specifier && ts.isStringLiteralLike(specifier)) {
        const token = specifier.text;
        const line = tree.getLineAndCharacterOfPosition(specifier.getStart(tree)).line + 1;
        const context = node.getText(tree);
        if (emailSegments(token).length || /(?:^|\/)examples\/email(?:\/|$)/i.test(token)) add(file, 'email-import', token, context, line);
        const targets = resolve(token, file);
        // Deprecated public facades are temporary author-tool compatibility.
        // Their allowlisted graph must never authorize a new Host/core import.
        const facade = (value) => /^packages\/app-kit\/(?:src|dist)\/(?:index|experience-sdk|compatibility|example-compatibility)(?:\.d)?\.[cm]?[jt]sx?$/.test(value);
        if (traverse && !facade(slash(path.relative(root, file))) && (
          token === '@deft/app-kit' || token === '@deft/app-kit/experience' ||
          targets.some((target) => facade(slash(path.relative(root, target))))
        )) add(file, 'compatibility-facade-import', token, context, line);

        for (const resolved of targets) {
          if (traverse) {
            const relative = slash(path.relative(root, resolved));
            if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('../')) queue.push(resolved);
            else add(file, 'outside-tree-import', token, context, line);
          }
          // Reference-only scopes follow Host/core imports, not arbitrary example apps.
          if (!traverse && /^(?:apps\/(?:api|web)\/src\/|packages\/(?:app-kit|shared|db)\/)/.test(slash(path.relative(root, resolved)))) queue.push(resolved);
        }
        if (!targets.length && (token.startsWith('.') || token.startsWith('@/') || packages.has(token.split('/').slice(0, 2).join('/')))) {
          if (!/\.(?:css|scss|svg|png|jpg|woff2?|json)$/.test(token)) add(file, 'unresolved-local-import', token, context, line);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
  // Auxiliary code is checked for Host import references, not domain fixture prose.
  for (const file of files.filter((file) => {
    const relative = slash(path.relative(root, file));
    // The declarative exception input is not an executable Host reference. If
    // core imports it, traversal below still scans it like any other dependency.
    return relative !== 'scripts/app-boundary-allowlist.json' && /^(?:scripts\/|tests?\/|apps\/(?:api|web)\/test\/|packages\/[^/]+\/test\/|\.github\/workflows\/)/.test(relative) && textFile.test(file);
  })) {
    const content = fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
    if (codeFile.test(file)) imports(file, content, false);
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const match of line.matchAll(/(?:apps\/(?:api|web)\/src|packages\/(?:app-kit|shared)\/(?:src|dist))\/[\w./-]+/g)) {
        if (emailSegments(match[0]).length) add(file, 'host-import-reference', match[0], line.trim(), index + 1);
      }
    });
  }
  while (queue.length) {
    const file = path.resolve(queue.shift());
    if (visited.has(file)) continue;
    visited.add(file);
    scanPath(file);
    const content = fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      // Address values are ordinary contact/auth data, even when their local
      // part/domain contains a protocol, provider or mailbox word. Mask only
      // the address span; other tokens on the same line still require review.
      const ruleText = line.replace(/[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, (address) => ' '.repeat(address.length));
      for (const [rule, pattern] of rules) {
        for (const match of ruleText.matchAll(pattern)) add(file, rule, match[0], line.trim(), index + 1);
      }
    }
    if (codeFile.test(file)) imports(file, content, true);
  }
  return [...findings.values()].sort((a, b) => a.path.localeCompare(b.path, 'en') || a.line - b.line || a.rule.localeCompare(b.rule, 'en') || a.token.localeCompare(b.token, 'en'));
}

const identity = (entry) => JSON.stringify([entry.path, entry.rule, entry.token, entry.digest]);
export function validateAllowlist(findings, entries) {
  const errors = [];
  const current = new Map(findings.map((entry) => [identity(entry), entry]));
  const seen = new Set();
  const fields = ['path', 'rule', 'token', 'digest', 'occurrences', 'reason', 'owner', 'issue', 'milestone'];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some((key) => !fields.includes(key)) || fields.some((key) => !Object.hasOwn(entry, key)) ||
        fields.filter((key) => key !== 'occurrences').some((key) => typeof entry[key] !== 'string' || !entry[key].trim()) ||
        !Number.isSafeInteger(entry.occurrences) || entry.occurrences < 1 || !/^[a-f0-9]{64}$/.test(entry.digest) ||
        /[*?\\]/.test(entry.path) || path.posix.isAbsolute(entry.path) || entry.path.split('/').some((part) => !part || part === '.' || part === '..') ||
        !/^https:\/\/github\.com\/Maneek21\/Deft\/issues\/\d+$/.test(entry.issue)) {
      errors.push(`Invalid or broadened exception: ${JSON.stringify(entry)}`);
      continue;
    }
    const key = identity(entry);
    if (seen.has(key)) errors.push(`Duplicate exception: ${entry.path} [${entry.rule}] ${entry.token}`);
    seen.add(key);
    const finding = current.get(key);
    if (!finding) errors.push(`Stale or changed exception: ${entry.path} [${entry.rule}] ${entry.token} (${entry.digest})`);
    else if (finding.occurrences !== entry.occurrences) errors.push(`Changed occurrence count: ${entry.path}:${finding.line} [${entry.rule}] ${entry.token}`);
  }
  for (const finding of findings) {
    if (!seen.has(identity(finding))) errors.push(`Unapproved: ${finding.path}:${finding.line} [${finding.rule}] ${finding.token} (${finding.digest})`);
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
    const findings = scanBoundary(root, { requireBuilt: true });
    if (process.argv.includes('--findings')) console.log(JSON.stringify(findings, null, 2));
    else {
      const entries = JSON.parse(fs.readFileSync(path.join(root, 'scripts/app-boundary-allowlist.json'), 'utf8'));
      const errors = validateAllowlist(findings, entries);
      for (const error of errors) console.error(error);
      if (process.argv.includes('--verbose')) for (const finding of findings) {
        const exception = entries.find((entry) => identity(entry) === identity(finding));
        console.log(`${finding.path}:${finding.line} [${finding.rule}] ${finding.token}: ${exception?.reason ?? 'UNAPPROVED'}`);
      }
      console.log(`App boundary: ${findings.length} exact findings, ${entries.length} exceptions, ${errors.length} errors.`);
      if (errors.length) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
