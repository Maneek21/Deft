'use client';

/**
 * Phase 4 Task 4.13 — /skills library page.
 *
 * Three tabs: Bundled / Marketplace / Your org. Each card shows icon, name,
 * description, source badge, and (lazily loaded) install + attach counts.
 * Card actions: View (→ detail page), Install (prompts for agent),
 * Attach (prompts for project), Fork (copy into Your org tier).
 *
 * Marketplace tab carries an "Import from URL" button that posts to
 * POST /api/skills/import.
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import {
  Loader2,
  Plus,
  Sparkles,
  Store,
  Building2,
  Download,
  GitFork,
  Eye,
  AlertTriangle,
  X,
} from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { TabStrip } from '@/components/tab-strip';

type SourceTab = 'bundled' | 'marketplace' | 'org';

type SkillAgentConfig = {
  tools?: string[];
  capability_packs?: string[];
  triggers?: string[];
  system_prompt_addition?: string;
};

type Skill = {
  id: string;
  org_id: string | null;
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  source: 'bundled' | 'marketplace' | 'org';
  version: string;
  agent_config: SkillAgentConfig | null;
  project_config: Record<string, unknown> | null;
  source_url: string | null;
  created_at: string;
};

type SkillStats = { installed_on_agents: number; attached_to_projects: number };

type AgentEmployee = {
  id: string;
  name: string;
  avatar_url: string | null;
};

const SOURCE_LABEL: Record<SourceTab, string> = {
  bundled: 'Bundled',
  marketplace: 'Marketplace',
  org: 'Your org',
};

const SOURCE_ICON: Record<SourceTab, typeof Sparkles> = {
  bundled: Sparkles,
  marketplace: Store,
  org: Building2,
};

/**
 * v1 token heuristic: ~1 token per 4 chars of prompt, plus ~50 tokens per
 * tool. The skill-library detail view surfaces this as "~N tokens on each
 * invocation"; refine as trusted testers report real observed usage.
 */
function estimatedTokens(skill: Pick<Skill, 'agent_config'>): number {
  const cfg = skill.agent_config ?? {};
  const promptLen = cfg.system_prompt_addition?.length ?? 0;
  const toolCount = cfg.tools?.length ?? 0;
  return Math.round(promptLen / 4 + toolCount * 50);
}

function sourceBadgeStyle(src: SourceTab) {
  const bg =
    src === 'bundled'
      ? 'rgba(139,92,246,0.12)'
      : src === 'marketplace'
        ? 'rgba(59,130,246,0.12)'
        : 'rgba(16,185,129,0.12)';
  const color =
    src === 'bundled'
      ? '#8B5CF6'
      : src === 'marketplace'
        ? '#3B82F6'
        : '#10B981';
  return { background: bg, color };
}

export default function SkillsPage() {
  const [tab, setTab] = useState<SourceTab>('bundled');
  const [skills, setSkills] = useState<Skill[]>([]);
  const [statsById, setStatsById] = useState<Record<string, SkillStats>>({});
  const [loading, setLoading] = useState(true);

  const [agents, setAgents] = useState<AgentEmployee[]>([]);

  const [installSkill, setInstallSkill] = useState<Skill | null>(null);
  const [forking, setForking] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadSkills = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/api/skills');
      if (res.ok) {
        const all: Skill[] = await res.json();
        setSkills(all);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  useEffect(() => {
    // Supporting data for the install modal.
    (async () => {
      const empRes = await api.get('/api/agent-employees');
      if (empRes.ok) setAgents(await empRes.json());
    })();
  }, []);

  const visible = useMemo(
    () => skills.filter((s) => s.source === tab),
    [skills, tab],
  );

  // Lazily hydrate stats only for skills that land on screen.
  useEffect(() => {
    const missing = visible.filter((s) => !(s.id in statsById));
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      const results = await Promise.all(
        missing.map(async (s) => {
          try {
            const r = await api.get(`/api/skills/${encodeURIComponent(s.slug)}/stats`);
            if (r.ok) return [s.id, (await r.json()) as SkillStats] as const;
          } catch {
            /* swallow */
          }
          return [s.id, { installed_on_agents: 0, attached_to_projects: 0 }] as const;
        }),
      );
      if (cancelled) return;
      setStatsById((prev) => {
        const next = { ...prev };
        for (const [id, stats] of results) next[id] = stats;
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, statsById]);

  const handleFork = async (skill: Skill) => {
    setForking(skill.id);
    setActionError(null);
    try {
      const res = await api.post('/api/skills', {
        name: `${skill.name} (fork)`,
        slug: `${skill.slug}-fork-${Date.now().toString(36).slice(-4)}`,
        description: skill.description,
        icon: skill.icon,
        agent_config: skill.agent_config ?? {},
        project_config: skill.project_config ?? {},
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setActionError(j?.error ?? 'Fork failed');
        return;
      }
      await loadSkills();
      setTab('org');
    } finally {
      setForking(null);
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader
        title="Skills"
        description="Reusable bundles you can install on agents."
        primary={
          tab === 'org' ? (
            <Link
              href="/skills/new"
              className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium"
              style={{ background: 'var(--accent)', color: 'white' }}
            >
              <Plus className="w-4 h-4" />
              New skill
            </Link>
          ) : undefined
        }
        secondary={
          <TabStrip>
            {(Object.keys(SOURCE_LABEL) as SourceTab[]).map((t) => {
              const Icon = SOURCE_ICON[t];
              const active = tab === t;
              const count = skills.filter((s) => s.source === t).length;
              return (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className="flex items-center gap-2 px-3 py-2 text-sm border-b-2 flex-shrink-0"
                  style={{
                    borderColor: active ? 'var(--accent)' : 'transparent',
                    color: active ? 'var(--foreground)' : 'var(--foreground-secondary)',
                  }}
                >
                  <Icon className="w-4 h-4" />
                  {SOURCE_LABEL[t]}
                  <span
                    className="text-xs px-1.5 py-0.5 rounded"
                    style={{
                      background: 'var(--surface-container)',
                      color: 'var(--foreground-secondary)',
                    }}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </TabStrip>
        }
        compact
      />

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        ) : visible.length === 0 ? (
          <div
            className="text-center py-20 text-sm"
            style={{ color: 'var(--foreground-secondary)' }}
          >
            {tab === 'marketplace'
              ? 'No marketplace skills yet. Import one with a URL.'
              : tab === 'org'
                ? 'Your org has no custom skills yet.'
                : 'No bundled skills found.'}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {visible.map((skill) => {
              const stats =
                statsById[skill.id] ?? {
                  installed_on_agents: 0,
                  attached_to_projects: 0,
                };
              const tokens = estimatedTokens(skill);
              return (
                <div
                  key={skill.id}
                  className="rounded-lg p-4 flex flex-col gap-3"
                  style={{
                    background: 'var(--surface-container)',
                    border: '1px solid var(--border-default)',
                  }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-3">
                      <div
                        className="w-10 h-10 rounded-lg flex items-center justify-center text-lg flex-shrink-0"
                        style={{ background: 'var(--surface)' }}
                      >
                        {skill.icon || skill.name.slice(0, 1).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="font-semibold text-sm">{skill.name}</div>
                        <div
                          className="text-xs mt-0.5"
                          style={{ color: 'var(--foreground-secondary)' }}
                        >
                          v{skill.version} · /{skill.slug}
                        </div>
                      </div>
                    </div>
                    <span
                      className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold"
                      style={sourceBadgeStyle(skill.source)}
                    >
                      {skill.source}
                    </span>
                  </div>

                  <p
                    className="text-xs line-clamp-3 min-h-[48px]"
                    style={{ color: 'var(--foreground-secondary)' }}
                  >
                    {skill.description || 'No description.'}
                  </p>

                  <div
                    className="flex items-center gap-3 text-xs"
                    style={{ color: 'var(--foreground-secondary)' }}
                  >
                    <span>
                      Installed on <b>{stats.installed_on_agents}</b> agent
                      {stats.installed_on_agents === 1 ? '' : 's'}
                    </span>
                  </div>

                  {tokens > 0 && (
                    <div
                      className="text-[11px]"
                      style={{ color: 'var(--foreground-secondary)' }}
                    >
                      ~{tokens} tokens per invocation
                    </div>
                  )}

                  <div className="flex items-center gap-2 mt-auto">
                    <Link
                      href={`/skills/${encodeURIComponent(skill.slug)}`}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium"
                      style={{
                        background: 'var(--surface)',
                        border: '1px solid var(--border-default)',
                      }}
                    >
                      <Eye className="w-3 h-3" />
                      View
                    </Link>
                    <button
                      onClick={() => {
                        setActionError(null);
                        setInstallSkill(skill);
                      }}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium"
                      style={{
                        background: 'var(--accent)',
                        color: 'white',
                      }}
                    >
                      <Download className="w-3 h-3" />
                      Install
                    </button>
                    {skill.source !== 'org' && (
                      <button
                        onClick={() => handleFork(skill)}
                        disabled={forking === skill.id}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium ml-auto"
                        style={{
                          background: 'var(--surface)',
                          border: '1px solid var(--border-default)',
                          opacity: forking === skill.id ? 0.6 : 1,
                        }}
                      >
                        <GitFork className="w-3 h-3" />
                        Fork
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {actionError && (
          <div
            className="fixed bottom-6 right-6 px-4 py-3 rounded-lg text-sm"
            style={{
              background: 'var(--status-red)',
              color: 'white',
            }}
          >
            {actionError}
          </div>
        )}
      </div>

      {/* Install modal */}
      {installSkill && (
        <InstallModal
          skill={installSkill}
          agents={agents}
          onClose={() => setInstallSkill(null)}
          onDone={async () => {
            setInstallSkill(null);
            // Refresh stats for this skill.
            try {
              const r = await api.get(
                `/api/skills/${encodeURIComponent(installSkill.slug)}/stats`,
              );
              if (r.ok) {
                const s: SkillStats = await r.json();
                setStatsById((prev) => ({ ...prev, [installSkill.id]: s }));
              }
            } catch {
              /* ignore */
            }
          }}
          onError={setActionError}
        />
      )}

    </div>
  );
}

// ─── Install modal ────────────────────────────────────────────────────
function InstallModal({
  skill,
  agents,
  onClose,
  onDone,
  onError,
}: {
  skill: Skill;
  agents: AgentEmployee[];
  onClose: () => void;
  onDone: () => void;
  onError: (msg: string) => void;
}) {
  const [agentId, setAgentId] = useState<string | null>(agents[0]?.id ?? null);
  const [accepted, setAccepted] = useState(skill.source !== 'marketplace');
  const [busy, setBusy] = useState(false);

  const capabilities = [
    ...(skill.agent_config?.capability_packs ?? []),
    ...(skill.agent_config?.tools ?? []),
  ];

  const handleInstall = async () => {
    if (!agentId) return;
    setBusy(true);
    try {
      const res = await api.post(`/api/skills/${skill.id}/install`, {
        agent_employee_id: agentId,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        onError(j?.error ?? 'Install failed');
        return;
      }
      onDone();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)' }}
    >
      <div
        className="w-full max-w-md mx-4 rounded-xl p-5 space-y-3"
        style={{
          background: 'var(--surface-container)',
          border: '1px solid var(--border-default)',
        }}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Install {skill.name}</h2>
          <button onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>

        {skill.source === 'marketplace' && (
          <div
            className="p-3 rounded text-xs space-y-2"
            style={{
              background: 'rgba(245,158,11,0.1)',
              border: '1px solid rgba(245,158,11,0.3)',
            }}
          >
            <div className="flex items-center gap-2 font-medium">
              <AlertTriangle className="w-3 h-3" />
              This is a third-party marketplace skill.
            </div>
            <div>
              It can:{' '}
              {capabilities.length > 0
                ? capabilities.join(', ')
                : 'extend agent behaviour via prompt additions'}
              .
            </div>
            <label className="flex items-center gap-2 mt-2 cursor-pointer">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
              />
              I understand and want to install this.
            </label>
          </div>
        )}

        <label className="block text-xs font-medium">Install on agent</label>
        <select
          value={agentId ?? ''}
          onChange={(e) => setAgentId(e.target.value)}
          className="w-full px-3 py-2 rounded-md text-sm"
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border-default)',
          }}
        >
          <option value="">— select an agent —</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded text-sm"
            style={{ background: 'var(--surface)' }}
          >
            Cancel
          </button>
          <button
            onClick={handleInstall}
            disabled={!agentId || !accepted || busy}
            className="px-3 py-1.5 rounded text-sm font-medium"
            style={{
              background: 'var(--accent)',
              color: 'white',
              opacity: !agentId || !accepted || busy ? 0.6 : 1,
            }}
          >
            {busy ? 'Installing…' : 'Install'}
          </button>
        </div>
      </div>
    </div>
  );
}

