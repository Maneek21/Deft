'use client';

/**
 * Task 4.9 — Client-side cache + fetch for the project's resolved skill
 * config. Exposes `{ config, loading, error, refresh }` to callers.
 *
 * Storage: sessionStorage keyed by project_id (keyed so switching projects
 * does not collide, and the cache dies with the tab so stale configs don't
 * outlive a skill-reattach flow on the server). The on-disk entry is
 * advisory — the hook always kicks off a fresh network fetch to replace it,
 * but the cached value is returned synchronously on mount so the UI doesn't
 * flash the engineering fallback for one render.
 *
 * There is no `project:skills_changed` socket event wired up server-side
 * yet (Phase 4.9 note — logged as a concern on the subagent report). When
 * it lands, the hook should subscribe and call `refresh()`.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '@/lib/api';

export type ResolvedStatus = {
  id: string;
  label: string;
  color: string;
  order: number;
};

export type PriorityVocab = {
  kind: 'numbered' | 'named' | 'temperature';
  labels: string[];
};

export type CustomField = {
  id: string;
  label: string;
  type: string;
  options?: string[];
};

export type TaskTemplate = {
  id: string;
  name: string;
  tasks: Array<{ title: string; status?: string; due_date?: string }>;
};

export type ResolvedConfig = {
  statuses: ResolvedStatus[];
  priority_vocab: PriorityVocab;
  default_view: 'board' | 'list' | 'calendar' | 'pipeline' | 'timeline';
  hide_prefix_ids: boolean;
  custom_fields: CustomField[];
  task_templates: TaskTemplate[];
  allowed_transitions: Record<string, string[]> | null;
};

const STORAGE_KEY = (projectId: string) => `deft:resolved-config:${projectId}`;

function readCached(projectId: string): ResolvedConfig | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY(projectId));
    if (!raw) return null;
    return JSON.parse(raw) as ResolvedConfig;
  } catch {
    return null;
  }
}

function writeCached(projectId: string, config: ResolvedConfig): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY(projectId), JSON.stringify(config));
  } catch {
    // sessionStorage can throw in private mode / quota errors — silently fall
    // through; the in-memory state still holds the fresh config.
  }
}

/**
 * Invalidate a cached config for a specific project. Call when the server
 * signals a skill change (future project:skills_changed socket event) or
 * immediately after a mutation that we know re-runs the resolver.
 */
export function invalidateCachedResolvedConfig(projectId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY(projectId));
  } catch {
    // ignore
  }
}

export function useProjectResolvedConfig(projectId: string | null | undefined) {
  const [config, setConfig] = useState<ResolvedConfig | null>(() =>
    projectId ? readCached(projectId) : null,
  );
  const [loading, setLoading] = useState<boolean>(!!projectId);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);

  const fetchConfig = useCallback(async () => {
    if (!projectId) {
      setConfig(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(`/api/projects/${projectId}/resolved-config`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as ResolvedConfig;
      if (!aliveRef.current) return;
      setConfig(data);
      writeCached(projectId, data);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to fetch resolved config');
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    aliveRef.current = true;
    if (projectId) {
      // Seed synchronous cache hit if any, then revalidate.
      const cached = readCached(projectId);
      if (cached) setConfig(cached);
      fetchConfig();
    } else {
      setConfig(null);
      setLoading(false);
    }
    return () => {
      aliveRef.current = false;
    };
  }, [projectId, fetchConfig]);

  const refresh = useCallback(() => {
    if (projectId) invalidateCachedResolvedConfig(projectId);
    return fetchConfig();
  }, [projectId, fetchConfig]);

  return { config, loading, error, refresh };
}

// ─── Priority label mapping (render-time only) ──────────────────────────────
//
// The DB stores canonical p0/p1/p2/p3; the UI maps at render time based on
// the project's priority_vocab kind.

export type CanonicalPriority = 'p0' | 'p1' | 'p2' | 'p3';

const NAMED_MAP: Record<CanonicalPriority, string> = {
  p0: 'High',
  p1: 'Medium',
  p2: 'Low',
  p3: 'Low',
};

const TEMPERATURE_MAP: Record<CanonicalPriority, string> = {
  p0: 'Hot',
  p1: 'Warm',
  p2: 'Cold',
  p3: 'Cold',
};

export function priorityLabel(priority: CanonicalPriority, vocab?: PriorityVocab | null): string {
  if (!vocab || vocab.kind === 'numbered') {
    return priority.toUpperCase();
  }
  if (vocab.kind === 'named') return NAMED_MAP[priority];
  if (vocab.kind === 'temperature') return TEMPERATURE_MAP[priority];
  return priority.toUpperCase();
}

/** Extended label (includes urgency qualifier) used in filter dropdown UI. */
export function priorityFullLabel(priority: CanonicalPriority, vocab?: PriorityVocab | null): string {
  const short = priorityLabel(priority, vocab);
  if (!vocab || vocab.kind === 'numbered') {
    const map: Record<CanonicalPriority, string> = {
      p0: 'Urgent',
      p1: 'High',
      p2: 'Medium',
      p3: 'Low',
    };
    return `${short} — ${map[priority]}`;
  }
  return short;
}
