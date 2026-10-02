import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const normalize = (value) => value.replaceAll('\\', '/');
const caseKey = ({ file, name }) => `${normalize(file)}::${name}`;

// A green process exit is insufficient: every frozen case must execute and pass.
// This is an execution check, not an attestation or a Gate G certification.
export function checkEvidence(profile, events, { root = process.cwd() } = {}) {
  if (!Array.isArray(profile.cases) || profile.cases.length === 0) {
    throw new Error('A nonempty, reviewed required-case inventory is mandatory');
  }
  if (profile.cases.some((entry) => !entry || typeof entry.file !== 'string' || !entry.file ||
    typeof entry.name !== 'string' || !entry.name)) throw new Error('Malformed required case');
  const expected = new Set(profile.cases.map((entry) => caseKey({ ...entry, file: resolve(root, entry.file) })));
  if (expected.size !== profile.cases.length) throw new Error('Duplicate required case');
  const errors = [];
  const completed = events.filter(({ type, testType }) =>
    ['test:pass', 'test:fail'].includes(type) && testType !== 'suite');
  for (const event of events) {
    if (event.type === 'test:fail') errors.push(`Failed: ${event.name}`);
    if (event.skip || event.todo) errors.push(`Not executed: ${event.name}`);
  }
  const summaries = events.filter(({ type, file, nesting }) =>
    type === 'test:summary' && !file && (nesting === undefined || nesting === 0));
  if (summaries.length !== 1 || summaries[0].success !== true) {
    errors.push('Missing or unsuccessful final runner summary');
  }
  if (summaries[0] !== events.at(-1)) errors.push('Runner summary must terminate the evidence stream');
  const counts = summaries[0]?.counts;
  const countFields = ['tests', 'passed', 'failed', 'skipped', 'todo', 'cancelled'];
  if (!counts || countFields.some((key) => !Number.isSafeInteger(counts[key]) || counts[key] < 0)) {
    errors.push('Missing or malformed runner counts');
  } else if (counts.failed || counts.skipped || counts.todo || counts.cancelled) {
    errors.push('Runner reports failed, skipped, todo, or cancelled cases');
  } else if (counts.tests !== completed.length || counts.passed !== completed.length) {
    errors.push('Runner counts do not match captured test executions');
  }
  for (const required of profile.cases) {
    const matches = completed.filter((event) => typeof event.file === 'string' &&
      normalize(resolve(event.file)) === normalize(resolve(root, required.file)) &&
      event.name === required.name);
    if (matches.length !== 1) errors.push(`Expected exactly one execution: ${caseKey(required)} (found ${matches.length})`);
    else if (matches[0].type !== 'test:pass' || matches[0].skip || matches[0].todo) {
      errors.push(`Required case did not pass: ${caseKey(required)}`);
    }
  }
  return { profile: profile.id, required: expected.size, observed: completed.length,
    passed: errors.length === 0, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [, , manifestPath, profileId, evidencePath] = process.argv;
    if (!manifestPath || !profileId || !evidencePath) {
      throw new Error('Usage: node check-evidence.mjs manifest.json profile-id results.jsonl');
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const profile = manifest.profiles.find(({ id }) => id === profileId);
    if (!profile) throw new Error(`Unknown profile: ${profileId}`);
    const events = readFileSync(evidencePath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const result = checkEvidence(profile, events);
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
