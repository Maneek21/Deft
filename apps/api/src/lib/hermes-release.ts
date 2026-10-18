import { readFileSync } from 'node:fs';

export type HermesBundleAvailability = {
  status: 'release_certified' | 'operator_provided' | 'unavailable';
  url: string | null;
  detail: string;
};

function releaseScope(): unknown {
  try {
    const value = JSON.parse(readFileSync(new URL('../../../../release/release-scope.json', import.meta.url), 'utf8'));
    return value.schema === 'deft.release.scope.v1' ? value.scope : null;
  } catch {
    // An absent or malformed release profile cannot promise a certified asset.
    return null;
  }
}

export function hermesBundleAvailability(
  releaseVersion: string,
  scope: unknown = releaseScope(),
  overrideUrl = process.env.DEFT_HERMES_BUNDLE_URL?.trim(),
): HermesBundleAvailability {
  if (overrideUrl) {
    return {
      status: 'operator_provided',
      url: overrideUrl,
      detail: 'An operator-provided Hermes bundle is configured. Verify its checksum, release compatibility, and certification before installation; this URL does not establish certification.',
    };
  }
  if (scope === 'hermes-certified') {
    return {
      status: 'release_certified',
      url: `https://github.com/Maneek21/Deft/releases/download/v${releaseVersion}/deft-hermes-integration-${releaseVersion}.tar.gz`,
      detail: `The Deft ${releaseVersion} release profile includes a certified Hermes integration. Verify the archive against the published release manifest before installation.`,
    };
  }
  return {
    status: 'unavailable',
    url: null,
    detail: `Deft ${releaseVersion} does not include a certified Hermes integration bundle. Native Hermes onboarding is blocked until a compatible certified release is available or an operator supplies a verified bundle.`,
  };
}
