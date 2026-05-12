'use client';
import { useState } from 'react';
import type { WidgetDefinition, WidgetProps } from '../lib/widget-types';
import { useDashboardData } from '../lib/data-provider';
import { agentActionIcon, fmtAgentAction } from '../lib/shared';
import { formatRelativeCompact } from '@/lib/time';

function AgentWidget(_props: WidgetProps) {
  const { agentActivity, agentEmployees, widgetContext, refreshAgentActivity } = useDashboardData();
  const [employeeFilter, setEmployeeFilter] = useState('all');

  const filtered = agentActivity.filter(a =>
    employeeFilter === 'all' || a.agent_employee_id === employeeFilter
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {agentEmployees.length > 0 && (
        <select value={employeeFilter} onChange={e => setEmployeeFilter(e.target.value)}
          style={{
            fontSize: 11, background: 'rgba(255,255,255,0.04)',
            border: '1px solid var(--border-default)', borderRadius: 6,
            padding: '3px 8px', color: 'var(--text-secondary)', outline: 'none',
            width: '100%',
          }}>
          <option value="all">All agents</option>
          {agentEmployees.map(emp => (<option key={emp.id} value={emp.id}>{emp.name}</option>))}
        </select>
      )}
      {filtered.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: 0 }}>No recent actions.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {filtered.slice(0, 6).map(a => {
            const color = a.approval_status === 'approved'
              ? (a.error ? 'var(--status-red)' : 'var(--status-green)')
              : 'var(--status-amber)';
            const isPending = a.approval_status === 'pending';
            return (
              <div
                key={a.id}
                className={isPending ? 'card-lift' : undefined}
                style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}
              >
                <span
                  className={isPending ? 'status-pulse' : undefined}
                  style={{
                    display: 'grid', placeItems: 'center', width: 20, height: 20,
                    borderRadius: 5, flexShrink: 0, background: `${color}14`, color,
                  }}
                >{agentActionIcon(a.action)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{
                    fontSize: 12, color: 'var(--text-primary)', margin: 0,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{fmtAgentAction(a)}</p>
                  <p style={{ fontSize: 10, color: 'var(--text-tertiary)', margin: '1px 0 0' }}>
                    {a.approval_status === 'pending' ? 'Awaiting approval · ' : ''}
                    {formatRelativeCompact(a.executed_at || a.created_at)}
                  </p>
                  {a.approval_status === 'pending' && (
                    <div style={{ display: 'flex', gap: 5, marginTop: 6 }}>
                      <button type="button"
                        onClick={async e => {
                          e.stopPropagation();
                          if (await widgetContext.api.approveAgentAction(a.id)) {
                            await refreshAgentActivity();
                          }
                        }}
                        style={{
                          fontSize: 10, fontWeight: 600, padding: '3px 9px',
                          borderRadius: 5, border: 'none', cursor: 'pointer',
                          background: 'var(--status-green)', color: 'white',
                        }}>Approve</button>
                      <button type="button"
                        onClick={async e => {
                          e.stopPropagation();
                          if (await widgetContext.api.rejectAgentAction(a.id)) {
                            await refreshAgentActivity();
                          }
                        }}
                        style={{
                          fontSize: 10, fontWeight: 500, padding: '3px 9px',
                          borderRadius: 5, cursor: 'pointer',
                          background: 'transparent', color: 'var(--text-secondary)',
                          border: '1px solid var(--border-default)',
                        }}>Reject</button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export const agentDefinition: WidgetDefinition = {
  apiVersion: 1,
  id: 'deft.agent',
  title: 'Agent',
  description: 'Recent agent actions and pending approvals.',
  category: 'agent',
  defaultSize: { w: 4, h: 4 },
  minSize: { w: 3, h: 3 },
  Component: AgentWidget,
};
