'use client';

/**
 * Phase 4 Task 4.13 — /skills/[slug] detail page.
 *
 * Renders the canonical skill (org > bundled > marketplace) with:
 *   - editable agent_config + project_config JSON for `source=org`,
 *   - read-only view for bundled + marketplace,
 *   - "Retry install" button wired to the agent-employees retry endpoint
 *     when the page is visited with `?retry_employee_id=...`,
 *   - context-bloat indicator (~N tokens) for installed skills.
 */
import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';
import {
  ArrowLeft,
  Loader2,
  AlertTriangle,
  RefreshCw,
  Save,
  Trash2,
  Info,
} from 'lucide-react';

type Skill = {
  id: string;
  org_id: string | null;
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  source: 'bundled' | 'marketplace' | 'org';
  version: string;
  agent_config: Record<string, unknown> | null;
  project_config: Record<string, unknown> | null;
  source_url: string | null;
  created_at: string;
  updated_at?: string;
};

type SkillStats = {
  installed_on_agents: number;
  attached_to_projects: number;
};

function estimatedTokens(agentConfig: Record<string, unknown> | null): number {
  if (!agentConfig) return 0;
  const promptAdd = (agentConfig.system_prompt_addition as string | undefined) ?? '';
  const tools = (agentConfig.tools as string[] | undefined) ?? [];
  return Math.round(promptAdd.length / 4 + tools.length * 50);
}

export default function SkillDetailPage() {
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const retryEmployeeId = searchParams.get('retry_employee_id');

  const slug = params?.slug ?? '';

  const [skill, setSkill] = useState<Skill | null>(null);
  const [stats, setStats] = useState<SkillStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [agentConfigText, setAgentConfigText] = useState('{}');
  const [projectConfigText, setProjectConfigText] = useState('{}');
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [retrying, setRetrying] = useState(false);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    (async () => {
      setLoading(true);
      try {
        const [skillRes, statsRes] = await Promise.all([
          api.get(`/api/skills/${encodeURIComponent(slug)}`),
          api.get(`/api/skills/${encodeURIComponent(slug)}/stats`),
        ]);
        if (!skillRes.ok) {
          setNotFound(true);
          return;
        }
        const s: Skill = await skillRes.json();
        setSkill(s);
        setName(s.name);
        setDescription(s.description ?? '');
        setAgentConfigText(JSON.stringify(s.agent_config ?? {}, null, 2));
        setProjectConfigText(JSON.stringify(s.project_config ?? {}, null, 2));
        if (statsRes.ok) setStats(await statsRes.json());
      } finally {
        setLoading(false);
      }
    })();
  }, [slug]);

  const isEditable = skill?.source === 'org';
  const tokens = useMemo(() => estimatedTokens(skill?.agent_config ?? null), [skill]);

  const handleSave = async () => {
    if (!skill) return;
    setEditError(null);
    setSaving(true);
    setSaved(false);
    try {
      let agentParsed: Record<string, unknown>;
      let projectParsed: Record<string, unknown>;
      try {
        agentParsed = JSON.parse(agentConfigText);
        projectParsed = JSON.parse(projectConfigText);
      } catch (err) {
        setEditError(`Invalid JSON: ${(err as Error).message}`);
        return;
      }
      const res = await api.patch(`/api/skills/${skill.id}`, {
        name,
        description: description || null,
        agent_config: agentParsed,
        project_config: projectParsed,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setEditError(j?.error ?? 'Failed to save');
        return;
      }
      const updated: Skill = await res.json();
      setSkill(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!skill) return;
    if (!window.confirm(`Delete ${skill.name}? Installs will be preserved but no new agents can add it.`)) return;
    const res = await api.delete(`/api/skills/${skill.id}`);
    if (res.ok) router.push('/skills');
  };

  const handleRetryProvision = async () => {
    if (!retryEmployeeId) return;
    setRetrying(true);
    setRetryMessage(null);
    try {
      const res = await api.post(
        `/api/agent-employees/${retryEmployeeId}/retry-provision`,
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRetryMessage(j?.error ?? 'Retry failed');
      } else {
        setRetryMessage('Provisioning re-enqueued. Check the agent status in a moment.');
      }
    } finally {
      setRetrying(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }

  if (notFound || !skill) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3">
        <p className="text-sm">Skill not found.</p>
        <Link
          href="/skills"
          className="text-sm underline"
          style={{ color: 'var(--accent)' }}
        >
          Back to skills
        </Link>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto p-6 space-y-6">
        <div className="flex items-center gap-2 text-sm">
          <Link
            href="/skills"
            className="flex items-center gap-1"
            style={{ color: 'var(--foreground-secondary)' }}
          >
            <ArrowLeft className="w-3 h-3" />
            All skills
          </Link>
        </div>

        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div
              className="w-12 h-12 rounded-lg flex items-center justify-center text-xl"
              style={{ background: 'var(--surface-container)' }}
            >
              {skill.icon || skill.name.slice(0, 1).toUpperCase()}
            </div>
            <div>
              <h1 className="text-xl font-semibold">{skill.name}</h1>
              <p
                className="text-xs mt-0.5"
                style={{ color: 'var(--foreground-secondary)' }}
              >
                {skill.source} · v{skill.version} · /{skill.slug}
              </p>
            </div>
          </div>
          {isEditable && (
            <button
              onClick={handleDelete}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs"
              style={{
                background: 'var(--surface-container)',
                border: '1px solid var(--border-default)',
                color: 'var(--status-red)',
              }}
            >
              <Trash2 className="w-3 h-3" />
              Delete
            </button>
          )}
        </div>

        {/* Stats + token indicator */}
        <div
          className="rounded-lg p-4 grid grid-cols-3 gap-4 text-sm"
          style={{
            background: 'var(--surface-container)',
            border: '1px solid var(--border-default)',
          }}
        >
          <div>
            <div
              className="text-xs"
              style={{ color: 'var(--foreground-secondary)' }}
            >
              Installed on
            </div>
            <div className="font-semibold">
              {stats?.installed_on_agents ?? 0} agents
            </div>
          </div>
          <div>
            <div
              className="text-xs"
              style={{ color: 'var(--foreground-secondary)' }}
            >
              Attached to
            </div>
            <div className="font-semibold">
              {stats?.attached_to_projects ?? 0} projects
            </div>
          </div>
          <div>
            <div
              className="text-xs"
              style={{ color: 'var(--foreground-secondary)' }}
            >
              Est. tokens per invocation
            </div>
            <div className="font-semibold">~{tokens}</div>
          </div>
        </div>

        {(stats?.installed_on_agents ?? 0) > 5 && (
          <div
            className="flex items-start gap-2 p-3 rounded text-xs"
            style={{
              background: 'rgba(245,158,11,0.12)',
              border: '1px solid rgba(245,158,11,0.3)',
            }}
          >
            <Info className="w-3 h-3 mt-0.5 flex-shrink-0" />
            <div>
              ~{tokens * (stats?.installed_on_agents ?? 0)} tokens total across installs.
              Consider uninstalling this skill from agents that don't need it to
              reduce context bloat.
            </div>
          </div>
        )}

        {/* Retry provision banner (only when redirected from a pending install) */}
        {retryEmployeeId && (
          <div
            className="flex items-start gap-3 p-3 rounded text-xs"
            style={{
              background: 'rgba(59,130,246,0.1)',
              border: '1px solid rgba(59,130,246,0.3)',
            }}
          >
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <div className="flex-1 space-y-2">
              <div>
                The last install left this agent in{' '}
                <code>connection_status=pending</code>. The sidecar may have
                missed the capability pack update.
              </div>
              <button
                onClick={handleRetryProvision}
                disabled={retrying}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded font-medium"
                style={{
                  background: 'var(--accent)',
                  color: 'white',
                  opacity: retrying ? 0.6 : 1,
                }}
              >
                <RefreshCw
                  className={`w-3 h-3 ${retrying ? 'animate-spin' : ''}`}
                />
                Retry install
              </button>
              {retryMessage && <div>{retryMessage}</div>}
            </div>
          </div>
        )}

        {/* Description */}
        <section>
          <label
            className="text-xs font-medium uppercase tracking-wider mb-1 block"
            style={{ color: 'var(--foreground-secondary)' }}
          >
            Description
          </label>
          {isEditable ? (
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 rounded-md text-sm"
              style={{
                background: 'var(--surface-container)',
                border: '1px solid var(--border-default)',
              }}
            />
          ) : (
            <p className="text-sm">{skill.description || '—'}</p>
          )}
        </section>

        {isEditable && (
          <section>
            <label
              className="text-xs font-medium uppercase tracking-wider mb-1 block"
              style={{ color: 'var(--foreground-secondary)' }}
            >
              Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 rounded-md text-sm"
              style={{
                background: 'var(--surface-container)',
                border: '1px solid var(--border-default)',
              }}
            />
          </section>
        )}

        {/* Agent config */}
        <section>
          <label
            className="text-xs font-medium uppercase tracking-wider mb-1 block"
            style={{ color: 'var(--foreground-secondary)' }}
          >
            Agent config (tools, capability packs, triggers, prompt)
          </label>
          <textarea
            value={agentConfigText}
            onChange={(e) => setAgentConfigText(e.target.value)}
            readOnly={!isEditable}
            rows={10}
            className="w-full px-3 py-2 rounded-md text-xs font-mono"
            style={{
              background: 'var(--surface-container)',
              border: '1px solid var(--border-default)',
              opacity: isEditable ? 1 : 0.8,
            }}
          />
        </section>

        {/* Project config */}
        <section>
          <label
            className="text-xs font-medium uppercase tracking-wider mb-1 block"
            style={{ color: 'var(--foreground-secondary)' }}
          >
            Project config (statuses, vocab, custom fields, templates)
          </label>
          <textarea
            value={projectConfigText}
            onChange={(e) => setProjectConfigText(e.target.value)}
            readOnly={!isEditable}
            rows={10}
            className="w-full px-3 py-2 rounded-md text-xs font-mono"
            style={{
              background: 'var(--surface-container)',
              border: '1px solid var(--border-default)',
              opacity: isEditable ? 1 : 0.8,
            }}
          />
        </section>

        {skill.source === 'marketplace' && skill.source_url && (
          <section>
            <label
              className="text-xs font-medium uppercase tracking-wider mb-1 block"
              style={{ color: 'var(--foreground-secondary)' }}
            >
              Imported from
            </label>
            <a
              href={skill.source_url}
              target="_blank"
              rel="noreferrer"
              className="text-sm underline"
              style={{ color: 'var(--accent)' }}
            >
              {skill.source_url}
            </a>
          </section>
        )}

        {!isEditable && (
          <p
            className="text-xs italic"
            style={{ color: 'var(--foreground-secondary)' }}
          >
            Bundled and marketplace skills are read-only. Fork to customize.
          </p>
        )}

        {isEditable && (
          <div className="flex items-center justify-end gap-2">
            {editError && (
              <div
                className="text-xs flex items-center gap-1"
                style={{ color: 'var(--status-red)' }}
              >
                <AlertTriangle className="w-3 h-3" />
                {editError}
              </div>
            )}
            {saved && (
              <div
                className="text-xs"
                style={{ color: 'var(--status-green)' }}
              >
                Saved
              </div>
            )}
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1 px-3 py-1.5 rounded text-sm font-medium"
              style={{
                background: 'var(--accent)',
                color: 'white',
                opacity: saving ? 0.6 : 1,
              }}
            >
              <Save className="w-3 h-3" />
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
