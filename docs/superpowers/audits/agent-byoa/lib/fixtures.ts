// docs/superpowers/audits/agent-byoa/lib/fixtures.ts
import type { DeftRest } from './api-client.js';

export interface Scratch<T> { resource: T; cleanup: () => Promise<void>; }

export const HARNESS_PREFIX = 'harness';

function tag(scenarioSlug: string): string {
  return `${HARNESS_PREFIX}-${scenarioSlug}-${Date.now()}`;
}

// 4-char short code derived from scenario + a 2-digit suffix to keep
// project prefix within the 2-6 char schema constraint.
function shortPrefix(scenarioSlug: string): string {
  const base = scenarioSlug.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const head = base.slice(0, 4) || 'TEST';
  const tail = String(Date.now() % 100).padStart(2, '0');
  return (head + tail).slice(0, 6);
}

export async function withScratchSpace(rest: DeftRest, scenarioSlug: string): Promise<Scratch<{ id: string; name: string }>> {
  const name = tag(scenarioSlug);
  const created = await rest.post<{ id: string; name: string }>('/api/spaces', {
    name,
    type: 'public',
  });
  return {
    resource: created,
    cleanup: async () => {
      await rest.delete(`/api/spaces/${created.id}`).catch(() => undefined);
    },
  };
}

export async function withScratchProject(rest: DeftRest, scenarioSlug: string): Promise<Scratch<{ id: string; prefix: string }>> {
  const name = tag(scenarioSlug);
  const created = await rest.post<{ id: string; prefix: string }>('/api/projects', {
    name,
    prefix: shortPrefix(scenarioSlug),
  });
  return {
    resource: created,
    cleanup: async () => {
      await rest.delete(`/api/projects/${created.id}`).catch(() => undefined);
    },
  };
}

export async function withScratchWikiPage(
  rest: DeftRest,
  scenarioSlug: string,
  content: string,
  type: string = 'fact',
): Promise<Scratch<{ slug: string; id: string }>> {
  const title = `${HARNESS_PREFIX}: ${scenarioSlug}-${Date.now()}`;
  const created = await rest.post<{ slug: string; id: string }>('/api/wiki', {
    title,
    content,
    type,
    scope: 'org',
  });
  return {
    resource: created,
    cleanup: async () => {
      await rest.delete(`/api/wiki/${created.slug}`).catch(() => undefined);
    },
  };
}

// Suite-wide sweep: drop anything with a harness: title-prefix that survived
// a crashed run. Best-effort.
export async function harnessSweep(rest: DeftRest): Promise<void> {
  try {
    const wiki = await rest.get<{ pages?: Array<{ slug: string; title: string }> }>('/api/wiki?limit=200');
    for (const p of wiki.pages ?? []) {
      if (p.title.startsWith(`${HARNESS_PREFIX}:`)) {
        await rest.delete(`/api/wiki/${p.slug}`).catch(() => undefined);
      }
    }
  } catch { /* best effort */ }
}
