import path from 'node:path';

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const WINDOWS_RESERVED_NAME =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[._-]|$)/i;

export function normalizeDemoCertificationRunId(
  rawRunId: string | undefined,
  now = new Date(),
): string {
  const runId = rawRunId ?? now.toISOString().replace(/[:.]/g, '-');

  if (
    runId !== runId.trim() ||
    !RUN_ID_PATTERN.test(runId) ||
    WINDOWS_RESERVED_NAME.test(runId)
  ) {
    throw new Error(
      'DEFT_DEMO_CERT_RUN_ID must be 1-80 characters and contain only letters, numbers, dots, underscores, or hyphens',
    );
  }

  return runId;
}

export function resolvePathInside(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, ...segments);
  const relativeTarget = path.relative(resolvedRoot, resolvedTarget);

  if (
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTarget)
  ) {
    throw new Error('Resolved report path escapes the reports directory');
  }

  return resolvedTarget;
}

export function createDemoCertificationReportPaths(
  rawRunId: string | undefined,
  cwd = process.cwd(),
  now = new Date(),
) {
  const runId = normalizeDemoCertificationRunId(rawRunId, now);
  const reportsRoot = path.resolve(cwd, 'reports');
  const htmlFilename = `demo-claim-certification-${runId}.html`;
  const jsonFilename = `demo-claim-certification-${runId}.json`;

  return {
    runId,
    runMarker: `DEMO-CERT-${runId.replace(/[^a-zA-Z0-9]/g, '').slice(-10)}`,
    outDir: resolvePathInside(
      reportsRoot,
      'demo-claim-certification',
      runId,
    ),
    htmlReport: resolvePathInside(
      reportsRoot,
      htmlFilename,
    ),
    jsonReport: resolvePathInside(
      reportsRoot,
      jsonFilename,
    ),
    htmlReportLogPath: path.posix.join('reports', htmlFilename),
    jsonReportLogPath: path.posix.join('reports', jsonFilename),
  };
}
