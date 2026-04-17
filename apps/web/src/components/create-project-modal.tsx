'use client';

import { useState, useEffect, useRef } from 'react';
import { api } from '@/lib/api';
import { X, ArrowLeft, ArrowUp, ArrowDown } from 'lucide-react';

const PRESET_COLORS = [
  '#D4A853', // amber
  '#3B82F6', // blue
  '#8B5CF6', // purple
  '#22C55E', // green
  '#EF4444', // red
  '#6B7280', // gray
];

// Task 4.8 — skill picker shape. Pulled from /api/agents/deploy/skills (the
// same endpoint the deploy wizard uses). We filter client-side to skills
// with a non-empty project_config, since only those drive project UI.
type TaskTemplate = {
  id: string;
  name: string;
  tasks: Array<{ title: string; status?: string }>;
};

type ProjectConfigShape = {
  statuses?: Array<{ id: string; label: string }>;
  default_view?: string;
  task_templates?: TaskTemplate[];
} | null;

type CatalogSkill = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  source: 'bundled' | 'marketplace' | 'org';
  version: string;
  project_config?: ProjectConfigShape;
};

type Project = {
  id: string;
  name: string;
  prefix: string;
  color: string | null;
  task_counter: number;
  total_tasks: number;
  done_tasks: number;
};

type Props = {
  onClose: () => void;
  onCreated: (project: Project) => void;
};

type Step = 1 | 2 | 3;

export function CreateProjectModal({ onClose, onCreated }: Props) {
  // ── Step 1 state ────────────────────────────────────────────────────
  const [name, setName] = useState('');
  const [prefix, setPrefix] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState('#D4A853');
  const [prefixManuallyEdited, setPrefixManuallyEdited] = useState(false);

  // ── Step 2 state ────────────────────────────────────────────────────
  const [step, setStep] = useState<Step>(1);
  const [catalog, setCatalog] = useState<CatalogSkill[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  // Ordered list of skill ids. Order matters — the first drives the UI.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // ── Step 3 state (apply starter template) ───────────────────────────
  const [createdProject, setCreatedProject] = useState<Project | null>(null);
  const [starterTemplate, setStarterTemplate] = useState<{
    skillId: string;
    template: TaskTemplate;
  } | null>(null);
  const [applyingTemplate, setApplyingTemplate] = useState(false);
  const [templateMessage, setTemplateMessage] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  // Auto-generate prefix from name
  useEffect(() => {
    if (name && !prefixManuallyEdited) {
      const auto = name
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => w[0])
        .join('')
        .toUpperCase()
        .slice(0, 4);
      setPrefix(auto);
    }
  }, [name, prefixManuallyEdited]);

  // Lazy-load the skill catalog once the user reaches step 2. We call the
  // deploy-wizard skill endpoint (task 4.7) and filter down to skills that
  // carry a non-empty project_config. If the endpoint 404s (older API) or
  // fails, we skip skill attachment and still let the user create the
  // project — the feature degrades rather than blocks.
  useEffect(() => {
    if (step !== 2 || catalogLoaded) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get('/api/agents/deploy/skills');
        if (cancelled) return;
        if (!res.ok) {
          setCatalogError('skills_unavailable');
          setCatalogLoaded(true);
          return;
        }
        const body = await res.json();
        const all = (Array.isArray(body) ? body : (body.skills ?? [])) as CatalogSkill[];
        const projectSkills = all.filter((s) => {
          const pc = s.project_config;
          if (!pc || typeof pc !== 'object') return false;
          // A project_config is "non-empty" if it defines at least statuses
          // or a default_view — the two things the UI actually needs.
          return Boolean(
            (pc.statuses && pc.statuses.length > 0) || pc.default_view,
          );
        });
        // Stable sort: bundled before org; within each group, alpha by name.
        projectSkills.sort((a, b) => {
          if (a.source !== b.source) {
            return a.source === 'bundled' ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        });
        setCatalog(projectSkills);
        // Default: pre-select Engineering (by slug) if present.
        const engineering = projectSkills.find((s) => s.slug === 'engineering');
        if (engineering && selectedIds.length === 0) {
          setSelectedIds([engineering.id]);
        }
        setCatalogLoaded(true);
      } catch {
        if (cancelled) return;
        setCatalogError('skills_unavailable');
        setCatalogLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // selectedIds intentionally excluded: we only seed it once on first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, catalogLoaded]);

  const toggleSkill = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const moveSkill = (id: string, direction: 'up' | 'down') => {
    setSelectedIds((prev) => {
      const idx = prev.indexOf(id);
      if (idx < 0) return prev;
      const target = direction === 'up' ? idx - 1 : idx + 1;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target]!, next[idx]!];
      return next;
    });
  };

  const handleStep1Continue = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !prefix.trim()) return;
    setError(null);
    setStep(2);
  };

  const handleCreate = async () => {
    if (!name.trim() || !prefix.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await api.post('/api/projects', {
        name: name.trim(),
        prefix: prefix.trim().toUpperCase(),
        description: description.trim() || null,
        color,
      });

      if (!res.ok) {
        const data = await res
          .json()
          .catch(() => ({ error: 'Failed to create project' }));
        throw new Error(data.error || 'Failed to create project');
      }

      const project = (await res.json()) as Project;

      // Attach selected skills in chosen order. The FIRST one drives the
      // board UI (statuses, view, vocab) so order matters. Best-effort —
      // if an attachment fails, surface the error but keep the project.
      const attachErrors: string[] = [];
      for (const skillId of selectedIds) {
        const attachRes = await api.post(
          `/api/projects/${project.id}/skills`,
          { skill_id: skillId },
        );
        if (!attachRes.ok) {
          const skill = catalog.find((s) => s.id === skillId);
          attachErrors.push(skill?.name ?? skillId);
        }
      }
      if (attachErrors.length > 0) {
        setError(`Project created, but failed to attach: ${attachErrors.join(', ')}`);
      }

      // Find the first selected skill that carries a task_templates list.
      const withTemplate = selectedIds
        .map((id) => catalog.find((s) => s.id === id))
        .find(
          (s) =>
            s &&
            s.project_config &&
            s.project_config.task_templates &&
            s.project_config.task_templates.length > 0,
        );

      const finalProject: Project = {
        ...project,
        total_tasks: 0,
        done_tasks: 0,
      };

      if (withTemplate && withTemplate.project_config?.task_templates?.[0]) {
        // Don't dismiss the modal yet — show the starter-template prompt.
        setCreatedProject(finalProject);
        setStarterTemplate({
          skillId: withTemplate.id,
          template: withTemplate.project_config.task_templates[0],
        });
        setStep(3);
      } else {
        onCreated(finalProject);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setSubmitting(false);
    }
  };

  const handleApplyTemplate = async () => {
    if (!createdProject || !starterTemplate) return;
    setApplyingTemplate(true);
    setTemplateMessage(null);
    try {
      const res = await api.post(
        `/api/projects/${createdProject.id}/apply-template`,
        { template_id: starterTemplate.template.id, skill_id: starterTemplate.skillId },
      );
      if (res.ok) {
        onCreated(createdProject);
        return;
      }
      if (res.status === 404) {
        setTemplateMessage('Starter templates are coming soon. Project created without tasks.');
        // Small delay so the user sees the message, then close.
        setTimeout(() => onCreated(createdProject), 1200);
        return;
      }
      const data = await res.json().catch(() => ({ error: 'Failed to apply template' }));
      setTemplateMessage(data.error || 'Failed to apply template.');
    } catch {
      setTemplateMessage('Failed to apply template.');
    } finally {
      setApplyingTemplate(false);
    }
  };

  const handleSkipTemplate = () => {
    if (createdProject) onCreated(createdProject);
  };

  // ── Render ──────────────────────────────────────────────────────────

  const renderStep1 = () => (
    <form onSubmit={handleStep1Continue} className="p-5">
      {/* Name */}
      <div className="mb-3">
        <label
          className="text-[12px] font-medium mb-1 block"
          style={{ color: 'var(--foreground-secondary)', fontFamily: 'var(--font-body)' }}
        >
          Name
        </label>
        <input
          ref={nameRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Mobile App"
          className="w-full px-3 py-2 rounded-lg text-[13px] outline-none"
          style={{
            background: 'var(--input-bg)',
            border: '1px solid var(--input-border)',
            color: 'var(--foreground)',
            fontFamily: 'var(--font-body)',
          }}
          onFocus={(e) => {
            (e.target as HTMLElement).style.borderColor = 'var(--accent)';
            (e.target as HTMLElement).style.boxShadow = '0 0 0 3px var(--input-focus)';
          }}
          onBlur={(e) => {
            (e.target as HTMLElement).style.borderColor = 'var(--input-border)';
            (e.target as HTMLElement).style.boxShadow = 'none';
          }}
        />
      </div>

      {/* Prefix */}
      <div className="mb-3">
        <label
          className="text-[12px] font-medium mb-1 block"
          style={{ color: 'var(--foreground-secondary)', fontFamily: 'var(--font-body)' }}
        >
          Prefix <span style={{ color: 'var(--muted)' }}>(used in task IDs like PRJ-1)</span>
        </label>
        <input
          type="text"
          value={prefix}
          onChange={(e) => {
            setPrefixManuallyEdited(true);
            setPrefix(e.target.value.toUpperCase().slice(0, 4));
          }}
          placeholder="e.g. MOB"
          maxLength={4}
          className="w-full px-3 py-2 rounded-lg text-[13px] outline-none uppercase"
          style={{
            background: 'var(--input-bg)',
            border: '1px solid var(--input-border)',
            color: 'var(--foreground)',
            fontFamily: 'var(--font-body)',
            letterSpacing: '0.05em',
          }}
          onFocus={(e) => {
            (e.target as HTMLElement).style.borderColor = 'var(--accent)';
            (e.target as HTMLElement).style.boxShadow = '0 0 0 3px var(--input-focus)';
          }}
          onBlur={(e) => {
            (e.target as HTMLElement).style.borderColor = 'var(--input-border)';
            (e.target as HTMLElement).style.boxShadow = 'none';
          }}
        />
      </div>

      {/* Description */}
      <div className="mb-4">
        <label
          className="text-[12px] font-medium mb-1 block"
          style={{ color: 'var(--foreground-secondary)', fontFamily: 'var(--font-body)' }}
        >
          Description <span style={{ color: 'var(--muted)' }}>(optional)</span>
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is this project about?"
          className="w-full px-3 py-2 rounded-lg text-[13px] outline-none resize-none"
          rows={2}
          style={{
            background: 'var(--input-bg)',
            border: '1px solid var(--input-border)',
            color: 'var(--foreground)',
            fontFamily: 'var(--font-body)',
          }}
          onFocus={(e) => {
            (e.target as HTMLElement).style.borderColor = 'var(--accent)';
            (e.target as HTMLElement).style.boxShadow = '0 0 0 3px var(--input-focus)';
          }}
          onBlur={(e) => {
            (e.target as HTMLElement).style.borderColor = 'var(--input-border)';
            (e.target as HTMLElement).style.boxShadow = 'none';
          }}
        />
      </div>

      {/* Color picker */}
      <div className="mb-4">
        <label
          className="text-[12px] font-medium mb-2 block"
          style={{ color: 'var(--foreground-secondary)', fontFamily: 'var(--font-body)' }}
        >
          Color
        </label>
        <div className="flex gap-2">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className="w-7 h-7 rounded-full flex items-center justify-center transition-transform"
              style={{
                background: c,
                transform: color === c ? 'scale(1.15)' : 'scale(1)',
                boxShadow: color === c ? `0 0 0 2px var(--card-bg), 0 0 0 4px ${c}` : 'none',
              }}
            />
          ))}
        </div>
      </div>

      {/* Error */}
      {error && (
        <p className="text-[12px] mb-3" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}

      {/* Submit */}
      <button
        type="submit"
        disabled={!name.trim() || !prefix.trim()}
        className="w-full py-2 rounded-lg text-[13px] font-medium text-white transition-opacity"
        style={{
          background: 'var(--accent)',
          opacity: !name.trim() || !prefix.trim() ? 0.5 : 1,
          fontFamily: 'var(--font-heading)',
        }}
      >
        Continue
      </button>
    </form>
  );

  const renderStep2 = () => {
    const selectedSkills = selectedIds
      .map((id) => catalog.find((s) => s.id === id))
      .filter((s): s is CatalogSkill => Boolean(s));
    const unselectedSkills = catalog.filter((s) => !selectedIds.includes(s.id));

    return (
      <div className="p-5">
        <p
          className="text-[12px] mb-1"
          style={{ color: 'var(--foreground-secondary)', fontFamily: 'var(--font-body)' }}
        >
          Which skills apply to this project?
        </p>
        <p
          className="text-[11px] mb-4"
          style={{ color: 'var(--muted)', fontFamily: 'var(--font-body)' }}
        >
          Order matters — the first skill drives the board UI (statuses, view, vocabulary).
        </p>

        {!catalogLoaded && (
          <p className="text-[12px]" style={{ color: 'var(--muted)' }}>
            Loading skills...
          </p>
        )}

        {catalogLoaded && catalogError && (
          <p className="text-[12px]" style={{ color: 'var(--muted)' }}>
            Skill picker unavailable. You can still create the project and attach
            skills later.
          </p>
        )}

        {catalogLoaded && !catalogError && catalog.length === 0 && (
          <p className="text-[12px]" style={{ color: 'var(--muted)' }}>
            No project-workflow skills available. Seed them with
            {' '}
            <code>pnpm tsx apps/api/src/scripts/seed-bundled-skills.ts</code>.
          </p>
        )}

        {/* Selected (ordered) */}
        {selectedSkills.length > 0 && (
          <div className="mb-4">
            <div
              className="text-[11px] font-medium uppercase tracking-wide mb-2"
              style={{ color: 'var(--muted)' }}
            >
              Attached (drag-free reorder)
            </div>
            <div className="flex flex-col gap-2">
              {selectedSkills.map((s, idx) => (
                <div
                  key={s.id}
                  className="flex items-center gap-2 p-3 rounded-lg"
                  style={{
                    background: 'var(--surface-container-high)',
                    border: `1px solid ${idx === 0 ? 'var(--accent)' : 'var(--border)'}`,
                  }}
                >
                  <div className="flex flex-col gap-0.5">
                    <button
                      type="button"
                      onClick={() => moveSkill(s.id, 'up')}
                      disabled={idx === 0}
                      className="p-0.5 rounded"
                      style={{ color: 'var(--muted)', opacity: idx === 0 ? 0.3 : 1 }}
                      aria-label={`Move ${s.name} up`}
                    >
                      <ArrowUp size={12} strokeWidth={1.5} />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveSkill(s.id, 'down')}
                      disabled={idx === selectedSkills.length - 1}
                      className="p-0.5 rounded"
                      style={{
                        color: 'var(--muted)',
                        opacity: idx === selectedSkills.length - 1 ? 0.3 : 1,
                      }}
                      aria-label={`Move ${s.name} down`}
                    >
                      <ArrowDown size={12} strokeWidth={1.5} />
                    </button>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className="text-[13px] font-medium truncate"
                        style={{ color: 'var(--foreground)' }}
                      >
                        {s.name}
                      </span>
                      {idx === 0 && (
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded"
                          style={{
                            background: 'var(--accent)',
                            color: 'white',
                            fontFamily: 'var(--font-heading)',
                          }}
                        >
                          DRIVES UI
                        </span>
                      )}
                    </div>
                    {s.description && (
                      <p
                        className="text-[11px] mt-0.5 line-clamp-1"
                        style={{ color: 'var(--muted)' }}
                      >
                        {s.description}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleSkill(s.id)}
                    className="p-1 rounded"
                    style={{ color: 'var(--muted)' }}
                    aria-label={`Remove ${s.name}`}
                  >
                    <X size={14} strokeWidth={1.5} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Unselected */}
        {unselectedSkills.length > 0 && (
          <div className="mb-4">
            <div
              className="text-[11px] font-medium uppercase tracking-wide mb-2"
              style={{ color: 'var(--muted)' }}
            >
              Available
            </div>
            <div className="flex flex-col gap-2">
              {unselectedSkills.map((s) => (
                <button
                  type="button"
                  key={s.id}
                  onClick={() => toggleSkill(s.id)}
                  className="text-left p-3 rounded-lg transition-colors"
                  style={{
                    background: 'var(--surface-container)',
                    border: '1px solid var(--border)',
                  }}
                >
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <span
                        className="text-[13px] font-medium truncate"
                        style={{ color: 'var(--foreground)' }}
                      >
                        {s.name}
                      </span>
                      {s.description && (
                        <p
                          className="text-[11px] mt-0.5 line-clamp-2"
                          style={{ color: 'var(--muted)' }}
                        >
                          {s.description}
                        </p>
                      )}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <p className="text-[12px] mb-3" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setStep(1)}
            className="flex items-center gap-1 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors"
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              color: 'var(--foreground-secondary)',
              fontFamily: 'var(--font-heading)',
            }}
          >
            <ArrowLeft size={14} strokeWidth={1.5} />
            Back
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={submitting}
            className="flex-1 py-2 rounded-lg text-[13px] font-medium text-white transition-opacity"
            style={{
              background: 'var(--accent)',
              opacity: submitting ? 0.5 : 1,
              fontFamily: 'var(--font-heading)',
            }}
          >
            {submitting ? 'Creating...' : 'Create project'}
          </button>
        </div>
      </div>
    );
  };

  const renderStep3 = () => {
    if (!starterTemplate || !createdProject) return null;
    const count = starterTemplate.template.tasks.length;
    return (
      <div className="p-5">
        <p
          className="text-[13px] mb-2"
          style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)' }}
        >
          Found a starter template
        </p>
        <p
          className="text-[12px] mb-4"
          style={{ color: 'var(--muted)', fontFamily: 'var(--font-body)' }}
        >
          <strong style={{ color: 'var(--foreground)' }}>
            {starterTemplate.template.name}
          </strong>
          {' '}will create {count} task{count === 1 ? '' : 's'} to get you started.
        </p>

        {templateMessage && (
          <p className="text-[12px] mb-3" style={{ color: 'var(--muted)' }}>
            {templateMessage}
          </p>
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSkipTemplate}
            disabled={applyingTemplate}
            className="px-3 py-2 rounded-lg text-[13px] font-medium transition-colors"
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              color: 'var(--foreground-secondary)',
              fontFamily: 'var(--font-heading)',
            }}
          >
            Skip
          </button>
          <button
            type="button"
            onClick={handleApplyTemplate}
            disabled={applyingTemplate}
            className="flex-1 py-2 rounded-lg text-[13px] font-medium text-white transition-opacity"
            style={{
              background: 'var(--accent)',
              opacity: applyingTemplate ? 0.5 : 1,
              fontFamily: 'var(--font-heading)',
            }}
          >
            {applyingTemplate ? 'Applying...' : `Apply template (${count} tasks)`}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center"
      style={{ background: 'rgba(0, 0, 0, 0.5)' }}
      onClick={onClose}
    >
      <div
        className="w-[calc(100vw-2rem)] max-w-[480px] max-h-[90vh] overflow-y-auto rounded-2xl"
        style={{
          background: 'var(--card-bg)',
          border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-lg)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="px-5 py-4 flex items-center justify-between"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <div className="flex items-center gap-2">
            <h2
              className="text-[15px] font-semibold"
              style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
            >
              Create a project
            </h2>
            <span
              className="text-[11px] px-1.5 py-0.5 rounded"
              style={{
                background: 'var(--surface-container)',
                color: 'var(--muted)',
                fontFamily: 'var(--font-body)',
              }}
            >
              Step {step} of {starterTemplate ? 3 : 2}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md"
            style={{ color: 'var(--muted)' }}
            aria-label="Close"
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>

        {step === 1 && renderStep1()}
        {step === 2 && renderStep2()}
        {step === 3 && renderStep3()}
      </div>
    </div>
  );
}
