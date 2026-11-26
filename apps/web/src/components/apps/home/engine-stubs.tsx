'use client';

// TEMPORARY. Local stand-ins with the exact signatures APPS-ENGINE ships in
// its PR 2 (`@/components/apps/manifest-summary`, `@/lib/app-templates`,
// `@/lib/module-version-bump`). Replace each import with the real module and
// delete this file once that PR merges. Never ship this file to release.

import type { DeftModuleManifest } from '@deft/shared/modules';
import { api } from '@/lib/api';
import { moduleApiError, previewModuleManifestJson, type ModuleInstallation, type ModuleManifestPreview } from '@/lib/modules';
import { readableManifestError } from '@/lib/app-upload-routing';

export function ManifestSummary({ manifest, agentRead, onAgentReadChange }: {
  manifest: DeftModuleManifest;
  agentRead?: boolean;
  onAgentReadChange?: (value: boolean) => void;
}) {
  return (
    <div className="space-y-3 text-[0.8125rem]">
      <ul className="space-y-1.5">
        {manifest.collections.map((collection) => (
          <li key={collection.key} className="rounded-lg px-3 py-2" style={{ background: 'var(--surface-container-high)' }}>
            <span className="font-medium">{collection.name}</span>: {collection.fields.map((field) => field.label).join(', ')}
          </li>
        ))}
      </ul>
      {onAgentReadChange && (
        <fieldset>
          <legend className="font-medium">Let Defty read these records?</legend>
          <label className="mr-4 inline-flex min-h-11 items-center gap-2"><input type="radio" name="agent-read" checked={agentRead === true} onChange={() => onAgentReadChange(true)} /> Yes</label>
          <label className="inline-flex min-h-11 items-center gap-2"><input type="radio" name="agent-read" checked={agentRead !== true} onChange={() => onAgentReadChange(false)} /> No</label>
        </fieldset>
      )}
    </div>
  );
}

export function agentAccessPatchFor(agentRead: boolean | undefined): { agent_access: 'read' } | null {
  return agentRead === true ? { agent_access: 'read' } : null;
}

export type AppTemplate = {
  key: string;
  name: string;
  description: string;
  icon: string;
  manifest: DeftModuleManifest;
  samples: unknown[];
};

const field = (key: string, label: string, type = 'text', extra: Record<string, unknown> = {}) => ({ key, label, type, ...extra });
export const APP_TEMPLATES: AppTemplate[] = [
  {
    key: 'hiring-pipeline', name: 'Hiring pipeline', icon: 'users', samples: [],
    description: 'Open roles and the candidates moving through each stage.',
    manifest: { schema_version: '1', id: 'workspace.hiring-pipeline', slug: 'hiring-pipeline', version: '1.0.0', name: 'Hiring pipeline', icon: 'users',
      collections: [{ key: 'candidates', name: 'Candidates', fields: [field('name', 'Name', 'text', { required: true }), field('email', 'Email', 'email')], views: [{ key: 'table', name: 'Table', type: 'table', fields: ['name', 'email'] }] }] } as unknown as DeftModuleManifest,
  },
  {
    key: 'vendor-tracker', name: 'Vendor tracker', icon: 'briefcase', samples: [],
    description: 'Suppliers, contracts and renewal dates in one place.',
    manifest: { schema_version: '1', id: 'workspace.vendor-tracker', slug: 'vendor-tracker', version: '1.0.0', name: 'Vendor tracker', icon: 'briefcase',
      collections: [{ key: 'vendors', name: 'Vendors', fields: [field('name', 'Name', 'text', { required: true }), field('renewal', 'Renewal date', 'date')], views: [{ key: 'table', name: 'Table', type: 'table', fields: ['name', 'renewal'] }] }] } as unknown as DeftModuleManifest,
  },
];

function slugFor(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48) || 'app';
}

export async function installAppTemplate(input: { template: AppTemplate; name: string; withSamples: boolean; installed?: ModuleInstallation[] }): Promise<{ slug: string; moduleId: string; name: string; seeded: number; seedError?: string }> {
  const taken = new Set((input.installed ?? []).flatMap((module) => [module.slug, module.moduleId]));
  const base = slugFor(input.name);
  let slug = base;
  for (let n = 2; taken.has(slug) || taken.has(`workspace.${slug}`); n += 1) slug = `${base}-${n}`;
  const manifest = { ...input.template.manifest, name: input.name.trim() || input.template.name, slug, id: `workspace.${slug}` };
  const response = await api.fetch('/api/modules/sideload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(manifest) });
  if (!response.ok) throw new Error(await moduleApiError(response, `Unable to install ${manifest.name}.`));
  return { slug, moduleId: manifest.id, name: manifest.name, seeded: 0, ...(input.withSamples ? { seedError: 'Sample records are not available yet.' } : {}) };
}

function bumpPatch(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/u.exec(version);
  return match ? `${match[1]}.${match[2]}.${Number(match[3]) + 1}` : version;
}

export function bumpPatchIfUnchanged(edited: string, activeVersion: string): string {
  try {
    const value = JSON.parse(edited) as Record<string, unknown>;
    if (value.version !== activeVersion) return edited;
    return JSON.stringify({ ...value, version: bumpPatch(activeVersion) }, null, 2);
  } catch {
    return edited;
  }
}

export async function checkModuleManifestEdit(source: string, activeVersion: string): Promise<{ ok: true; preview: ModuleManifestPreview } | { ok: false; lines: string[] }> {
  try {
    return { ok: true, preview: await previewModuleManifestJson(bumpPatchIfUnchanged(source, activeVersion)) };
  } catch (error) {
    let text: string;
    try { JSON.parse(source); text = readableManifestError(error, source); } catch { text = 'This file isn’t valid JSON. Look for a missing comma, quote or bracket.'; }
    return { ok: false, lines: text.split('\n') };
  }
}

export async function saveModuleManifestEdit(input: { slug: string; source: string; activeDigest: string; activeVersion: string }): Promise<ModuleManifestPreview> {
  const checked = await checkModuleManifestEdit(input.source, input.activeVersion);
  if (!checked.ok) throw new Error(checked.lines.join('\n'));
  const response = await api.fetch(`/api/modules/${encodeURIComponent(input.slug)}/upgrade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'If-Match': input.activeDigest },
    body: bumpPatchIfUnchanged(input.source, input.activeVersion),
  });
  if (!response.ok) throw new Error(await moduleApiError(response, 'Unable to save this app.'));
  return checked.preview;
}
