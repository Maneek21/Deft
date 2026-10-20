import {
  APP_INTEGRATION_CAPTURE_NOMINATION_BYTES, AppIntegrationCaptureNominationSchema,
} from '../../../../packages/app-kit/src/app-integration-source.js';
import { appIntegrationSourceDigest, type AppIntegrationSourceSnapshot } from './app-integration-source.js';

export type AppSourceCaptureEvidence = Readonly<{
  eligible: boolean; reason?: string; body?: string; body_digest?: string;
  grouping_key?: string; source_title: string; observed_at: string;
  partial: true; attachments_processed: false;
}>;

/** Decode only the explicitly opted-in neutral version. Authority and destination
 * consent belong to the native capture owner, never the nominated source text.
 * Known older versions return null for their bounded compatibility decoder. */
export function decodeAppSourceCaptureEvidence(snapshot: AppIntegrationSourceSnapshot): AppSourceCaptureEvidence | null {
  const invalid = () => new Error('APP_INTEGRATION_CAPTURE_INVALID_NOMINATION');
  const metadata = snapshot.presentation.metadata as Record<string, unknown> | undefined;
  const encoded = metadata?.capture_nomination;
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > APP_INTEGRATION_CAPTURE_NOMINATION_BYTES) throw invalid();
  let nomination;
  try { nomination = AppIntegrationCaptureNominationSchema.parse(JSON.parse(encoded)); } catch { throw invalid(); }
  if (nomination.schema_version !== 'deft.app_capture_nomination.v3') return null;
  const publicationTime = Date.parse(snapshot.publication.observed_at);
  if (!Number.isFinite(publicationTime) || Date.parse(nomination.observed_at) > publicationTime) throw invalid();
  const base = { source_title: nomination.source_title, observed_at: nomination.observed_at,
    partial: nomination.completeness.partial, attachments_processed: nomination.completeness.attachments_processed };
  if (!nomination.eligible) return { ...base, eligible: false, reason: nomination.reason ?? 'app_ineligible' };
  if (!nomination.body || nomination.body_digest !== appIntegrationSourceDigest(nomination.body)) throw invalid();
  return { ...base, eligible: true, body: nomination.body, body_digest: nomination.body_digest,
    grouping_key: nomination.grouping_key };
}
