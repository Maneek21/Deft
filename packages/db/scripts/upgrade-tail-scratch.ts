import { randomBytes } from 'node:crypto';

/** PostgreSQL silently truncates longer identifiers to 63 bytes. */
const MAX_IDENTIFIER_BYTES = 63;

export const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** A scratch database name unique to one call: `<prefix>tail_<12 hex>`. Built
 * from a short fixed prefix, never from the fixture's own name, so it can't be
 * truncated back onto the fixture or any other database. */
export function scratchDatabaseName(prefix: string, random: () => string = () => randomBytes(6).toString('hex')): string {
  const name = `${prefix}tail_${random()}`;
  if (!/^[a-z0-9_]+$/u.test(name)) throw new Error(`Unusable scratch database name: ${name}`);
  if (Buffer.byteLength(name) > MAX_IDENTIFIER_BYTES) {
    throw new Error(`Scratch database name is longer than ${MAX_IDENTIFIER_BYTES} bytes: ${name}`);
  }
  return name;
}

/** The scratch databases one test run created. A name is recorded only after
 * its CREATE DATABASE succeeded, and only recorded names are ever dropped: a
 * name that is already taken fails creation and is left alone. */
export class ScratchDatabases {
  private readonly created = new Set<string>();

  constructor(private readonly run: (sql: string) => Promise<unknown>) {}

  async create(name: string, template: string): Promise<string> {
    if (name === template) throw new Error('A scratch database must differ from its template');
    await this.run(`CREATE DATABASE ${quoteIdent(name)} TEMPLATE ${quoteIdent(template)}`);
    this.created.add(name);
    return name;
  }

  async drop(name: string): Promise<void> {
    if (!this.created.has(name)) return;
    await this.run(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
    this.created.delete(name);
  }

  async dropAll(): Promise<void> {
    for (const name of [...this.created]) await this.drop(name);
  }

  get names(): string[] {
    return [...this.created];
  }
}
