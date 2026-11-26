import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseSupportedDeftModuleManifest } from '@deft/shared/modules';
import { agentAccessPatchFor, describeModuleManifest, MODULE_ACCESS_SENTENCE } from './module-describe';
import { APP_TEMPLATES } from './app-templates';
import { AgentReadQuestion, ManifestSummary } from '../components/apps/manifest-summary';

const hiring = APP_TEMPLATES.find((template) => template.key === 'hiring-pipeline')!.manifest;
const contacts = parseSupportedDeftModuleManifest(JSON.parse(readFileSync(
  new URL('../../../../modules/bundled/contacts/deft.module.json', import.meta.url),
  'utf8',
)));

test('describes the hiring pipeline in plain sentences', () => {
  const description = describeModuleManifest(hiring);
  assert.equal(description.summary, 'Hiring pipeline adds 2 record types: Candidates and Roles.');
  assert.equal(description.access, MODULE_ACCESS_SENTENCE);
  const [candidates, roles] = description.collections;
  assert.equal(candidates!.summary, 'Candidates: 8 fields, 1 link and 5 views.');
  assert.deepEqual(candidates!.relations, ['Each Candidate links to one Role']);
  assert.ok(candidates!.fields.includes('Name: text, required'));
  assert.ok(candidates!.fields.includes(
    'Stage: pick one of Applied, Phone screen, Interview, Offer, Hired and Declined, starts as Applied, required',
  ));
  assert.ok(candidates!.fields.includes('Owner: a workspace member'));
  assert.deepEqual(candidates!.views.slice(0, 3), [
    'Pipeline: a board grouped by Stage',
    'All candidates: a table',
    'Next steps: a timeline from Next step on',
  ]);
  assert.equal(roles!.summary, 'Roles: 6 fields and 4 views.');
  assert.ok(roles!.fields.includes('Openings: a number, starts as 1'));
});

test('describes bundled Contacts, including links, sums and long option lists', () => {
  const description = describeModuleManifest(contacts);
  assert.equal(description.summary, 'Contacts adds 5 record types: Contacts, Companies, Deals, Activities and Outreach.');
  const deals = description.collections.find((collection) => collection.key === 'deals')!;
  assert.deepEqual(deals.relations, ['Each Deal links to one Company', 'Each Deal links to one Contact (Primary contact)']);
  assert.ok(deals.views.includes('Pipeline: a board grouped by Stage, adding up Value'));
  assert.ok(deals.fields.some((field) => /^Currency: pick one of USD, EUR, GBP, INR, CAD, AUD and \d+ more$/.test(field)));
  const outreach = description.collections.find((collection) => collection.key === 'outreach')!;
  assert.deepEqual(outreach.relations, ['Each Outreach draft links to any number of Contacts (Recipients)']);
});

test('no description says module, collection or manifest', () => {
  for (const manifest of [hiring, contacts, ...APP_TEMPLATES.map((template) => template.manifest)]) {
    const description = describeModuleManifest(manifest);
    const text = [description.summary, description.access, ...description.collections.flatMap((item) => [item.summary, ...item.fields, ...item.relations, ...item.views])].join(' | ');
    assert.doesNotMatch(text, /\b(modules?|collections?|manifests?)\b/i, manifest.slug);
  }
});

test('the summary shows each record type and, only when asked, the Defty question defaulting to no', () => {
  const withoutQuestion = renderToStaticMarkup(createElement(ManifestSummary, { manifest: hiring }));
  assert.match(withoutQuestion, /Hiring pipeline adds 2 record types: Candidates and Roles\./);
  assert.match(withoutQuestion, /Each Candidate links to one Role/);
  assert.doesNotMatch(withoutQuestion, /Let Defty read these records\?/);

  const withQuestion = renderToStaticMarkup(createElement(ManifestSummary, { manifest: hiring, onAgentReadChange: () => {} }));
  assert.match(withQuestion, /Let Defty read these records\?/);
  assert.match(withQuestion, /checked="" value="no"/);
  assert.doesNotMatch(withQuestion, /checked="" value="yes"/);
});

function findInputs(node: ReactNode, found: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findInputs(child, found);
  } else if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    if (node.type === 'input') found.push(node);
    findInputs(props.children, found);
  }
  return found;
}

test('answering yes sends agent_access read; answering no sends nothing', () => {
  const answers: boolean[] = [];
  const tree = AgentReadQuestion({ idBase: 'q', agentRead: false, onAgentReadChange: (value) => answers.push(value) });
  const inputs = findInputs(tree);
  const yes = inputs.find((input) => (input.props as { value?: string }).value === 'yes')!;
  const no = inputs.find((input) => (input.props as { value?: string }).value === 'no')!;
  (yes.props as { onChange: () => void }).onChange();
  (no.props as { onChange: () => void }).onChange();
  assert.deepEqual(answers, [true, false]);
  assert.deepEqual(agentAccessPatchFor(true), { agent_access: 'read' });
  assert.equal(agentAccessPatchFor(false), null);
});
