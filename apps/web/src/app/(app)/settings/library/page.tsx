'use client';

import { useState, useEffect, useCallback } from 'react';
import useSWR from 'swr';
import { Loader2, Layers, FileStack, X, ChevronRight, CheckCircle2, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page-header';

const fetcher = async (url: string) => {
  const res = await api.get(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
};

type Skill = {
  id: string;
  name: string;
  slug: string;
  source: string;
  version?: string | null;
  description: string | null;
  agent_config?: {
    tools?: string[];
    capability_packs?: string[];
    triggers?: string[];
    system_prompt_addition?: string;
    [key: string]: unknown;
  } | null;
};

type TemplateTask = {
  title: string;
  due_offset_days?: number;
  description?: string;
  status?: string;
  priority?: string;
};

type Template = {
  id: string;
  name: string;
  slug?: string;
  source?: string;
  org_id?: string | null;
  description: string | null;
  tasks: TemplateTask[];
};

type Project = {
  id: string;
  name: string;
  prefix?: string;
};

// ─── Toast ────────────────────────────────────────────────────────────────────

function Toast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 4000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] flex items-center gap-2 px-4 py-2.5 rounded-lg text-[13px] font-medium text-white shadow-lg"
      style={{ background: 'var(--accent)', fontFamily: 'var(--font-body)' }}
    >
      <CheckCircle2 size={15} />
      {message}
    </div>
  );
}

// ─── Skill Detail Modal ───────────────────────────────────────────────────────

function SkillDetailModal({ skill, onClose }: { skill: Skill; onClose: () => void }) {
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const cfg = skill.agent_config;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={onClose}
    >
      <div
        className="w-[calc(100vw-2rem)] max-w-[520px] max-h-[85vh] flex flex-col rounded-xl"
        style={{
          background: 'var(--card-bg)',
          border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-lg)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-start justify-between px-5 py-4 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <div className="flex-1 min-w-0 pr-3">
            <div className="flex items-center gap-2 flex-wrap">
              <h2
                className="text-[15px] font-semibold"
                style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
              >
                {skill.name}
              </h2>
              <span
                className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full"
                style={{
                  background: 'var(--surface-container)',
                  color: 'var(--text-tertiary)',
                  border: '1px solid var(--border-default)',
                }}
              >
                {skill.source}
              </span>
              {skill.version && (
                <span
                  className="text-[10px] font-medium"
                  style={{ color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}
                >
                  v{skill.version}
                </span>
              )}
            </div>
            <div
              className="text-[11px] mt-0.5"
              style={{ color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}
            >
              {skill.slug}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-md flex-shrink-0"
            style={{ color: 'var(--muted)' }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">
          {/* Description */}
          {skill.description && (
            <div>
              <div
                className="text-[11px] font-semibold uppercase tracking-wide mb-1"
                style={{ color: 'var(--text-tertiary)' }}
              >
                Description
              </div>
              <p className="text-[13px]" style={{ color: 'var(--foreground-secondary)' }}>
                {skill.description}
              </p>
            </div>
          )}

          {/* Tools */}
          {cfg?.tools && cfg.tools.length > 0 && (
            <div>
              <div
                className="text-[11px] font-semibold uppercase tracking-wide mb-1"
                style={{ color: 'var(--text-tertiary)' }}
              >
                Tools ({cfg.tools.length})
              </div>
              <div className="flex flex-wrap gap-1.5">
                {cfg.tools.map((tool) => (
                  <span
                    key={tool}
                    className="text-[11px] px-2 py-0.5 rounded-md"
                    style={{
                      background: 'var(--surface-container)',
                      color: 'var(--foreground)',
                      border: '1px solid var(--border)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {tool}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Capability packs */}
          {cfg?.capability_packs && cfg.capability_packs.length > 0 && (
            <div>
              <div
                className="text-[11px] font-semibold uppercase tracking-wide mb-1"
                style={{ color: 'var(--text-tertiary)' }}
              >
                Capability Packs
              </div>
              <div className="flex flex-wrap gap-1.5">
                {cfg.capability_packs.map((pack) => (
                  <span
                    key={pack}
                    className="text-[11px] px-2 py-0.5 rounded-md"
                    style={{
                      background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
                      color: 'var(--accent)',
                      border: '1px solid color-mix(in srgb, var(--accent) 25%, transparent)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {pack}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Triggers */}
          {cfg?.triggers && cfg.triggers.length > 0 && (
            <div>
              <div
                className="text-[11px] font-semibold uppercase tracking-wide mb-1"
                style={{ color: 'var(--text-tertiary)' }}
              >
                Triggers
              </div>
              <ul className="space-y-1">
                {cfg.triggers.map((trigger, i) => (
                  <li key={i} className="flex items-start gap-1.5">
                    <ChevronRight size={12} style={{ color: 'var(--text-tertiary)', marginTop: '2px', flexShrink: 0 }} />
                    <span className="text-[12px]" style={{ color: 'var(--foreground)' }}>
                      {trigger}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* System prompt addition */}
          {cfg?.system_prompt_addition && (
            <div>
              <div
                className="text-[11px] font-semibold uppercase tracking-wide mb-1"
                style={{ color: 'var(--text-tertiary)' }}
              >
                System Prompt Addition
              </div>
              <pre
                className="text-[11px] p-3 rounded-lg overflow-x-auto whitespace-pre-wrap break-words"
                style={{
                  background: 'var(--surface-container)',
                  color: 'var(--foreground-secondary)',
                  border: '1px solid var(--border)',
                  fontFamily: 'var(--font-mono)',
                  lineHeight: 1.6,
                }}
              >
                {cfg.system_prompt_addition}
              </pre>
            </div>
          )}

          {/* Empty config fallback */}
          {!skill.description && (!cfg || Object.keys(cfg).length === 0) && (
            <p className="text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
              No additional metadata available for this skill.
            </p>
          )}
        </div>

        {/* Footer note — install on agent is coming soon */}
        <div
          className="px-5 py-3 flex-shrink-0"
          style={{ borderTop: '1px solid var(--border)' }}
        >
          <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            Installing skills on agents is coming soon.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Template Detail + Apply Modal ───────────────────────────────────────────

function TemplateDetailModal({
  template,
  onClose,
  onApplied,
}: {
  template: Template;
  onClose: () => void;
  onApplied: (msg: string) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const loadProjects = useCallback(async () => {
    if (projects.length > 0) return;
    setProjectsLoading(true);
    try {
      const res = await api.get('/api/projects');
      if (res.ok) {
        const data = await res.json();
        setProjects(Array.isArray(data) ? data : []);
      }
    } finally {
      setProjectsLoading(false);
    }
  }, [projects.length]);

  async function applyToProject(projectId: string, projectName: string) {
    setApplying(true);
    setApplyError(null);
    try {
      const res = await api.post(`/api/projects/${projectId}/apply-template`, {
        template_id: template.id,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Failed to apply template' }));
        throw new Error(body.error ?? 'Failed to apply template');
      }
      const body = await res.json() as { count: number };
      onClose();
      onApplied(`Template applied — ${body.count} task${body.count !== 1 ? 's' : ''} created in "${projectName}"`);
    } catch (err) {
      setApplyError((err as Error).message);
    } finally {
      setApplying(false);
    }
  }

  const tasks = template.tasks ?? [];

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={onClose}
    >
      <div
        className="w-[calc(100vw-2rem)] max-w-[520px] max-h-[85vh] flex flex-col rounded-xl"
        style={{
          background: 'var(--card-bg)',
          border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-lg)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-start justify-between px-5 py-4 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <div className="flex-1 min-w-0 pr-3">
            <div className="flex items-center gap-2 flex-wrap">
              <h2
                className="text-[15px] font-semibold"
                style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
              >
                {template.name}
              </h2>
              {template.source && (
                <span
                  className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full"
                  style={{
                    background: 'var(--surface-container)',
                    color: 'var(--text-tertiary)',
                    border: '1px solid var(--border-default)',
                  }}
                >
                  {template.source}
                </span>
              )}
              <span
                className="text-[11px]"
                style={{ color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}
              >
                {tasks.length} task{tasks.length !== 1 ? 's' : ''}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-md flex-shrink-0"
            style={{ color: 'var(--muted)' }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">
          {template.description && (
            <p className="text-[13px]" style={{ color: 'var(--foreground-secondary)' }}>
              {template.description}
            </p>
          )}

          {tasks.length > 0 && (
            <div>
              <div
                className="text-[11px] font-semibold uppercase tracking-wide mb-2"
                style={{ color: 'var(--text-tertiary)' }}
              >
                Tasks
              </div>
              <ol className="space-y-1.5">
                {tasks.map((t, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span
                      className="text-[11px] font-medium mt-0.5 shrink-0 text-right"
                      style={{
                        color: 'var(--text-tertiary)',
                        fontFamily: 'var(--font-mono)',
                        minWidth: '18px',
                      }}
                    >
                      {i + 1}.
                    </span>
                    <div className="flex-1 min-w-0">
                      <span className="text-[13px]" style={{ color: 'var(--foreground)' }}>
                        {t.title}
                      </span>
                      {typeof t.due_offset_days === 'number' && (
                        <span
                          className="ml-2 text-[11px]"
                          style={{ color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}
                        >
                          +{t.due_offset_days}d
                        </span>
                      )}
                      {t.description && (
                        <div
                          className="text-[11px] mt-0.5"
                          style={{ color: 'var(--text-tertiary)' }}
                        >
                          {t.description}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="px-5 py-3 flex-shrink-0"
          style={{ borderTop: '1px solid var(--border)' }}
        >
          {applyError && (
            <p className="text-[12px] mb-2" style={{ color: 'var(--danger)' }}>
              {applyError}
            </p>
          )}

          {!showPicker ? (
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 rounded-md text-[12px] font-medium"
                style={{
                  color: 'var(--foreground-secondary)',
                  border: '1px solid var(--border)',
                  fontFamily: 'var(--font-heading)',
                }}
              >
                Close
              </button>
              <button
                type="button"
                onClick={async () => {
                  await loadProjects();
                  setShowPicker(true);
                }}
                className="px-3 py-1.5 rounded-md text-[12px] font-medium text-white"
                style={{ background: 'var(--accent)', fontFamily: 'var(--font-heading)' }}
              >
                Apply to project
              </button>
            </div>
          ) : (
            <div>
              <div
                className="text-[11px] font-semibold uppercase tracking-wide mb-2"
                style={{ color: 'var(--text-tertiary)' }}
              >
                Pick a project
              </div>
              {projectsLoading ? (
                <div className="flex items-center gap-2 py-2">
                  <Loader2 size={14} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} />
                  <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                    Loading projects…
                  </span>
                </div>
              ) : projects.length === 0 ? (
                <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                  No projects found.
                </p>
              ) : (
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {projects.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      disabled={applying}
                      onClick={() => applyToProject(p.id, p.name)}
                      className="w-full text-left px-3 py-2 rounded-lg text-[13px] transition-colors"
                      style={{
                        color: 'var(--foreground)',
                        border: '1px solid var(--border)',
                        fontFamily: 'var(--font-body)',
                        opacity: applying ? 0.6 : 1,
                      }}
                      onMouseEnter={(e) => {
                        if (!applying) e.currentTarget.style.background = 'var(--hover-tint)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      {p.prefix && (
                        <span
                          className="text-[10px] font-medium mr-1.5"
                          style={{ color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}
                        >
                          [{p.prefix}]
                        </span>
                      )}
                      {p.name}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex justify-end mt-2">
                <button
                  type="button"
                  onClick={() => setShowPicker(false)}
                  className="px-3 py-1.5 rounded-md text-[12px]"
                  style={{ color: 'var(--text-tertiary)', fontFamily: 'var(--font-body)' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Library Page ─────────────────────────────────────────────────────────────

export default function LibraryPage() {
  const [tab] = useState<'skills' | 'templates'>('templates');
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  // /api/skills returns a plain array; /api/task-templates returns { templates: [...] }.
  const { data: skillsData, error: skillsErr } = useSWR<Skill[] | { skills: Skill[] }>(
    '/api/skills',
    fetcher,
  );
  const skills: Skill[] = Array.isArray(skillsData)
    ? skillsData
    : (skillsData?.skills ?? []);

  const { data: templatesData, error: templatesErr } = useSWR<{
    templates: Template[];
  }>('/api/task-templates', fetcher);
  const templates: Template[] = templatesData?.templates ?? [];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader
        title="Templates"
        description="Turn repeatable work into ready-made task sets that can be applied to any project."
        compact
      />

      {/* Skills tab */}
      {tab === 'skills' && (
        <div className="flex-1 overflow-y-auto space-y-2 px-4 md:px-6 pb-4">
          {skillsErr && (
            <p className="text-[13px]" style={{ color: '#EF4444' }}>
              Failed to load skills.
            </p>
          )}
          {!skillsData && !skillsErr && (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} />
            </div>
          )}
          {skillsData && skills.length === 0 && (
            <div className="text-center py-12">
              <Layers size={24} style={{ color: 'var(--text-tertiary)', margin: '0 auto 8px' }} />
              <p className="text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
                No skills available.
              </p>
            </div>
          )}
          {skills.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSelectedSkill(s)}
              className="w-full text-left p-4 rounded-lg transition-colors"
              style={{
                background: 'var(--surface-container-low)',
                border: '1px solid var(--border-default)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--accent)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--border-default)';
              }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div
                    className="text-[13px] font-medium"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {s.name}
                  </div>
                  <div
                    className="text-[10px] font-semibold uppercase tracking-wide mt-0.5"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    {s.source ?? ((s as any).org_id ? 'org' : 'bundled')}
                  </div>
                </div>
                <span
                  className="text-[10px] font-medium px-2 py-0.5 rounded-full flex-shrink-0"
                  style={{
                    background:
                      s.source === 'bundled' || !(s as any).org_id
                        ? 'var(--surface-container)'
                        : 'rgba(124,107,79,0.12)',
                    color:
                      s.source === 'bundled' || !(s as any).org_id
                        ? 'var(--text-tertiary)'
                        : 'var(--accent)',
                    border: '1px solid var(--border-default)',
                  }}
                >
                  {s.source ?? ((s as any).org_id ? 'org' : 'bundled')}
                </span>
              </div>
              {s.description && (
                <p
                  className="mt-2 text-[12px]"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {s.description}
                </p>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Templates tab */}
      {tab === 'templates' && (
        <div className="flex-1 overflow-y-auto space-y-2 px-4 md:px-6 pb-4">
          <div
            className="rounded-xl p-4 mb-3"
            style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}
          >
            <div className="flex items-start gap-3">
              <Sparkles size={16} strokeWidth={1.75} className="mt-0.5" style={{ color: 'var(--accent)' }} />
              <div>
                <p className="text-[13px] font-semibold" style={{ color: 'var(--foreground)' }}>
                  Templates create normal tasks
                </p>
                <p className="text-[12px] leading-relaxed mt-1" style={{ color: 'var(--text-secondary)' }}>
                  Apply a template to a project, then manage the created tasks through the regular board, list, and workflow surfaces.
                </p>
              </div>
            </div>
          </div>
          {templatesErr && (
            <p className="text-[13px]" style={{ color: '#EF4444' }}>
              Failed to load templates.
            </p>
          )}
          {!templatesData && !templatesErr && (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} />
            </div>
          )}
          {templatesData && templates.length === 0 && (
            <div className="text-center py-12">
              <FileStack size={24} style={{ color: 'var(--text-tertiary)', margin: '0 auto 8px' }} />
              <p className="text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
                No templates available.
              </p>
            </div>
          )}
          {templates.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSelectedTemplate(t)}
              className="w-full text-left p-4 rounded-lg transition-colors"
              style={{
                background: 'var(--surface-container-low)',
                border: '1px solid var(--border-default)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--accent)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--border-default)';
              }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div
                    className="text-[13px] font-medium"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {t.name}
                  </div>
                  <div
                    className="text-[10px] font-semibold uppercase tracking-wide mt-0.5"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    {t.source ?? (t.org_id ? 'org' : 'bundled')}
                  </div>
                </div>
                <span
                  className="text-[11px] flex-shrink-0"
                  style={{ color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}
                >
                  {(t.tasks ?? []).length} tasks
                </span>
              </div>
              {t.description && (
                <p
                  className="mt-2 text-[12px]"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {t.description}
                </p>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Skill detail modal */}
      {selectedSkill && (
        <SkillDetailModal skill={selectedSkill} onClose={() => setSelectedSkill(null)} />
      )}

      {/* Template detail + apply modal */}
      {selectedTemplate && (
        <TemplateDetailModal
          template={selectedTemplate}
          onClose={() => setSelectedTemplate(null)}
          onApplied={(msg) => setToastMsg(msg)}
        />
      )}

      {/* Toast */}
      {toastMsg && <Toast message={toastMsg} onDismiss={() => setToastMsg(null)} />}
    </div>
  );
}
