'use client';

import { useMemo } from 'react';
import useSWR from 'swr';
import {
  getAppRunResult,
  inspectAppRun,
  isTerminalAppRun,
  listAppActions,
  listModuleAppRunOutcomes,
  type ModuleAppRunOutcome,
} from '@/lib/app-actions';
import { APPS_ENABLED } from '@/lib/feature-flags';
import { resourceRefKey, type ResourceRef } from '@/lib/modules';
import { useAuth } from '@/lib/auth-context';
import { sessionSWRKey } from '@/lib/session-cache';

export function useAppActions(resourceRef: ResourceRef | null, enabled = true) {
  const { sessionCacheScope } = useAuth();
  const key = sessionSWRKey(
    sessionCacheScope,
    APPS_ENABLED && resourceRef && enabled ? `app-actions:${resourceRefKey(resourceRef)}` : null,
  );
  const swr = useSWR(key, () => listAppActions(resourceRef!), {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
  });
  return { ...swr, actions: swr.data?.actions ?? [], resource: swr.data?.resource ?? null };
}

export function useAppRun(runId: string | null) {
  const { sessionCacheScope } = useAuth();
  return useSWR(sessionSWRKey(sessionCacheScope, runId ? `/api/app-runs/${encodeURIComponent(runId)}` : null), () => inspectAppRun(runId!), {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
    refreshInterval: (latest) => latest && isTerminalAppRun(latest.state) ? 0 : 2_000,
  });
}

export function useAppRunResult(runId: string | null, enabled: boolean) {
  const { sessionCacheScope } = useAuth();
  return useSWR(sessionSWRKey(sessionCacheScope, runId && enabled ? `/api/app-runs/${encodeURIComponent(runId)}/result` : null), () => getAppRunResult(runId!), {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    shouldRetryOnError: false,
  });
}

export function useModuleAppRunOutcomes(resourceRefs: ResourceRef[], enabled = true) {
  const { user, org, sessionCacheScope } = useAuth();
  const refs = [...new Map(resourceRefs.map(ref => [resourceRefKey(ref), ref])).values()]
    .sort((left, right) => resourceRefKey(left).localeCompare(resourceRefKey(right)));
  const identity = refs.map(resourceRefKey).sort().join('|');
  const swr = useSWR(
    APPS_ENABLED && enabled && user && org && refs.length > 0
      ? sessionSWRKey(sessionCacheScope, `module-app-run-outcomes:${org.id}:${user.id}:${identity}`)
      : null,
    async () => {
      const outcomes: ModuleAppRunOutcome[] = [];
      for (let offset = 0; offset < refs.length; offset += 100) {
        const page = await listModuleAppRunOutcomes(refs.slice(offset, offset + 100));
        outcomes.push(...page.outcomes);
      }
      return { outcomes };
    },
    { refreshInterval: 10_000, revalidateOnFocus: true, revalidateOnReconnect: true },
  );
  const outcomes = swr.data?.outcomes ?? [];
  const outcomesByResourceId = useMemo(
    () => new Map(outcomes.map(outcome => [outcome.resourceId, outcome])),
    [outcomes],
  );
  return { ...swr, outcomes, outcomesByResourceId, outcomesUnavailable: Boolean(swr.error) };
}
