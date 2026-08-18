import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  parseDeftModuleManifest,
  type ModuleRecordQueryRequest,
} from '@deft/shared/modules';
import {
  _moduleQueryCompilerForTest,
  escapeModuleLikeLiteral,
} from '../src/lib/module-service.js';

const manifest = parseDeftModuleManifest({
  schema_version: '1',
  id: 'community.deft.query-test',
  slug: 'query-test',
  version: '1.0.0',
  name: 'Query Test',
  collections: [{
    key: 'entries',
    name: 'Entries',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'website', label: 'Website', type: 'url' },
      { key: 'score', label: 'Score', type: 'number' },
      { key: 'active', label: 'Active', type: 'boolean' },
      { key: 'joined_on', label: 'Joined on', type: 'date' },
      { key: 'met_at', label: 'Met at', type: 'datetime' },
      {
        key: 'status',
        label: 'Status',
        type: 'single_select',
        options: [
          { value: 'lead', label: 'Lead' },
          { value: 'customer', label: 'Customer' },
        ],
      },
      {
        key: 'tags',
        label: 'Tags',
        type: 'multi_select',
        options: [
          { value: 'founder', label: 'Founder' },
          { value: 'design', label: 'Design' },
        ],
      },
    ],
  }],
});

const dialect = new PgDialect();
type Filter = ModuleRecordQueryRequest['filters'][number];

function compileFilter(filter: Filter) {
  return dialect.sqlToQuery(
    _moduleQueryCompilerForTest.filterCondition(manifest, 'entries', filter),
  );
}

function compileSort(field: string) {
  return dialect.sqlToQuery(
    _moduleQueryCompilerForTest.sortExpression(manifest, 'entries', {
      field,
      direction: 'asc',
    } as ModuleRecordQueryRequest['sort']),
  );
}

describe('module query compiler', () => {
  test('enforces manifest field types and operator compatibility', () => {
    assert.throws(
      () => compileFilter({ field: 'score', operator: 'contains', value: '10' }),
      /contains is only valid/,
    );
    assert.throws(
      () => compileFilter({ field: 'active', operator: 'gt', value: true }),
      /only valid for number\/date/,
    );
    assert.throws(
      () => compileFilter({ field: 'score', operator: 'eq', value: '10' }),
      /Must be a finite number/,
    );
    assert.throws(
      () => compileFilter({ field: 'joined_on', operator: 'gte', value: '2026-02-30' }),
      /real calendar date/,
    );
    assert.throws(
      () => compileFilter({ field: 'met_at', operator: 'lt', value: '2026-01-01T10:00:00+14:01' }),
      /ISO 8601 datetime/,
    );
  });

  test('requires declared select options for every select operator', () => {
    assert.throws(
      () => compileFilter({ field: 'status', operator: 'eq', value: 'prospect' }),
      /declared option/,
    );
    assert.throws(
      () => compileFilter({ field: 'status', operator: 'in', value: ['lead', 'prospect'] }),
      /declared option/,
    );
    assert.throws(
      () => compileFilter({ field: 'tags', operator: 'contains', value: 'unknown' }),
      /declared option/,
    );
    assert.throws(
      () => compileFilter({ field: 'tags', operator: 'in', value: ['founder', 'unknown'] }),
      /declared option/,
    );

    assert.doesNotThrow(() => compileFilter({
      field: 'tags',
      operator: 'contains',
      value: 'founder',
    }));
    assert.doesNotThrow(() => compileFilter({
      field: 'status',
      operator: 'in',
      value: ['lead', 'customer'],
    }));
  });

  test('escapes LIKE metacharacters so contains remains literal', () => {
    assert.equal(escapeModuleLikeLiteral('100%_\\match'), '100\\%\\_\\\\match');
    const compiled = compileFilter({
      field: 'name',
      operator: 'contains',
      value: '100%_\\match',
    });
    assert.match(compiled.sql, / ILIKE /i);
    assert.match(compiled.sql, / ESCAPE /i);
    assert.equal(compiled.params.includes('%100\\%\\_\\\\match%'), true);
  });

  test('casts dates and datetimes for comparisons and equality', () => {
    const dateComparison = compileFilter({
      field: 'joined_on',
      operator: 'gte',
      value: '2026-01-31',
    });
    assert.equal((dateComparison.sql.match(/::date/g) ?? []).length, 2);

    const datetimeEquality = compileFilter({
      field: 'met_at',
      operator: 'eq',
      value: '2026-01-01T10:00:00+05:30',
    });
    assert.equal((datetimeEquality.sql.match(/::timestamptz/g) ?? []).length, 2);

    const dateSet = compileFilter({
      field: 'joined_on',
      operator: 'in',
      value: ['2026-01-31', '2026-02-01'],
    });
    assert.equal((dateSet.sql.match(/::date/g) ?? []).length, 3);
  });

  test('casts date and datetime sort keys for chronological ordering', () => {
    assert.match(compileSort('joined_on').sql, /::date/);
    assert.match(compileSort('met_at').sql, /::timestamptz/);
    assert.doesNotMatch(compileSort('name').sql, /::date|::timestamptz/);
    assert.throws(() => compileSort('tags'), /Cannot sort by a multi-select/);
  });
});
