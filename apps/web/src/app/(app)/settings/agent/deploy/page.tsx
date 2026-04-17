'use client';

// Phase 12 — feature flag gating the entire wizard. Matches the constant in
// ../page.tsx. When off, this route renders a short "not enabled" message
// instead of the wizard. Also prevents direct URL access.
const FEATURE_OPENCLAW_EMPLOYEES =
  process.env.NEXT_PUBLIC_FEATURE_OPENCLAW_EMPLOYEES === 'true';

/**
 * Phase 8 — Deploy Employee wizard.
 *
 * 7-step wizard that walks the user through role pick → capability packs →
 * deployment target → triggers → provisioning → handshake → approval mapping.
 *
 * Data flow:
 *   1. On mount: GET /api/agents/deploy/wizard-config + /api/integrations
 *   2. On submit (step 5 "Deploy"): POST /api/agents/deploy/start → employee_id
 *   3. Poll GET /api/agents/deploy/:id/status every 2s until connection_url
 *      is non-null or status == 'error'
 *   4. Click "Run handshake": POST /api/agents/deploy/:id/handshake
 *   5. Click "Finish": redirect to /settings/agent
 *
 * Task 4.7 — step 2 now renders a SkillPicker above the CapabilityPicker.
 * Selected skills go out as `skill_ids[]`; the backend inserts one row per
 * skill into agent_employee_skills and unions the derived capability_packs
 * into the employee column.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { RolePicker, type TemplateCard } from './role-picker';
import { CapabilityPicker, type Pack } from './capability-picker';
import { ProviderPicker, type ProviderCard, type Integration } from './provider-picker';
import { TriggerConfig } from './trigger-config';
import { ProvisionProgress } from './provision-progress';
import { Handshake } from './handshake';
import { ApprovalSummary } from './approval-summary';

type WizardConfig = {
  templates: TemplateCard[];
  capability_packs: Pack[];
  providers: ProviderCard[];
};

// Task 4.7 — skill picker shape. Returned by GET /api/agents/deploy/skills.
// Task 4.13 will promote this to /api/skills with the same shape.
type WizardSkill = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  source: 'bundled' | 'marketplace' | 'org';
  version: string;
  agent_config: {
    tools?: string[];
    capability_packs?: string[];
    triggers?: string[];
  } | null;
};

type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7;

// Task 4.7 — Inline skill picker. Inline rather than a new file because the
// task scopes us to this wizard page. Groups bundled + org skills, shows
// tool/trigger counts, and emits a toggle event per card click. Marketplace
// skills are filtered out server-side so they never reach this list.
function SkillPicker({
  skills,
  selected,
  onToggle,
}: {
  skills: WizardSkill[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  const groups = (['bundled', 'org'] as const)
    .map((src) => ({
      src,
      label: src === 'bundled' ? 'Bundled (first-party)' : 'Your organization',
      items: skills.filter((s) => s.source === src),
    }))
    .filter((g) => g.items.length > 0);

  return (
    <section data-testid="wizard-skills">
      <h3 className="text-[14px] font-semibold mb-1" style={{ color: 'var(--foreground)' }}>
        Which skills does this employee start with?
      </h3>
      <p className="text-[12px] mb-4" style={{ color: 'var(--muted)' }}>
        Skills bundle tools, triggers, and capability packs. Your template
        pre-selects its recommended skills — add or remove as needed.
      </p>

      {groups.length === 0 && (
        <p className="text-[12px]" style={{ color: 'var(--muted)' }}>
          No skills available. Seed bundled skills with{' '}
          <code>pnpm tsx apps/api/src/scripts/seed-bundled-skills.ts</code>.
        </p>
      )}

      {groups.map((group) => (
        <div key={group.src} className="mb-5">
          <div
            className="text-[11px] font-medium uppercase tracking-wide mb-2"
            style={{ color: 'var(--muted)' }}
          >
            {group.label}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {group.items.map((s) => {
              const checked = selected.includes(s.id);
              const toolCount = s.agent_config?.tools?.length ?? 0;
              const triggerCount = s.agent_config?.triggers?.length ?? 0;
              return (
                <button
                  type="button"
                  key={s.id}
                  onClick={() => onToggle(s.id)}
                  data-testid={`wizard-skill-${s.slug}`}
                  className="text-left p-3 rounded-lg transition-colors"
                  style={{
                    background: checked ? 'var(--surface-container-high)' : 'var(--surface-container)',
                    border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
                  }}
                >
                  <div className="flex items-start gap-2">
                    <input type="checkbox" checked={checked} readOnly className="mt-1" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        {s.icon && (
                          <span className="text-[14px]" aria-hidden>
                            {s.icon}
                          </span>
                        )}
                        <span
                          className="text-[13px] font-medium truncate"
                          style={{ color: 'var(--foreground)' }}
                        >
                          {s.name}
                        </span>
                      </div>
                      {s.description && (
                        <p
                          className="text-[11px] mt-0.5 line-clamp-2"
                          style={{ color: 'var(--muted)' }}
                        >
                          {s.description}
                        </p>
                      )}
                      <div
                        className="mt-1 text-[10px] flex gap-3"
                        style={{ color: 'var(--muted)' }}
                      >
                        <span>{toolCount} tool{toolCount === 1 ? '' : 's'}</span>
                        <span>{triggerCount} trigger{triggerCount === 1 ? '' : 's'}</span>
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}

function DeployDisabled() {
  return (
    <div className="max-w-3xl mx-auto p-6" data-testid="deploy-wizard-disabled">
      <h2
        className="text-[20px] font-semibold mb-2"
        style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
      >
        Deploy Employee is not enabled
      </h2>
      <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
        Set <code>NEXT_PUBLIC_FEATURE_OPENCLAW_EMPLOYEES=true</code> in your
        environment to enable the agent employee wizard.
      </p>
    </div>
  );
}

export default function DeployEmployeePage() {
  if (!FEATURE_OPENCLAW_EMPLOYEES) {
    return <DeployDisabled />;
  }

  return <DeployEmployeePageInner />;
}

function DeployEmployeePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

  const [step, setStep] = useState<Step>(1);
  const [config, setConfig] = useState<WizardConfig | null>(null);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);

  // Form state
  const [templateSlug, setTemplateSlug] = useState<string | null>(null);
  const [name, setName] = useState('Alex PM');
  const [slug, setSlug] = useState('alex-pm');
  const [capabilityPacks, setCapabilityPacks] = useState<string[]>([]);
  const [packSecrets, setPackSecrets] = useState<Record<string, string>>({});
  // Task 4.7 — skill picker. Skills are fetched once on mount; selection
  // is the set of skill ids sent to /start as `skill_ids[]`. When a template
  // is chosen we pre-check bundled skills whose slug matches the template's
  // default_capability_packs entries.
  const [skillsCatalog, setSkillsCatalog] = useState<WizardSkill[]>([]);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [provider, setProvider] = useState<string | null>(null);
  const [selectedIntegrationId, setSelectedIntegrationId] = useState<string | null>(null);
  const [byoConnectionUrl, setByoConnectionUrl] = useState('');
  const [byoGatewayToken, setByoGatewayToken] = useState('');
  const [triggers, setTriggers] = useState<string[]>([]);
  const [trustLevel] = useState<'conservative' | 'standard'>('standard');
  const [anthropicKey, setAnthropicKey] = useState('');

  // Runtime state
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [provisionStatus, setProvisionStatus] = useState('pending');
  const [connectionUrl, setConnectionUrl] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [handshakeStatus, setHandshakeStatus] = useState<'pending' | 'running' | 'success' | 'failed'>('pending');
  const [handshakeError, setHandshakeError] = useState<string | null>(null);
  const [handshakeModels, setHandshakeModels] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ─── Fetch wizard config + integrations + skills ───
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [configRes, intRes, skillsRes] = await Promise.all([
          api.fetch('/api/agents/deploy/wizard-config'),
          api.fetch('/api/integrations'),
          // Task 4.7 — skill catalog. Lives on the deploy router for now;
          // Task 4.13 will promote this to /api/skills.
          api.fetch('/api/agents/deploy/skills'),
        ]);
        if (cancelled) return;
        if (configRes.ok) {
          const body = (await configRes.json()) as WizardConfig;
          setConfig(body);
        }
        if (intRes.ok) {
          setIntegrations(await intRes.json());
        }
        if (skillsRes.ok) {
          const body = await skillsRes.json();
          const list = Array.isArray(body) ? body : (body.skills ?? []);
          setSkillsCatalog(list as WizardSkill[]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // ─── Handle ?railway=connected return ───
  useEffect(() => {
    const railwayStatus = searchParams.get('railway');
    if (railwayStatus === 'connected') {
      // Refresh integrations so the Railway card shows Connected
      api.fetch('/api/integrations').then(async (r) => {
        if (r.ok) setIntegrations(await r.json());
      });
    }
    const railwayError = searchParams.get('railway_error');
    if (railwayError) {
      setError(`Railway OAuth error: ${decodeURIComponent(railwayError)}`);
    }
  }, [searchParams]);

  // ─── When template changes, seed capability packs + triggers + skills ───
  const onSelectTemplate = useCallback(
    (newSlug: string) => {
      setTemplateSlug(newSlug);
      const t = config?.templates.find((x) => x.slug === newSlug);
      if (t) {
        setCapabilityPacks(t.default_capability_packs);
        setTriggers(t.default_trigger_subscriptions ?? []);
        setName(t.name);
        setSlug(t.slug);
        // Task 4.7 — pre-check bundled skills whose slug matches the
        // template's default_capability_packs entries. Each capability-pack
        // bundled skill was seeded with slug === pack.slug (see
        // seed-bundled-skills.ts), so slug is an exact key.
        const defaults = new Set(t.default_capability_packs ?? []);
        const preselected = skillsCatalog
          .filter((s) => s.source === 'bundled' && defaults.has(s.slug))
          .map((s) => s.id);
        setSelectedSkillIds(preselected);
      }
    },
    [config, skillsCatalog],
  );

  const onTogglePack = useCallback((s: string) => {
    setCapabilityPacks((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    );
  }, []);

  const onToggleSkill = useCallback((id: string) => {
    setSelectedSkillIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  const onToggleTrigger = useCallback((s: string) => {
    setTriggers((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  }, []);

  // ─── Deploy submission ───
  const onDeploy = useCallback(async () => {
    setError(null);
    const payload: any = {
      template_slug: templateSlug,
      name,
      slug,
      capability_packs: capabilityPacks,
      // Task 4.7 — ship selected skill ids. The backend inserts one row per
      // skill into agent_employee_skills and unions the skills' derived
      // capability_packs into the employee column.
      skill_ids: selectedSkillIds,
      capability_pack_secrets: packSecrets,
      provider,
      trigger_subscriptions: triggers,
      trust_level: trustLevel,
    };
    if (provider === 'byo') {
      payload.byo_connection_url = byoConnectionUrl;
      payload.byo_gateway_token = byoGatewayToken;
    }
    if (provider === 'railway') {
      payload.integration_id = selectedIntegrationId;
    }
    // Phase 12 review fix — backend now requires a non-empty key. Guard
    // here so the user gets an inline error rather than a 400 roundtrip.
    if (!anthropicKey.trim()) {
      setError('Anthropic API key is required. Paste a BYOK key to continue.');
      return;
    }
    payload.anthropic_api_key = anthropicKey.trim();

    const res = await api.fetch('/api/agents/deploy/start', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(`${body.error ?? 'Deploy failed'}${body.code ? ` (${body.code})` : ''}`);
      return;
    }
    const body = await res.json();
    setEmployeeId(body.employee_id);
    setStep(5);
  }, [
    templateSlug,
    name,
    slug,
    capabilityPacks,
    selectedSkillIds,
    packSecrets,
    provider,
    selectedIntegrationId,
    byoConnectionUrl,
    byoGatewayToken,
    triggers,
    trustLevel,
    anthropicKey,
  ]);

  // ─── Poll provisioning status ───
  useEffect(() => {
    if (step !== 5 || !employeeId) return;
    let cancelled = false;
    const tick = async () => {
      const res = await api.fetch(`/api/agents/deploy/${employeeId}/status`);
      if (cancelled || !res.ok) return;
      const body = await res.json();
      const status = body.employee?.connection_status;
      if (!status) return;
      setProvisionStatus(status);
      setConnectionUrl(body.employee?.connection_url ?? null);
      setConnectionError(body.employee?.connection_error ?? null);
      if (status === 'connected' || status === 'error') {
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
      }
    };
    void tick();
    pollTimerRef.current = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [step, employeeId]);

  // ─── Run handshake ───
  const onHandshake = useCallback(async () => {
    if (!employeeId) return;
    setHandshakeStatus('running');
    setHandshakeError(null);
    const res = await api.fetch(`/api/agents/deploy/${employeeId}/handshake`, {
      method: 'POST',
    });
    const body = await res.json();
    if (body.success) {
      setHandshakeStatus('success');
      setHandshakeModels(body.models ?? []);
    } else {
      setHandshakeStatus('failed');
      setHandshakeError(body.error ?? 'Unknown error');
    }
  }, [employeeId]);

  // ─── When provisioning flips to connected, auto-advance to handshake step ───
  useEffect(() => {
    if (step === 5 && provisionStatus === 'connected') {
      setStep(6);
      void onHandshake();
    }
  }, [step, provisionStatus, onHandshake]);

  // ─── Step progression guards ───
  const canGoNext = useCallback((): boolean => {
    if (step === 1) return !!templateSlug;
    if (step === 2) return capabilityPacks.length > 0;
    if (step === 3) {
      if (!provider) return false;
      if (provider === 'byo') return byoConnectionUrl.length > 0 && byoGatewayToken.length > 0;
      if (provider === 'railway') return !!selectedIntegrationId;
      return false;
    }
    if (step === 4) return true; // triggers optional
    return true;
  }, [step, templateSlug, capabilityPacks, provider, byoConnectionUrl, byoGatewayToken, selectedIntegrationId]);

  if (loading) {
    return (
      <div className="p-8">
        <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
          Loading wizard…
        </p>
      </div>
    );
  }
  if (!config) {
    return (
      <div className="p-8">
        <p className="text-[13px]" style={{ color: '#ef4444' }}>
          Failed to load wizard config
        </p>
      </div>
    );
  }

  const defaultPacksForTemplate =
    config.templates.find((t) => t.slug === templateSlug)?.default_capability_packs ?? [];

  return (
    <div className="max-w-3xl mx-auto p-6" data-testid="deploy-wizard">
      <div className="mb-6 flex items-center justify-between">
        <h2
          className="text-[20px] font-semibold"
          style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
        >
          Deploy new employee
        </h2>
        <div className="text-[12px]" style={{ color: 'var(--muted)' }}>
          Step {step} of 7
        </div>
      </div>

      {/* Progress dots */}
      <div className="flex gap-1 mb-8">
        {[1, 2, 3, 4, 5, 6, 7].map((n) => (
          <div
            key={n}
            className="flex-1 h-1 rounded-full"
            style={{
              background: n <= step ? 'var(--accent)' : 'var(--surface-container)',
            }}
          />
        ))}
      </div>

      {error && (
        <div
          className="mb-4 p-3 rounded-lg text-[12px]"
          style={{
            background: 'rgba(239,68,68,0.1)',
            color: '#ef4444',
            border: '1px solid rgba(239,68,68,0.3)',
          }}
        >
          {error}
        </div>
      )}

      {step === 1 && (
        <RolePicker
          templates={config.templates}
          selected={templateSlug}
          onSelect={onSelectTemplate}
          name={name}
          slug={slug}
          onNameChange={setName}
          onSlugChange={setSlug}
        />
      )}
      {step === 2 && (
        <>
          <SkillPicker
            skills={skillsCatalog}
            selected={selectedSkillIds}
            onToggle={onToggleSkill}
          />
          <div className="mt-6">
            <CapabilityPicker
              packs={config.capability_packs}
              selected={capabilityPacks}
              secrets={packSecrets}
              onToggle={onTogglePack}
              onSecretChange={(env, v) =>
                setPackSecrets((prev) => ({ ...prev, [env]: v }))
              }
            />
          </div>
        </>
      )}
      {step === 3 && (
        <ProviderPicker
          providers={config.providers}
          integrations={integrations}
          selected={provider}
          selectedIntegrationId={selectedIntegrationId}
          byoConnectionUrl={byoConnectionUrl}
          byoGatewayToken={byoGatewayToken}
          onSelect={setProvider}
          onSelectIntegration={setSelectedIntegrationId}
          onByoUrlChange={setByoConnectionUrl}
          onByoTokenChange={setByoGatewayToken}
          apiBaseUrl={apiUrl}
        />
      )}
      {step === 4 && (
        <>
          <TriggerConfig
            selected={triggers}
            defaults={defaultPacksForTemplate}
            onToggle={onToggleTrigger}
          />
          <div className="mt-6">
            <label
              className="block text-[12px] font-medium mb-2"
              style={{ color: 'var(--foreground)' }}
            >
              Anthropic API key
              <span style={{ color: '#ef4444' }}> *</span>
            </label>
            <input
              type="password"
              autoComplete="off"
              value={anthropicKey}
              onChange={(e) => setAnthropicKey(e.target.value)}
              placeholder="sk-ant-api03-…"
              className="w-full px-3 py-2 rounded-lg text-[13px]"
              style={{
                background: 'var(--surface-container)',
                color: 'var(--foreground)',
                border: '1px solid var(--border)',
              }}
              data-testid="wizard-anthropic-key"
            />
            <p
              className="mt-2 text-[11px]"
              style={{ color: 'var(--muted)' }}
            >
              Required. The deployed employee uses your own key — Deft never
              bills against our server key for your agent's usage.
            </p>
          </div>
        </>
      )}
      {step === 5 && (
        <ProvisionProgress
          status={provisionStatus}
          connectionUrl={connectionUrl}
          connectionError={connectionError}
          provider={provider ?? 'byo'}
        />
      )}
      {step === 6 && (
        <Handshake
          status={handshakeStatus}
          error={handshakeError}
          models={handshakeModels}
          onRetry={onHandshake}
        />
      )}
      {step === 7 && <ApprovalSummary trustLevel={trustLevel} />}

      <div className="mt-8 flex justify-between">
        <button
          type="button"
          onClick={() => setStep((s) => (s > 1 ? ((s - 1) as Step) : s))}
          disabled={step === 1 || step === 5}
          className="px-4 py-2 rounded-lg text-[12px] font-medium"
          style={{
            background: 'var(--surface-container)',
            color: 'var(--foreground)',
            border: '1px solid var(--border)',
            opacity: step === 1 || step === 5 ? 0.4 : 1,
          }}
        >
          Back
        </button>
        {step < 4 && (
          <button
            type="button"
            disabled={!canGoNext()}
            onClick={() => setStep((s) => (s + 1) as Step)}
            className="px-4 py-2 rounded-lg text-[12px] font-medium"
            style={{
              background: 'var(--accent)',
              color: 'white',
              opacity: canGoNext() ? 1 : 0.4,
            }}
            data-testid="wizard-next"
          >
            Next
          </button>
        )}
        {step === 4 && (
          <button
            type="button"
            onClick={() => void onDeploy()}
            disabled={anthropicKey.trim().length === 0}
            data-testid="wizard-deploy"
            className="px-4 py-2 rounded-lg text-[12px] font-medium"
            style={{
              background: 'var(--accent)',
              color: 'white',
              opacity: anthropicKey.trim().length > 0 ? 1 : 0.4,
            }}
          >
            Deploy
          </button>
        )}
        {step === 6 && (
          <button
            type="button"
            disabled={handshakeStatus !== 'success'}
            onClick={() => setStep(7)}
            className="px-4 py-2 rounded-lg text-[12px] font-medium"
            style={{
              background: 'var(--accent)',
              color: 'white',
              opacity: handshakeStatus === 'success' ? 1 : 0.4,
            }}
          >
            Continue
          </button>
        )}
        {step === 7 && (
          <button
            type="button"
            onClick={() => router.push('/settings/agent')}
            data-testid="wizard-finish"
            className="px-4 py-2 rounded-lg text-[12px] font-medium"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            Deploy complete — Finish
          </button>
        )}
      </div>
    </div>
  );
}
