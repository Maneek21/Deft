import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveProjectTargetFromRows,
  type ProjectTargetRow,
} from '../src/lib/resolve-project-target.js';

function project(id: string, name: string, prefix: string): ProjectTargetRow {
  return {
    id,
    name,
    prefix,
    is_archived: false,
    is_deleted: false,
  };
}

const route = project('route', 'Route + Packing Reliability', 'RPR');
const pilot = project('pilot', 'Pilot Marketing Launch', 'MKT');

test('resolves an exact project name to its canonical row', () => {
  const resolution = resolveProjectTargetFromRows([route, pilot], {
    projectName: 'route + packing reliability',
  });
  assert.equal(resolution.status, 'resolved');
  if (resolution.status === 'resolved') assert.equal(resolution.project.id, route.id);
});

test('recovers a complete canonical project name from contaminated planner prose', () => {
  const resolution = resolveProjectTargetFromRows([route, pilot], {
    projectName: 'Route + Packing Reliability Let\'s proceed to create this task. Please provide anything else if needed.',
  });
  assert.equal(resolution.status, 'resolved');
  if (resolution.status === 'resolved') {
    assert.equal(resolution.project.id, route.id);
    assert.equal(resolution.project.name, route.name);
    assert.equal(resolution.project.match_reason, 'name: complete name in text');
  }
});

test('does not echo malformed model output when no project matches', () => {
  const malformed = 'Definitely Not A Project plus generated internal instructions';
  const resolution = resolveProjectTargetFromRows([route, pilot], { projectName: malformed });
  assert.equal(resolution.status, 'missing');
  if (resolution.status === 'missing') assert.equal(resolution.message.includes(malformed), false);
});

test('asks when planner text contains two complete project names', () => {
  const resolution = resolveProjectTargetFromRows([route, pilot], {
    projectName: 'Coordinate Route + Packing Reliability and Pilot Marketing Launch before proceeding.',
  });
  assert.equal(resolution.status, 'ambiguous');
  if (resolution.status === 'ambiguous') {
    assert.deepEqual(new Set(resolution.matches.map((match) => match.id)), new Set([route.id, pilot.id]));
  }
});

test('prefers the more specific exact project in a nested project family', () => {
  const sales = project('sales', 'Sales', 'SAL');
  const internal = project('sales-internal', 'Sales Internal', 'SINT');
  const leadership = project('sales-leadership', 'Sales Leadership', 'SLEAD');
  const resolution = resolveProjectTargetFromRows([sales, internal, leadership], {
    projectName: 'Sales Internal needs a follow-up task.',
  });
  assert.equal(resolution.status, 'resolved');
  if (resolution.status === 'resolved') assert.equal(resolution.project.id, internal.id);
});

test('asks when a short name matches several sibling projects', () => {
  const internal = project('sales-internal', 'Sales Internal', 'SINT');
  const leadership = project('sales-leadership', 'Sales Leadership', 'SLEAD');
  const resolution = resolveProjectTargetFromRows([internal, leadership], { projectName: 'Sales' });
  assert.equal(resolution.status, 'ambiguous');
});

test('uses a source-space link only when exactly one active project is linked', () => {
  const resolution = resolveProjectTargetFromRows([route, pilot], {
    linkedProjectIds: new Set([route.id]),
  });
  assert.equal(resolution.status, 'resolved');
  if (resolution.status === 'resolved') assert.equal(resolution.project.id, route.id);
});

test('asks instead of choosing the first project when a space has multiple links', () => {
  const resolution = resolveProjectTargetFromRows([route, pilot], {
    linkedProjectIds: new Set([route.id, pilot.id]),
  });
  assert.equal(resolution.status, 'ambiguous');
});

test('an explicit nonexistent target never falls back to the linked project', () => {
  const resolution = resolveProjectTargetFromRows([route, pilot], {
    projectName: 'Nonexistent Expansion Project',
    linkedProjectIds: new Set([route.id]),
  });
  assert.equal(resolution.status, 'missing');
});

test('archived and deleted projects cannot be resolved', () => {
  const archived = { ...route, is_archived: true };
  const deleted = { ...pilot, is_deleted: true };
  assert.equal(resolveProjectTargetFromRows([archived], { projectName: route.name }).status, 'missing');
  assert.equal(resolveProjectTargetFromRows([deleted], { projectName: pilot.name }).status, 'missing');
});
