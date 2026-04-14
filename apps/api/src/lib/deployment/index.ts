/**
 * Phase 8 — DeploymentProvider registry + factory.
 *
 * Single source of truth for "which providers does this Deft install offer
 * today". The wizard reads `getAvailableProviders()` to render cards. The
 * deploy-provision worker reads `getProvider(id)` to dispatch provisioning.
 */
import type { DeploymentProvider, DeploymentProviderId } from './types.js';
import { BYOProvider } from './byo-provider.js';
import { DeftCloudProvider } from './deft-cloud-provider.js';
import { RailwayProvider } from './railway-provider.js';
import { isRailwayOAuthConfigured } from '../railway-oauth.js';

const railway = new RailwayProvider();
const byo = new BYOProvider();
const deftCloud = new DeftCloudProvider();

export const PROVIDERS: Record<DeploymentProviderId, DeploymentProvider> = {
  railway,
  byo,
  deft_cloud: deftCloud,
  // Placeholders — never instantiated until their providers are written.
  fly: byo,
  digitalocean: byo,
};

export function getProvider(id: DeploymentProviderId): DeploymentProvider {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Unknown deployment provider: ${id}`);
  return p;
}

/**
 * Providers the wizard should render, in display order. Filters out hidden
 * providers (fly/digitalocean) and reflects per-provider feature flags like
 * Railway OAuth configuration.
 */
export function listWizardProviders(): Array<{
  id: DeploymentProviderId;
  displayName: string;
  isManaged: boolean;
  isAvailable: boolean;
  comingSoon: boolean;
  estimatedCostUsdCents: number | null;
  unavailableReason?: string;
}> {
  const out: Array<{
    id: DeploymentProviderId;
    displayName: string;
    isManaged: boolean;
    isAvailable: boolean;
    comingSoon: boolean;
    estimatedCostUsdCents: number | null;
    unavailableReason?: string;
  }> = [];

  // Deft Cloud first (hero "Coming Soon" card).
  out.push({
    id: deftCloud.id,
    displayName: deftCloud.displayName,
    isManaged: deftCloud.isManaged,
    isAvailable: deftCloud.isAvailable,
    comingSoon: deftCloud.comingSoon,
    estimatedCostUsdCents: deftCloud.estimateCostUsdCents(),
  });

  // Railway — dependent on OAuth configuration.
  const railwayConfigured = isRailwayOAuthConfigured();
  out.push({
    id: railway.id,
    displayName: railway.displayName,
    isManaged: railway.isManaged,
    isAvailable: railway.isAvailable && railwayConfigured,
    comingSoon: false,
    estimatedCostUsdCents: railway.estimateCostUsdCents(),
    unavailableReason: railwayConfigured
      ? undefined
      : 'Railway integration not configured — ask your administrator to set RAILWAY_OAUTH_CLIENT_ID + RAILWAY_OAUTH_CLIENT_SECRET',
  });

  // BYO — always available.
  out.push({
    id: byo.id,
    displayName: byo.displayName,
    isManaged: byo.isManaged,
    isAvailable: true,
    comingSoon: false,
    estimatedCostUsdCents: null,
  });

  return out;
}

export { BYOProvider, DeftCloudProvider, RailwayProvider };
