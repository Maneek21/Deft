/**
 * Phase 8 — DeploymentProvider abstraction.
 *
 * The DeploymentProvider interface is the architectural seam that lets Deft
 * own the employee deployment lifecycle across multiple third-party IaaS
 * providers. Every concrete provider (Railway today, Fly/DO/Deft-Cloud later)
 * implements provision(), getStatus(), destroy(), and estimateCostUsdCents().
 *
 * The wizard picks a provider via the PROVIDERS registry; the provisioning
 * worker calls provision() with a DeployContext built from the employee row +
 * template + tokens. provision() returns a ProvisionResult which the caller
 * inserts into the `provider_instances` table.
 *
 * This file is pure types — no runtime code, no imports from concrete
 * providers. Concrete providers live in sibling files.
 */

export type DeploymentProviderId =
  | 'railway'
  | 'fly'
  | 'digitalocean'
  | 'deft_cloud'
  | 'byo';

/**
 * Instance-level status normalized across all providers. Individual providers
 * map their raw statuses onto this enum inside getStatus().
 */
export type InstanceStatus =
  | 'provisioning'
  | 'running'
  | 'crashed'
  | 'stopped'
  | 'destroyed'
  | 'unknown';

/**
 * Everything a provider needs to spin up an OpenClaw container and return a
 * working URL. Built by the deploy-provision worker from the employee row +
 * its template + the wizard submission payload.
 */
export type DeployContext = {
  employee: {
    id: string;
    org_id: string;
    slug: string;
    name: string;
    template_slug: string | null;
    template_version: string | null;
  };
  org: {
    id: string;
    name: string;
    timezone: string;
  };
  integration?: {
    id: string;
    provider: string;
    access_token_encrypted: string;
    refresh_token_encrypted: string | null;
    access_token_expires_at: Date | null;
    external_workspace_id: string | null;
    external_default_project_id: string | null;
  };
  soulMd: string;
  agentsMd: string;
  userMd: string;
  toolsMd: string;
  /** Raw, unhashed — DeploymentProvider bakes it into container env vars. */
  gatewayToken: string;
  /** Raw Deft MCP bearer token — also baked into env vars. */
  deftMcpToken: string;
  anthropicApiKey: string;
  capabilityPackSlugs: string[];
  /** Extra secrets collected from wizard step 2 (e.g. GITHUB_MCP_TOKEN). */
  capabilityPackSecrets: Record<string, string>;
  /** Public URL of the Deft API the deployed container should call back to. */
  deftApiUrl: string;
  /**
   * Only used for BYO: the URL + token the user pasted in the wizard. Every
   * other provider ignores these fields and derives its own.
   */
  byoConnectionUrl?: string;
};

export type ProvisionResult = {
  external_instance_id: string;
  external_project_id?: string;
  external_environment_id?: string;
  /** The public URL OpenClaw responds at. BYO = user's URL; managed = provisioned URL. */
  connection_url: string;
  provider_metadata: Record<string, unknown>;
  estimated_cost_usd_cents_monthly: number | null;
};

/**
 * Minimal provider_instances row shape passed to getStatus/destroy so they
 * never need to re-read the DB.
 */
export type ProviderInstanceRecord = {
  id: string;
  org_id: string;
  provider: DeploymentProviderId;
  integration_id: string | null;
  external_instance_id: string | null;
  external_project_id: string | null;
  external_environment_id: string | null;
  provider_metadata: Record<string, unknown> | null;
};

export interface DeploymentProvider {
  readonly id: DeploymentProviderId;
  readonly displayName: string;
  /** True for Deft-orchestrated providers (Railway/Fly/DO/DeftCloud). False for BYO. */
  readonly isManaged: boolean;
  /** Feature flag. Today: false for everything except Railway + BYO. */
  readonly isAvailable: boolean;
  /** If true, the wizard card renders as disabled "Coming Soon". */
  readonly comingSoon: boolean;
  provision(ctx: DeployContext): Promise<ProvisionResult>;
  getStatus(instance: ProviderInstanceRecord): Promise<InstanceStatus>;
  destroy(instance: ProviderInstanceRecord): Promise<void>;
  /** Monthly cost estimate in USD cents for the wizard summary card. */
  estimateCostUsdCents(): number | null;
}
