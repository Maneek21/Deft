/**
 * Phase 8 — DeftCloud provider (placeholder).
 *
 * "Deft Cloud" is the future managed-hosting tier where Deft itself runs the
 * OpenClaw container on shared infrastructure for a flat monthly fee. Not
 * shipping in v1 — this class exists so the DeploymentProvider registry has
 * a known entry for the wizard card and so any accidental provisioning
 * attempts fail loudly.
 *
 * Ship date: v1.1 (or v2 depending on managed-infra readiness).
 */
import type {
  DeployContext,
  DeploymentProvider,
  InstanceStatus,
  ProviderInstanceRecord,
  ProvisionResult,
} from './types.js';

export class DeftCloudProvider implements DeploymentProvider {
  readonly id = 'deft_cloud' as const;
  readonly displayName = 'Deft Cloud';
  readonly isManaged = true;
  readonly isAvailable = false;
  readonly comingSoon = true;

  async provision(_ctx: DeployContext): Promise<ProvisionResult> {
    throw new Error(
      'Deft Cloud is coming soon — use Railway Managed or BYO for now',
    );
  }

  async getStatus(_instance: ProviderInstanceRecord): Promise<InstanceStatus> {
    return 'unknown';
  }

  async destroy(_instance: ProviderInstanceRecord): Promise<void> {
    throw new Error(
      'Deft Cloud is coming soon — use Railway Managed or BYO for now',
    );
  }

  estimateCostUsdCents(): number | null {
    return 1500; // $15/mo target placeholder for UI display
  }
}
