'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { BookOpen, Loader2, Layers, FileStack, Store, Download, ExternalLink } from 'lucide-react';
import { api } from '@/lib/api';

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
  description: string | null;
  agent_config?: Record<string, unknown>;
  project_config?: Record<string, unknown>;
};

type Template = {
  id: string;
  name: string;
  slug?: string;
  source?: string;
  org_id?: string | null;
  description: string | null;
  tasks: unknown[];
};

type ClawhubEntry = {
  slug: string;
  source: string;
  description: string | null;
  homepage: string | null;
};

export default function LibraryPage() {
  const [tab, setTab] = useState<'skills' | 'templates' | 'clawhub'>('skills');

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

  const { data: clawhubData, error: clawhubErr, mutate: mutateClawhub } = useSWR<{
    mode: string;
    count?: number;
    entries: ClawhubEntry[];
  }>(tab === 'clawhub' ? '/api/clawhub/browse' : null, fetcher);
  const clawhubEntries: ClawhubEntry[] = clawhubData?.entries ?? [];
  const [importingSlug, setImportingSlug] = useState<string | null>(null);
  const [importMessage, setImportMessage] = useState<string | null>(null);

  const importSkill = async (slug: string) => {
    setImportingSlug(slug);
    setImportMessage(null);
    try {
      const res = await api.post('/api/clawhub/import', { slug });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      setImportMessage(data.reused
        ? `Already imported as skill "${data.skill.name}".`
        : `Imported "${slug}" — attach it from the Skills tab.`);
      mutateClawhub();
    } catch (e) {
      setImportMessage(`Error: ${(e as Error).message}`);
    } finally {
      setImportingSlug(null);
    }
  };

  return (
    <div className="flex flex-col h-full p-4 md:p-6 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4 flex-shrink-0">
        <BookOpen size={20} style={{ color: 'var(--accent)' }} />
        <h1 className="text-[18px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          Library
        </h1>
      </div>
      <p className="text-[13px] mb-5 flex-shrink-0" style={{ color: 'var(--text-secondary)' }}>
        Browse skills to install on agents and task templates to apply to projects.
      </p>

      {/* Tab bar */}
      <div
        className="flex gap-1 mb-5 flex-shrink-0 border-b"
        style={{ borderColor: 'var(--border-default)' }}
      >
        <button
          onClick={() => setTab('skills')}
          className="flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium transition-colors"
          style={{
            color: tab === 'skills' ? 'var(--accent)' : 'var(--text-tertiary)',
            borderBottom: tab === 'skills' ? '2px solid var(--accent)' : '2px solid transparent',
            marginBottom: '-1px',
          }}
        >
          <Layers size={14} />
          Skills
        </button>
        <button
          onClick={() => setTab('templates')}
          className="flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium transition-colors"
          style={{
            color: tab === 'templates' ? 'var(--accent)' : 'var(--text-tertiary)',
            borderBottom: tab === 'templates' ? '2px solid var(--accent)' : '2px solid transparent',
            marginBottom: '-1px',
          }}
        >
          <FileStack size={14} />
          Templates
        </button>
        <button
          onClick={() => setTab('clawhub')}
          className="flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium transition-colors"
          style={{
            color: tab === 'clawhub' ? 'var(--accent)' : 'var(--text-tertiary)',
            borderBottom: tab === 'clawhub' ? '2px solid var(--accent)' : '2px solid transparent',
            marginBottom: '-1px',
          }}
        >
          <Store size={14} />
          ClawHub
        </button>
      </div>

      {/* Skills tab */}
      {tab === 'skills' && (
        <div className="flex-1 overflow-y-auto space-y-2">
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
          {skills.length === 0 && (
            <div className="text-center py-12">
              <Layers size={24} style={{ color: 'var(--text-tertiary)', margin: '0 auto 8px' }} />
              <p className="text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
                No skills available.
              </p>
            </div>
          )}
          {skills.map((s) => (
            <div
              key={s.id}
              className="p-4 rounded-lg"
              style={{
                background: 'var(--surface-container-low)',
                border: '1px solid var(--border-default)',
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
            </div>
          ))}
        </div>
      )}

      {/* Templates tab */}
      {tab === 'templates' && (
        <div className="flex-1 overflow-y-auto space-y-2">
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
          {templates.length === 0 && (
            <div className="text-center py-12">
              <FileStack size={24} style={{ color: 'var(--text-tertiary)', margin: '0 auto 8px' }} />
              <p className="text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
                No templates available.
              </p>
            </div>
          )}
          {templates.map((t) => (
            <div
              key={t.id}
              className="p-4 rounded-lg"
              style={{
                background: 'var(--surface-container-low)',
                border: '1px solid var(--border-default)',
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
            </div>
          ))}
        </div>
      )}

      {/* ClawHub tab */}
      {tab === 'clawhub' && (
        <div className="flex-1 overflow-y-auto space-y-2">
          <p className="text-[12px] mb-2" style={{ color: 'var(--text-tertiary)' }}>
            Browsing the VoltAgent-curated allowlist. Import a skill here, then attach it to an agent from the Skills tab.
          </p>
          {importMessage && (
            <div
              className="mb-2 rounded px-3 py-2 text-[12px] flex items-center justify-between gap-3"
              style={{
                background: importMessage.startsWith('Error')
                  ? 'rgba(239,68,68,0.1)'
                  : 'rgba(124,107,79,0.12)',
                color: importMessage.startsWith('Error') ? '#EF4444' : 'var(--accent)',
              }}
            >
              <span>{importMessage}</span>
              {!importMessage.startsWith('Error') && (
                <button
                  type="button"
                  onClick={() => setTab('skills')}
                  className="px-2 py-0.5 rounded text-[11px] font-medium"
                  style={{ background: 'var(--accent)', color: 'white' }}
                >
                  Attach to an agent →
                </button>
              )}
            </div>
          )}
          {clawhubErr && (
            <p className="text-[13px]" style={{ color: '#EF4444' }}>
              Failed to load ClawHub entries.
            </p>
          )}
          {!clawhubData && !clawhubErr && (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} />
            </div>
          )}
          {clawhubData && clawhubEntries.length === 0 && (
            <div className="text-center py-12">
              <Store size={24} style={{ color: 'var(--text-tertiary)', margin: '0 auto 8px' }} />
              <p className="text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
                No allowlist entries yet. The daily refresh job seeds this table.
              </p>
            </div>
          )}
          {clawhubEntries.map((e) => (
            <div
              key={e.slug}
              className="p-4 rounded-lg"
              style={{
                background: 'var(--surface-container-low)',
                border: '1px solid var(--border-default)',
              }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium font-mono" style={{ color: 'var(--text-primary)' }}>
                    {e.slug}
                  </div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                    {e.source}
                  </div>
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  {e.homepage && (
                    <a
                      href={e.homepage}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[11px]"
                      style={{ color: 'var(--text-tertiary)' }}
                    >
                      <ExternalLink size={12} /> Source
                    </a>
                  )}
                  <button
                    onClick={() => importSkill(e.slug)}
                    disabled={importingSlug === e.slug}
                    className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium"
                    style={{
                      background: 'var(--accent)',
                      color: 'white',
                      opacity: importingSlug === e.slug ? 0.6 : 1,
                    }}
                  >
                    {importingSlug === e.slug ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Download size={12} />
                    )}
                    Import
                  </button>
                </div>
              </div>
              {e.description && (
                <p className="mt-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                  {e.description}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
