'use client';

import useSWR from 'swr';
import {
  getAppRunResult,
  inspectAppRun,
  isTerminalAppRun,
  listAppActions,
} from '@/lib/app-actions';
import { APPS_ENABLED } from '@/lib/feature-flags';
import { resourceRefKey, type ResourceRef } from '@/lib/modules';

export function useAppActions(resourceRef: ResourceRef | null, enabled = true) {
  const key = APPS_ENABLED && resourceRef && enabled ? `app-actions:${resourceRefKey(resourceRef)}` : null;
  const swr = useSWR(key, () => listAppActions(resourceRef!), {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
  });
  return { ...swr, actions: swr.data?.actions ?? [], resource: swr.data?.resource ?? null };
}

export function useAppRun(runId: string | null) {
  return useSWR(runId ? `/api/app-runs/${encodeURIComponent(runId)}` : null, () => inspectAppRun(runId!), {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
    refreshInterval: (latest) => latest && isTerminalAppRun(latest.state) ? 0 : 2_000,
  });
}

export function useAppRunResult(runId: string | null, enabled: boolean) {
  return useSWR(runId && enabled ? `/api/app-runs/${encodeURIComponent(runId)}/result` : null, () => getAppRunResult(runId!), {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    shouldRetryOnError: false,
  });
}
