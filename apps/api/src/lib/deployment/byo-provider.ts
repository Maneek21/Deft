/**
 * Phase 8 — BYO (bring-your-own) provider.
 *
 * For users who already run OpenClaw themselves (VPS, bare metal, their own
 * Kubernetes). Deft records the URL + token but does NOT provision, manage,
 * or destroy the underlying infrastructure.
 *
 *   - provision(): returns the connection_url the user pasted verbatim
 *   - getStatus(): polls <connection_url>/health
 *   - destroy():   no-op; user owns the infra
 *   - estimateCostUsdCents(): returns null (unknown)
 */
import type {
  DeployContext,
  DeploymentProvider,
  InstanceStatus,
  ProviderInstanceRecord,
  ProvisionResult,
} from './types.js';

export class BYOProvider implements DeploymentProvider {
  readonly id = 'byo' as const;
  readonly displayName = 'BYO OpenClaw';
  readonly isManaged = false;
  readonly isAvailable = true;
  readonly comingSoon = false;

  async provision(ctx: DeployContext): Promise<ProvisionResult> {
    if (!ctx.byoConnectionUrl) {
      throw new Error('BYOProvider.provision requires ctx.byoConnectionUrl');
    }
    return {
      external_instance_id: `byo-${ctx.employee.slug}-${ctx.employee.id.slice(0, 8)}`,
      connection_url: ctx.byoConnectionUrl,
      provider_metadata: {
        byo: true,
        owner_responsibility: 'user',
      },
      estimated_cost_usd_cents_monthly: null,
    };
  }

  async getStatus(instance: ProviderInstanceRecord): Promise<InstanceStatus> {
    const url = (instance.provider_metadata?.connection_url as string | undefined) ??
      (instance.external_instance_id ? undefined : undefined);
    // Fallback: caller should pass connection_url via provider_metadata.
    const target = url ?? (instance.provider_metadata?.connection_url as string | undefined);
    if (!target) return 'unknown';
    try {
      const res = await fetch(`${target.replace(/\/$/, '')}/health`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      return res.ok ? 'running' : 'crashed';
    } catch {
      return 'crashed';
    }
  }

  async destroy(_instance: ProviderInstanceRecord): Promise<void> {
    // No-op: user owns the infrastructure.
  }

  estimateCostUsdCents(): number | null {
    return null;
  }
}
