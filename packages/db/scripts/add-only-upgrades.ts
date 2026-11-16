/** Conservative SQL gate for new upgrades. Unknown executable forms fail closed.
 * Historical files come from the release commit on origin/master, never a mutable allow-list.
 * Routine bodies are stored, not executed; procedural blocks and calls require a different,
 * provably additive spelling. This gate does not prove application-level rollback compatibility,
 * nor data-dependent limits it cannot see: an index on an existing text column can still fail
 * on a value too large for an index entry (about 2.7 kB), which only the upgrade rehearsal on
 * real data shows.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type AddOnlyRule = 'drop' | 'delete' | 'truncate' | 'rename' | 'column-type'
  | 'narrowing' | 'data-rewrite' | 'unsupported';
export type AddOnlyViolation = { rule: AddOnlyRule; statement: string };

type Token =
  | { kind: 'word'; text: string; quoted?: true }
  | { kind: 'string'; value: string }
  | { kind: 'body'; value: string }
  | { kind: 'punct'; text: string };

const DOLLAR = String.fromCharCode(36);
const isWordStart = (ch: string) => /[A-Za-z_]/u.test(ch) || ch.charCodeAt(0) > 127;
const isWordPart = (ch: string) => /[A-Za-z0-9_]/u.test(ch) || ch === DOLLAR || ch.charCodeAt(0) > 127;

/** The opening tag of dollar-quoted text at `index` (`$$` or `$name$`), if any. */
function dollarTag(sql: string, index: number): string | null {
  let end = index + 1;
  if (end < sql.length && /[0-9]/u.test(sql[end]!)) return null; // $1 is a parameter
  while (end < sql.length && sql[end] !== DOLLAR && isWordPart(sql[end]!)) end += 1;
  return sql[end] === DOLLAR ? sql.slice(index, end + 1) : null;
}

/** Splits SQL into tokens. Comments vanish; string literals and dollar-quoted
 * bodies become single tokens, so nothing inside them reads as a keyword. */
export function tokenizeSql(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (/\s/u.test(ch)) { i += 1; continue; }
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth += 1; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth -= 1; i += 2; }
        else i += 1;
      }
      if (depth !== 0) throw new Error('Unterminated block comment');
      continue;
    }
    const escapeString = (ch === 'e' || ch === 'E') && next === "'";
    if (ch === "'" || escapeString) {
      i += escapeString ? 2 : 1;
      let value = '';
      for (;;) {
        if (i >= sql.length) throw new Error('Unterminated string literal');
        const c = sql[i]!;
        if (escapeString && c === '\\') { value += sql[i + 1] ?? ''; i += 2; continue; }
        if (c === "'") {
          if (sql[i + 1] === "'") { value += "'"; i += 2; continue; }
          i += 1;
          break;
        }
        value += c;
        i += 1;
      }
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '"') {
      i += 1;
      let value = '';
      for (;;) {
        if (i >= sql.length) throw new Error('Unterminated quoted identifier');
        const c = sql[i]!;
        if (c === '"') {
          if (sql[i + 1] === '"') { value += '"'; i += 2; continue; }
          i += 1;
          break;
        }
        value += c;
        i += 1;
      }
      // A quoted identifier is a name, never a keyword.
      tokens.push({ kind: 'word', text: value, quoted: true });
      continue;
    }
    if (ch === DOLLAR) {
      const tag = dollarTag(sql, i);
      if (tag) {
        const start = i + tag.length;
        const end = sql.indexOf(tag, start);
        if (end < 0) throw new Error('Unterminated dollar-quoted text');
        tokens.push({ kind: 'body', value: sql.slice(start, end) });
        i = end + tag.length;
        continue;
      }
    }
    if (isWordStart(ch)) {
      let end = i + 1;
      while (end < sql.length && isWordPart(sql[end]!)) end += 1;
      tokens.push({ kind: 'word', text: sql.slice(i, end).toUpperCase() });
      i = end;
      continue;
    }
    if (/[0-9]/u.test(ch)) {
      let end = i + 1;
      while (end < sql.length && /[0-9A-Za-z_.]/u.test(sql[end]!)) end += 1;
      tokens.push({ kind: 'punct', text: sql.slice(i, end) });
      i = end;
      continue;
    }
    tokens.push({ kind: 'punct', text: ch });
    i += 1;
  }
  return tokens;
}

function splitStatements(tokens: Token[]): Token[][] {
  const statements: Token[][] = [];
  let current: Token[] = [];
  for (const token of tokens) {
    if (token.kind === 'punct' && token.text === ';') {
      if (current.length) statements.push(current);
      current = [];
    } else current.push(token);
  }
  if (current.length) statements.push(current);
  return statements;
}

/** With `texts`: an unquoted keyword among them. Without: any name. */
const word = (token: Token | undefined, ...texts: string[]) =>
  token?.kind === 'word' && (texts.length === 0 || (!token.quoted && texts.includes(token.text)));
const punct = (token: Token | undefined, text: string) => token?.kind === 'punct' && token.text === text;

function render(tokens: Token[]): string {
  // A quoted identifier keeps its quotes: "PUBLIC" is not the unquoted name public.
  return tokens.map((token) => token.kind === 'word' ? (token.quoted ? JSON.stringify(token.text) : token.text)
    : token.kind === 'punct' ? token.text
    : token.kind === 'string' ? "'?'" : '<body>').join(' ');
}

/** Preserve schema and quoted-name identity when deciding whether a table is new. */
function readName(tokens: Token[], index: number): { name: string; next: number } | null {
  const parts: string[] = [];
  while (word(tokens[index])) {
    const token = tokens[index] as Extract<Token, { kind: 'word' }>;
    parts.push(token.quoted ? token.text : token.text.toLowerCase());
    index += 1;
    if (!punct(tokens[index], '.')) break;
    index += 1;
  }
  if (!parts.length) return null;
  return { name: JSON.stringify(parts.length === 1 ? ['public', ...parts] : parts), next: index };
}

function skip(tokens: Token[], index: number, ...words: string[]) {
  return words.every((value, offset) => word(tokens[index + offset], value)) ? index + words.length : index;
}

function topLevelParts(tokens: Token[]): Token[][] {
  let depth = 0;
  const result: Token[][] = [[]];
  for (const token of tokens) {
    if (punct(token, '(')) depth += 1;
    if (punct(token, ')')) depth -= 1;
    if (depth === 0 && punct(token, ',')) result.push([]);
    else result[result.length - 1]!.push(token);
  }
  return result;
}

/** An index on an existing table must not be able to throw on rows the previous release wrote:
 * keys are plain columns, and a predicate is only `col IS [NOT] NULL|TRUE|FALSE`, `col <op> literal`
 * or `col [NOT] IN (literals)` joined by AND/OR. Anything else (expressions, casts, function
 * calls, LIKE, arithmetic) fails closed. */
function plainIndex(tokens: Token[]): boolean {
  let i = 0;
  if (word(tokens[i], 'USING')) i += 2;
  const list = (start: number, parameters: boolean) => { // "(" names ")" -> index after it, or -1
    if (!punct(tokens[start], '(')) return -1;
    for (let at = start + 1; at < tokens.length; at += 1) {
      const token = tokens[at]!;
      if (punct(token, ')')) return at + 1;
      const ok = word(token) || punct(token, ',')
        || (parameters && (token.kind === 'string' || (token.kind === 'punct' && /^(?:=|[0-9.]+)$/u.test(token.text))));
      if (!ok) return -1;
    }
    return -1;
  };
  i = list(i, false);
  if (i < 0) return false;
  if (word(tokens[i], 'INCLUDE') && (i = list(i + 1, false)) < 0) return false;
  if (word(tokens[i], 'WITH') && (i = list(i + 1, true)) < 0) return false;
  return i >= tokens.length || (word(tokens[i], 'WHERE') && safePredicate(tokens.slice(i + 1)));
}

function safePredicate(all: Token[]): boolean {
  // A name directly followed by "(" is a function call, even with no arguments.
  if (all.some((token, i) => punct(token, '(') && word(all[i - 1]) && !word(all[i - 1], 'IN', 'AND', 'OR', 'NOT', 'IS'))) return false;
  const t = all.filter((token) => !punct(token, '(') && !punct(token, ')')); // grouping only
  const literal = (at: number) => {
    if (punct(t[at], '-')) at += 1;
    const value = t[at];
    return value?.kind === 'string' || word(value, 'TRUE', 'FALSE', 'NULL')
      || (value?.kind === 'punct' && /^[0-9]+(?:\.[0-9]+)?$/u.test(value.text)) ? at + 1 : -1;
  };
  let i = 0;
  for (;;) {
    if (!word(t[i]) || word(t[i], 'NOT', 'IS', 'AND', 'OR', 'IN', 'NULL', 'TRUE', 'FALSE')) return false;
    i += 1;
    if (word(t[i], 'IS')) {
      i += word(t[i + 1], 'NOT') ? 2 : 1;
      if (!word(t[i], 'NULL', 'TRUE', 'FALSE')) return false;
      i += 1;
    } else if (word(t[i], 'IN') || (word(t[i], 'NOT') && word(t[i + 1], 'IN'))) {
      i += word(t[i], 'NOT') ? 2 : 1;
      for (;;) {
        i = literal(i);
        if (i < 0) return false;
        if (!punct(t[i], ',')) break;
        i += 1;
      }
    } else {
      let operator = '';
      while (t[i]?.kind === 'punct' && '=<>!'.includes((t[i] as { text: string }).text)) { operator += (t[i] as { text: string }).text; i += 1; }
      if (!['=', '<>', '!=', '<', '>', '<=', '>='].includes(operator) || (i = literal(i)) < 0) return false;
    }
    if (i === t.length) return true;
    if (!word(t[i], 'AND', 'OR')) return false;
    i += 1;
  }
}

/** `DEFAULT` followed by one literal (string, signed number, TRUE/FALSE, or NULL when
 * the column may be null), optional `::type` casts, and nothing but a closing NOT NULL. */
function literalDefault(tokens: Token[], index: number, required: boolean) {
  if (punct(tokens[index], '-') || punct(tokens[index], '+')) index += 1;
  const value = tokens[index];
  const literal = value?.kind === 'string' || word(value, 'TRUE', 'FALSE') || (!required && word(value, 'NULL'))
    || (value?.kind === 'punct' && /^[0-9]+(?:\.[0-9]+)?$/u.test(value.text));
  if (!literal) return false;
  index += 1;
  while (punct(tokens[index], ':') && punct(tokens[index + 1], ':') && word(tokens[index + 2])) index += 3;
  return index === tokens.length || (word(tokens[index], 'NOT') && word(tokens[index + 1], 'NULL') && index + 2 === tokens.length);
}

function has(tokens: Token[], ...words: string[]) {
  return tokens.some((_, index) => words.every((value, offset) => word(tokens[index + offset], value)));
}

export function findAddOnlyViolations(sql: string): AddOnlyViolation[] {
  const created = new Set<string>();
  const violations: AddOnlyViolation[] = [];
  for (const tokens of splitStatements(tokenizeSql(sql))) {
    const rules = new Set<AddOnlyRule>();
    const report = (rule: AddOnlyRule) => rules.add(rule);
    const routine = word(tokens[0], 'CREATE') && word(tokens[1], 'FUNCTION', 'PROCEDURE');
    // String/dollar-quoted bodies are single tokens, so stored function code and comments
    // cannot masquerade as upgrade statements. DO/EXECUTE/CALL are refused below.
    if (tokens.some((token) => word(token, 'DROP'))) report('drop');
    if (has(tokens, 'DELETE', 'FROM')) report('delete');
    if (word(tokens[0], 'TRUNCATE')) report('truncate');
    if (word(tokens[0], 'ALTER') && tokens.some((token) => word(token, 'RENAME'))) report('rename');
    if (word(tokens[0], 'UPDATE', 'MERGE', 'DELETE')) report('data-rewrite');
    if (word(tokens[0], 'ALTER') && tokens.some((token, i) => word(token, 'ALTER')
      && (() => {
        const column = readName(tokens, word(tokens[i + 1], 'COLUMN', 'ATTRIBUTE') ? i + 2 : i + 1);
        return column && (word(tokens[column.next], 'TYPE') || has(tokens.slice(column.next, column.next + 3), 'SET', 'DATA', 'TYPE'));
      })())) report('column-type');

    if (word(tokens[0], 'CREATE')) {
      const kind = tokens[1];
      if (word(kind, 'TABLE')) {
        // IF NOT EXISTS is safe to create, but does not prove a table is new.
        if (!word(tokens[2], 'IF')) {
          const table = readName(tokens, 2);
          if (table) created.add(table.name);
        }
        if (tokens.some((token) => word(token, 'AS', 'INHERITS', 'PARTITION'))) report('unsupported');
      } else if (word(kind, 'INDEX', 'UNIQUE')) {
        const on = tokens.findIndex((token) => word(token, 'ON'));
        const table = readName(tokens, skip(tokens, on + 1, 'ONLY'));
        if (!table || (word(kind, 'UNIQUE') && !created.has(table.name))) report('narrowing');
        else if (!created.has(table.name) && !plainIndex(tokens.slice(table.next))) report('narrowing');
      } else if (word(kind, 'TRIGGER', 'CONSTRAINT')) {
        const on = tokens.findIndex((token) => word(token, 'ON'));
        const table = readName(tokens, on + 1);
        if (!table || !created.has(table.name)) report('narrowing');
      } else if (word(kind, 'SCHEMA')) {
        // Elements after the name (CREATE TABLE/INDEX, GRANT, ...) run too: only the bare form is allowed.
        const name = readName(tokens, skip(tokens, 2, 'IF', 'NOT', 'EXISTS'));
        if (!name || name.next !== tokens.length) report('unsupported');
      } else if (!routine && !word(kind, 'TYPE', 'SEQUENCE', 'VIEW')) {
        // In particular CREATE OR REPLACE can change an existing contract.
        report('unsupported');
      }
    } else if (word(tokens[0], 'ALTER') && word(tokens[1], 'TABLE')) {
      const table = readName(tokens, skip(tokens, skip(tokens, 2, 'IF', 'EXISTS'), 'ONLY'));
      if (!table) report('unsupported');
      else for (const action of topLevelParts(tokens.slice(table.next))) {
        if (!word(action[0], 'ADD')) { report('unsupported'); continue; }
        const at = skip(action, skip(action, 1, 'COLUMN'), 'IF', 'NOT', 'EXISTS');
        const constraint = word(action[at], 'CONSTRAINT', 'CHECK', 'UNIQUE', 'PRIMARY', 'FOREIGN', 'EXCLUDE');
        if (created.has(table.name)) continue;
        if (constraint || action.some((token) => word(token, 'CHECK', 'REFERENCES', 'UNIQUE', 'PRIMARY', 'EXCLUDE', 'GENERATED')))
          report('narrowing');
        // A default on an existing table must be a plain literal: any other expression
        // runs code during the upgrade, and a required column needs a non-null one.
        const required = has(action, 'NOT', 'NULL');
        const def = action.findIndex((token) => word(token, 'DEFAULT'));
        if (def < 0 ? required : !literalDefault(action, def + 1, required)) report('narrowing');
      }
    } else if (word(tokens[0], 'ALTER') && word(tokens[1], 'FUNCTION')) {
      // The restore fix changes name resolution only; no signature or body changes.
      // The search_path setting must be the only action after the argument list.
      const open = tokens.findIndex((token) => punct(token, '('));
      let depth = 0;
      let close = -1;
      for (let i = open; open >= 0 && i < tokens.length && close < 0; i += 1) {
        if (punct(tokens[i], '(')) depth += 1;
        if (punct(tokens[i], ')') && (depth -= 1) === 0) close = i;
      }
      if (close < 0 || readName(tokens, 2)?.next !== open
        || render(tokens.slice(close + 1)) !== 'SET SEARCH_PATH = PG_CATALOG , PUBLIC , PG_TEMP') report('unsupported');
    } else if (word(tokens[0], 'ALTER') && word(tokens[1], 'TYPE') && has(tokens, 'ADD', 'VALUE')) {
      // Extending an enum preserves every old label and its type.
    } else if (!word(tokens[0], 'BEGIN', 'COMMIT') && !has(tokens.slice(0, 2), 'COMMENT', 'ON')) {
      report('unsupported');
    }
    for (const rule of rules) violations.push({ rule, statement: render(tokens) });
  }
  return violations;
}

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
function gitAt(directory: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}
const upgradePath = (file: string) => file.startsWith('packages/db/upgrades/') && file.endsWith('.sql');

/** Files present at the release are immutable history; only added files are scanned.
 * Also refuse removal/edits of history so a rename cannot conceal a destructive upgrade.
 */
export function checkAddedUpgradeFiles(input: {
  baselineFiles: readonly string[]; currentFiles: readonly string[];
  baselineRead: (file: string) => string; read: (file: string) => string;
}) {
  const history = new Set(input.baselineFiles);
  const current = new Set(input.currentFiles);
  const violations: Array<AddOnlyViolation & { file: string }> = [];
  for (const file of history) {
    // Byte-exact: upgrade.ts checksums the physical bytes (.gitattributes: -text).
    if (!current.has(file) || input.baselineRead(file) !== input.read(file))
      violations.push({ file, rule: 'unsupported', statement: 'Released upgrade removed or modified' });
  }
  const checkedFiles = input.currentFiles.filter((file) => !history.has(file));
  for (const file of checkedFiles) for (const violation of findAddOnlyViolations(input.read(file)))
    violations.push({ file, ...violation });
  return { checkedFiles, violations };
}

/** origin/master's versioned release tag is authoritative, even before the next
 * release (when master may already contain other lanes' unreleased upgrades).
 */
export function checkRepositoryUpgrades(baseRef = 'origin/master', headRef?: string, directory = repository) {
  const git = (...args: string[]) => gitAt(directory, ...args);
  const pkg = JSON.parse(git('show', `${baseRef}:package.json`)) as { version?: string };
  if (!pkg.version || !/^[0-9A-Za-z.-]+$/u.test(pkg.version)) throw new Error('Master has no release version');
  const tagged = (tag: string) => git('rev-parse', '--verify', `refs/tags/${tag}^{commit}`).trim();
  let baseline: string;
  try { baseline = tagged(`v${pkg.version}`); } catch {
    // A release bump has merged but its tag is not pushed yet: judge against the latest
    // released tag on master, never against untagged master itself.
    baseline = tagged(git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', baseRef).trim());
  }
  git('merge-base', '--is-ancestor', baseline, baseRef);
  // NUL-delimited: without -z Git quotes a non-ASCII name and the file would be skipped.
  const names = (output: string) => output.split('\0').filter(upgradePath);
  const baselineFiles = names(git('ls-tree', '-r', '-z', '--name-only', baseline, '--', 'packages/db/upgrades'));
  const currentFiles = names(headRef
    ? git('ls-tree', '-r', '-z', '--name-only', headRef, '--', 'packages/db/upgrades')
    : git('ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'packages/db/upgrades'));
  const report = checkAddedUpgradeFiles({ baselineFiles, currentFiles,
    baselineRead: (file) => git('show', `${baseline}:${file}`),
    read: (file) => headRef ? git('show', `${headRef}:${file}`) : readFileSync(resolve(directory, file), 'utf8'),
  });
  return { baseline, ...report };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = checkRepositoryUpgrades(process.argv[2], process.argv[3]);
    console.log(`Add-only upgrades since release ${report.baseline}: ${report.checkedFiles.length} file(s)`);
    for (const file of report.checkedFiles) console.log(`  ${file}`);
    for (const violation of report.violations) console.error(`${violation.file}: ${violation.rule}: ${violation.statement}`);
    process.exitCode = report.violations.length ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
