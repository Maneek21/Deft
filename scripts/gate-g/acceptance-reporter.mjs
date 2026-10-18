// Run with node --test --test-reporter=<this file> --test-reporter-destination=<file>.
// Only metadata is retained; test stdout can contain sensitive fixture values.
export default async function* acceptanceReporter(events) {
  for await (const { type, data } of events) {
    if (!['test:pass', 'test:fail', 'test:summary'].includes(type)) continue;
    const { name, file, nesting, skip, todo, success, counts, details } = data;
    yield `${JSON.stringify({ type, name, file, nesting, skip, todo, success, counts,
      testType: details?.type, durationMs: details?.duration_ms })}\n`;
  }
}
