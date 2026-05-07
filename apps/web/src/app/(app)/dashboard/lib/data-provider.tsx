'use client';

/**
 * DashboardDataProvider
 *
 * One fetch at the top; widgets read via useDashboardData(). Keeps the single-
 * fetch pattern of the current dashboard while making widgets self-contained
 * at render time. Widgets that need widget-specific data (e.g. Calendar's
 * month range, agent action approvals) call the facade directly through
 * ctx.api; shared core data comes through this provider.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth-context';
import { widgetApi } from './facade';
import type {
  DashboardCore, Insights, AgentActivity, AgentEmployeeBrief,
  TeamHealth, OneOnePrep, Standup,
} from './facade';
import type { WidgetContext } from './widget-types';

type DashboardState = {
  loading: boolean;
  core: DashboardCore | null;
  insights: Insights | null;
  agentActivity: AgentActivity[];
  agentEmployees: AgentEmployeeBrief[];
  teamHealth: TeamHealth | null;
  oneonePreps: OneOnePrep[];
  setStandup: (s: Standup) => void;
  refreshAgentActivity: () => Promise<void>;
  widgetContext: WidgetContext;
};

const Ctx = createContext<DashboardState | null>(null);

const DEFAULT_TOKENS: WidgetContext['theme']['tokens'] = {
  textPrimary: 'var(--text-primary)',
  textSecondary: 'var(--text-secondary)',
  textTertiary: 'var(--text-tertiary)',
  bgPrimary: 'var(--bg-primary)',
  bgSurface: 'var(--bg-surface)',
  bgHover: 'var(--bg-hover)',
  borderDefault: 'var(--border-default)',
  borderStrong: 'var(--border-strong)',
  accent: 'var(--accent)',
  accentMuted: 'var(--accent-muted)',
  statusGreen: 'var(--status-green)',
  statusAmber: 'var(--status-amber)',
  statusRed: 'var(--status-red)',
  statusBlue: 'var(--status-blue)',
};

export function DashboardDataProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const isManager = user?.role === 'owner' || user?.role === 'admin';

  const [core, setCore] = useState<DashboardCore | null>(null);
  const [loading, setLoading] = useState(true);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [agentActivity, setAgentActivity] = useState<AgentActivity[]>([]);
  const [agentEmployees, setAgentEmployees] = useState<AgentEmployeeBrief[]>([]);
  const [teamHealth, setTeamHealth] = useState<TeamHealth | null>(null);
  const [oneonePreps, setOneonePreps] = useState<OneOnePrep[]>([]);

  useEffect(() => {
    let alive = true;
    widgetApi.getDashboardCore().then(c => { if (alive) { setCore(c); setLoading(false); } });
    widgetApi.getInsights().then(i => { if (alive) setInsights(i); });
    widgetApi.getAgentActivity().then(a => { if (alive) setAgentActivity(a); });
    widgetApi.getAgentEmployees().then(e => { if (alive) setAgentEmployees(e); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!isManager) return;
    let alive = true;
    widgetApi.getTeamHealth().then(t => { if (alive) setTeamHealth(t); });
    widgetApi.getOneOnePreps().then(p => { if (alive) setOneonePreps(p); });
    return () => { alive = false; };
  }, [isManager]);

  const refreshAgentActivity = useCallback(async () => {
    const a = await widgetApi.getAgentActivity();
    setAgentActivity(a);
  }, []);

  const setStandup = useCallback((s: Standup) => {
    setCore(prev => prev ? { ...prev, standup: s } : prev);
  }, []);

  const widgetContext = useMemo<WidgetContext>(() => ({
    user: {
      id: user?.id ?? '',
      name: user?.name ?? '',
      role: user?.role ?? '',
    },
    theme: { tokens: DEFAULT_TOKENS },
    api: widgetApi,
  }), [user]);

  const value = useMemo<DashboardState>(() => ({
    loading, core, insights, agentActivity, agentEmployees,
    teamHealth, oneonePreps, setStandup, refreshAgentActivity, widgetContext,
  }), [loading, core, insights, agentActivity, agentEmployees, teamHealth, oneonePreps, setStandup, refreshAgentActivity, widgetContext]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDashboardData(): DashboardState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDashboardData must be used inside DashboardDataProvider');
  return v;
}
