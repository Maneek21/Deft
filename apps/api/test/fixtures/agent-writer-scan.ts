/**
 * Finds every statement in apps/api/src that writes an agent's credentials or
 * state: the agent_employees, agent_webhooks and agent_channel_tokens tables,
 * and the mcp_tokens and api_keys tables (which hold agent-bound keys).
 * Used by test/protected-agent-writers.test.ts; also runnable on its own:
 *   node --import tsx test/fixtures/agent-writer-scan.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const WATCHED_TABLES: Record<string, string> = {
  agentEmployees: 'agent_employees',
  agentWebhooks: 'agent_webhooks',
  agentChannelTokens: 'agent_channel_tokens',
  mcpTokens: 'mcp_tokens',
  apiKeys: 'api_keys',
  // What else can wake an agent or extend its authority.
  agentEmployeeSkills: 'agent_employee_skills',
  agentChannelEvents: 'agent_channel_events',
  agentCertificationChallenges: 'agent_certification_challenges',
};
const SQL_TABLES = Object.values(WATCHED_TABLES);
const SQL_WRITE = new RegExp(`\\b(update|insert\\s+into|delete\\s+from)\\s+"?(${SQL_TABLES.join('|')})"?\\b`, 'i');
/** The SQL text just before an interpolated table (sql`UPDATE ${agentEmployees} ...`). */
const SQL_WRITE_BEFORE_TABLE = /\b(update|insert\s+into|delete\s+from)\s*"?$/i;

export type AgentWriter = {
  /** apps/api/src-relative path, forward slashes. */
  file: string;
  line: number;
  table: string;
  op: 'update' | 'insert' | 'delete' | 'issue';
  /** The enclosing route ("POST /:id/pause"), MCP tool name, or function. */
  site: string;
  /** Inside the `work` callback of manageAgent / manageAgentIfBound (lib/agent-management.ts). */
  inChokePoint: boolean;
  /**
   * That callback mentions the global `db`, or this is a credential issuer
   * called there without `executor` (both take a second pooled connection).
   */
  dbInsideWork: boolean;
};

/** The choke point's entry points; a write counts as managed only inside their callback. */
export const CHOKE_POINTS = new Set(['manageAgent', 'manageAgents', 'manageAgentIfBound']);
/** Helpers that issue an agent credential; a call to one is reported like a write. */
export const CREDENTIAL_ISSUERS: Record<string, string> = {
  issueMcpToken: 'mcp_tokens',
  issueScopedEmployeeMcpToken: 'mcp_tokens',
  issueAgentChannelToken: 'agent_channel_tokens',
};

/**
 * Local names for the watched tables and issuers in one file, following
 * import renames (`import { agentEmployees as ae }`). A namespace import's
 * property (`schema.agentEmployees`) is matched by property name.
 */
function localNames(source: ts.SourceFile): { tables: Map<string, string>; issuers: Map<string, string> } {
  const tables = new Map(Object.entries(WATCHED_TABLES));
  const issuers = new Map(Object.entries(CREDENTIAL_ISSUERS));
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      const imported = (el.propertyName ?? el.name).text;
      if (WATCHED_TABLES[imported]) tables.set(el.name.text, WATCHED_TABLES[imported]!);
      if (CREDENTIAL_ISSUERS[imported]) issuers.set(el.name.text, CREDENTIAL_ISSUERS[imported]!);
    }
  }
  return { tables, issuers };
}

/** The watched table an expression names (`agentEmployees`, an alias, or `schema.agentEmployees`). */
function tableOf(expr: ts.Expression, tables: Map<string, string>): string | null {
  if (ts.isIdentifier(expr)) return tables.get(expr.text) ?? null;
  if (ts.isPropertyAccessExpression(expr)) return WATCHED_TABLES[expr.name.text] ?? null;
  return null;
}

/** A credential issuer called inside the choke point must be handed the transaction. */
function passesExecutor(call: ts.CallExpression): boolean {
  let arg = call.arguments[0];
  while (arg && (ts.isAsExpression(arg) || ts.isParenthesizedExpression(arg) || ts.isSatisfiesExpression(arg))) arg = arg.expression;
  return Boolean(arg && ts.isObjectLiteralExpression(arg) && arg.properties.some((p) =>
    (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && ts.isIdentifier(p.name) && p.name.text === 'executor'));
}

function calleeName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

/** The choke-point callback around a node, if any. */
function chokePointWork(node: ts.Node): ts.Node | null {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if ((ts.isArrowFunction(at) || ts.isFunctionExpression(at)) && ts.isCallExpression(at.parent)) {
      const call = at.parent;
      const name = calleeName(call);
      if (name && CHOKE_POINTS.has(name) && call.arguments[call.arguments.length - 1] === at) return at;
    }
  }
  return null;
}

function mentionsDb(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isIdentifier(n) && n.text === 'db' && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) { found = true; return; }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function walk(dir: string, out: string[]) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
}

const HTTP = new Set(['get', 'post', 'put', 'patch', 'delete', 'all']);

/** The innermost route, MCP tool or named function around a node. */
function siteOf(node: ts.Node, source: ts.SourceFile): string {
  let fn: string | null = null;
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (ts.isCallExpression(at) && ts.isPropertyAccessExpression(at.expression)
      && HTTP.has(at.expression.name.text) && at.arguments[0] && ts.isStringLiteralLike(at.arguments[0])
      && ts.isIdentifier(at.expression.expression) && /Routes?$|app$/i.test(at.expression.expression.text)) {
      return `${at.expression.name.text.toUpperCase()} ${at.arguments[0].text}`;
    }
    if (ts.isObjectLiteralExpression(at)) {
      const name = at.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'name');
      if (name && ts.isStringLiteralLike(name.initializer) && at.properties.some((p) => (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && ts.isIdentifier(p.name!) && ['handler', 'execute', 'run', 'call', 'inputSchema'].includes((p.name as ts.Identifier).text))) {
        return `tool ${name.initializer.text}`;
      }
    }
    if (fn === null) {
      if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name && ts.isIdentifier(at.name)) fn = `function ${at.name.text}`;
      else if ((ts.isArrowFunction(at) || ts.isFunctionExpression(at)) && ts.isVariableDeclaration(at.parent) && ts.isIdentifier(at.parent.name)) fn = `function ${at.parent.name.text}`;
      else if ((ts.isArrowFunction(at) || ts.isFunctionExpression(at)) && ts.isPropertyAssignment(at.parent) && ts.isIdentifier(at.parent.name)) fn = `function ${at.parent.name.text}`;
    }
  }
  return fn ?? `module ${path.basename(source.fileName)}`;
}

export function scanAgentWriters(srcRoot: string): AgentWriter[] {
  const files: string[] = [];
  walk(srcRoot, files);
  const found: AgentWriter[] = [];
  for (const file of files) {
    const rel = path.relative(srcRoot, file).split(path.sep).join('/');
    if (rel.startsWith('scripts/')) continue; // operator scripts with database access
    const text = fs.readFileSync(file, 'utf8');
    // Every file is parsed: a writer may name a table through an alias or a
    // namespace, or only call an issuer.
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const { tables, issuers } = localNames(source);
    const opOf = (word: string): AgentWriter['op'] => (word.toLowerCase().startsWith('update') ? 'update' : word.toLowerCase().startsWith('insert') ? 'insert' : 'delete');
    const visit = (node: ts.Node) => {
      const record = (table: string, op: AgentWriter['op'], issuerWithoutExecutor = false) => {
        const work = chokePointWork(node);
        found.push({
          file: rel,
          line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          table, op, site: siteOf(node, source),
          inChokePoint: Boolean(work),
          dbInsideWork: work ? mentionsDb(work) || issuerWithoutExecutor : false,
        });
      };
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ['update', 'insert', 'delete'].includes(node.expression.name.text) && node.arguments.length === 1) {
        const table = tableOf(node.arguments[0]!, tables);
        if (table) record(table, node.expression.name.text as AgentWriter['op']);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const issued = issuers.get(node.expression.text);
        if (issued) record(issued, 'issue', !passesExecutor(node));
      }
      // Raw SQL naming a table in its text.
      if (ts.isTaggedTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) || ts.isStringLiteral(node)) {
        const raw = node.getText(source);
        const match = SQL_WRITE.exec(raw);
        if (match && !ts.isTemplateSpan(node.parent) && !(ts.isTaggedTemplateExpression(node.parent))) record(match[2]!.toLowerCase(), opOf(match[1]!));
      }
      // Raw SQL interpolating a table (sql`UPDATE ${agentEmployees} ...`).
      if (ts.isTemplateExpression(node)) {
        let before = node.head.text;
        for (const span of node.templateSpans) {
          const table = tableOf(span.expression, tables);
          const match = SQL_WRITE_BEFORE_TABLE.exec(before);
          if (table && match) record(table, opOf(match[1]!));
          before = span.literal.text;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

if (process.argv[1] && process.argv[1].endsWith('agent-writer-scan.ts')) {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../src');
  for (const w of scanAgentWriters(root)) console.log(`${w.file}:${w.line}\t${w.op} ${w.table}\t${w.site}	${w.inChokePoint ? 'MANAGED' : '-'}${w.dbInsideWork ? ' USES-DB' : ''}`);
}
