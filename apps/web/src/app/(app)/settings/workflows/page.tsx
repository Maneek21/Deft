'use client';

// Task 5.7 — Workflows settings page. Lists workflow_rules for the org
// and a minimal create form: trigger (status-changed + target status)
// and action checkboxes (add_comment / assign_to / add_label / notify).
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Loader2, Plus, Trash2, Zap, X } from 'lucide-react';

type WorkflowRule = {
  id: string;
  name: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  action_type: string;
  action_config: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
};

type Label = { id: string; name: string; color: string };
type Member = { id: string; name: string; email: string };

type ActionKind = 'add_comment' | 'assign_to' | 'add_label' | 'notify';

const TARGET_STATUSES: Array<{ value: string; label: string }> = [
  { value: 'todo', label: 'To Do' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'in_review', label: 'In Review' },
  { value: 'done', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
];

export default function WorkflowsPage() {
  const [rules, setRules] = useState<WorkflowRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const [name, setName] = useState('');
  const [toStatus, setToStatus] = useState('done');
  const [selectedActions, setSelectedActions] = useState<Set<ActionKind>>(new Set());
  const [commentTemplate, setCommentTemplate] = useState('');
  const [assignToUserId, setAssignToUserId] = useState('');
  const [labelId, setLabelId] = useState('');
  const [notifyUserId, setNotifyUserId] = useState('');

  const [labels, setLabels] = useState<Label[]>([]);
  const [members, setMembers] = useState<Member[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rulesRes, labelsRes, membersRes] = await Promise.all([
        api.get('/api/workflows'),
        api.get('/api/labels'),
        api.get('/api/members'),
      ]);
      if (rulesRes.ok) setRules(await rulesRes.json());
      if (labelsRes.ok) {
        const labelsData = await labelsRes.json();
        setLabels(Array.isArray(labelsData) ? labelsData : (labelsData.labels || []));
      }
      if (membersRes.ok) {
        const m = await membersRes.json();
        const list: Member[] = Array.isArray(m) ? m : (m.members || []);
        setMembers(list);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const resetForm = () => {
    setName('');
    setToStatus('done');
    setSelectedActions(new Set());
    setCommentTemplate('');
    setAssignToUserId('');
    setLabelId('');
    setNotifyUserId('');
  };

  const toggleAction = (kind: ActionKind) => {
    setSelectedActions((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const handleCreate = async () => {
    if (!name.trim() || selectedActions.size === 0) return;
    const actions: Array<Record<string, unknown>> = [];
    for (const kind of selectedActions) {
      if (kind === 'add_comment') {
        if (!commentTemplate.trim()) continue;
        actions.push({ kind: 'add_comment', template: commentTemplate.trim() });
      } else if (kind === 'assign_to') {
        if (!assignToUserId) continue;
        actions.push({ kind: 'assign_to', user_id: assignToUserId });
      } else if (kind === 'add_label') {
        if (!labelId) continue;
        actions.push({ kind: 'add_label', label_id: labelId });
      } else if (kind === 'notify') {
        if (!notifyUserId) continue;
        actions.push({ kind: 'notify', user_id: notifyUserId });
      }
    }
    if (actions.length === 0) return;

    const res = await api.post('/api/workflows', {
      name: name.trim(),
      trigger_type: 'task.status_changed',
      trigger_config: { to_status: toStatus },
      action_type: actions.length === 1 ? actions[0].kind : 'composite',
      action_config: actions.length === 1 ? actions[0] : { actions },
      is_active: true,
    });
    if (res.ok) {
      resetForm();
      setCreating(false);
      await load();
    }
  };

  const handleToggleActive = async (rule: WorkflowRule) => {
    const res = await api.patch(`/api/workflows/${rule.id}`, { is_active: !rule.is_active });
    if (res.ok) await load();
  };

  const handleDelete = async (rule: WorkflowRule) => {
    if (!window.confirm(`Delete workflow "${rule.name}"?`)) return;
    const res = await api.delete(`/api/workflows/${rule.id}`);
    if (res.ok) setRules((prev) => prev.filter((r) => r.id !== rule.id));
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[820px] mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-[22px] font-semibold"
              style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)', letterSpacing: '-0.02em' }}>
              Workflows
            </h1>
            <p className="text-[13px] mt-0.5" style={{ color: 'var(--muted)' }}>
              Automate simple rules like "when a task moves to Done, add the <em>shipped</em> label."
            </p>
          </div>
          {!creating && (
            <button onClick={() => setCreating(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium text-white"
              style={{ background: 'var(--accent)' }}>
              <Plus size={14} /> New workflow
            </button>
          )}
        </div>

        {creating && (
          <div className="mb-6 p-4 rounded-xl"
            style={{ background: 'var(--surface-container)', border: '1px solid var(--border)' }}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Zap size={14} style={{ color: 'var(--accent)' }} />
                <h3 className="text-[13px] font-semibold" style={{ color: 'var(--foreground)' }}>
                  New workflow
                </h3>
              </div>
              <button onClick={() => { resetForm(); setCreating(false); }} className="p-1 rounded-lg"
                style={{ color: 'var(--muted)' }}>
                <X size={16} />
              </button>
            </div>

            <label className="text-[11px] font-medium block mb-1" style={{ color: 'var(--muted)' }}>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Mark shipped on done"
              className="w-full h-9 px-3 rounded-lg text-[13px] outline-none mb-3"
              style={{ background: 'var(--input-bg)', color: 'var(--foreground)', border: '1px solid var(--input-border)' }} />

            <label className="text-[11px] font-medium block mb-1" style={{ color: 'var(--muted)' }}>
              Trigger
            </label>
            <div className="flex items-center gap-2 mb-4">
              <span className="text-[12px]" style={{ color: 'var(--foreground)' }}>When task status changes to</span>
              <select value={toStatus} onChange={(e) => setToStatus(e.target.value)}
                className="h-8 px-2 rounded-lg text-[12px] outline-none"
                style={{ background: 'var(--input-bg)', color: 'var(--foreground)', border: '1px solid var(--input-border)' }}>
                {TARGET_STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>

            <label className="text-[11px] font-medium block mb-2" style={{ color: 'var(--muted)' }}>
              Actions (pick one or more)
            </label>
            <div className="space-y-2">
              <ActionRow label="Add a comment" enabled={selectedActions.has('add_comment')}
                onToggle={() => toggleAction('add_comment')}>
                <input value={commentTemplate} onChange={(e) => setCommentTemplate(e.target.value)}
                  placeholder="Comment text..."
                  disabled={!selectedActions.has('add_comment')}
                  className="w-full h-8 px-2 rounded text-[12px] outline-none"
                  style={{ background: 'var(--input-bg)', color: 'var(--foreground)', border: '1px solid var(--input-border)' }} />
              </ActionRow>
              <ActionRow label="Assign to user" enabled={selectedActions.has('assign_to')}
                onToggle={() => toggleAction('assign_to')}>
                <select value={assignToUserId} onChange={(e) => setAssignToUserId(e.target.value)}
                  disabled={!selectedActions.has('assign_to')}
                  className="w-full h-8 px-2 rounded text-[12px] outline-none"
                  style={{ background: 'var(--input-bg)', color: 'var(--foreground)', border: '1px solid var(--input-border)' }}>
                  <option value="">Pick a user...</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.name || m.email}</option>)}
                </select>
              </ActionRow>
              <ActionRow label="Add label" enabled={selectedActions.has('add_label')}
                onToggle={() => toggleAction('add_label')}>
                <select value={labelId} onChange={(e) => setLabelId(e.target.value)}
                  disabled={!selectedActions.has('add_label')}
                  className="w-full h-8 px-2 rounded text-[12px] outline-none"
                  style={{ background: 'var(--input-bg)', color: 'var(--foreground)', border: '1px solid var(--input-border)' }}>
                  <option value="">Pick a label...</option>
                  {labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </ActionRow>
              <ActionRow label="Notify user" enabled={selectedActions.has('notify')}
                onToggle={() => toggleAction('notify')}>
                <select value={notifyUserId} onChange={(e) => setNotifyUserId(e.target.value)}
                  disabled={!selectedActions.has('notify')}
                  className="w-full h-8 px-2 rounded text-[12px] outline-none"
                  style={{ background: 'var(--input-bg)', color: 'var(--foreground)', border: '1px solid var(--input-border)' }}>
                  <option value="">Pick a user...</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.name || m.email}</option>)}
                </select>
              </ActionRow>
            </div>

            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => { resetForm(); setCreating(false); }}
                className="px-3 h-9 rounded-lg text-[13px]" style={{ color: 'var(--muted)' }}>
                Cancel
              </button>
              <button onClick={handleCreate}
                disabled={!name.trim() || selectedActions.size === 0}
                className="px-4 h-9 rounded-lg text-[13px] font-medium text-white disabled:opacity-40"
                style={{ background: 'var(--accent)' }}>
                Create workflow
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={22} className="animate-spin" style={{ color: 'var(--muted)' }} />
          </div>
        ) : rules.length === 0 ? (
          <div className="py-16 text-center text-[13px]" style={{ color: 'var(--muted)' }}>
            No workflows yet. Create one to automate simple status-change actions.
          </div>
        ) : (
          <div className="space-y-2">
            {rules.map((rule) => {
              const toStatus = (rule.trigger_config as any)?.to_status ?? '—';
              const cfg = rule.action_config as any;
              const actions = Array.isArray(cfg?.actions) ? cfg.actions : [cfg];
              const actionSummary = actions
                .map((a: any) => a?.kind || rule.action_type)
                .join(', ');
              return (
                <div key={rule.id} className="p-3 rounded-lg flex items-center justify-between"
                  style={{ background: 'var(--surface-container)', border: '1px solid var(--border)' }}>
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium truncate" style={{ color: 'var(--foreground)' }}>
                      {rule.name}
                    </div>
                    <div className="text-[11px] mt-0.5" style={{ color: 'var(--muted)' }}>
                      When status → <strong>{toStatus}</strong>, do <strong>{actionSummary}</strong>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => handleToggleActive(rule)}
                      className="text-[11px] px-2 py-1 rounded"
                      style={{
                        background: rule.is_active ? 'var(--accent-subtle)' : 'var(--surface-container-low)',
                        color: rule.is_active ? 'var(--accent)' : 'var(--muted)',
                      }}>
                      {rule.is_active ? 'Active' : 'Paused'}
                    </button>
                    <button onClick={() => handleDelete(rule)}
                      className="p-1.5 rounded" style={{ color: 'var(--muted)' }} title="Delete">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function ActionRow({
  label,
  enabled,
  onToggle,
  children,
}: {
  label: string;
  enabled: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 p-2 rounded-lg"
      style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border)' }}>
      <label className="flex items-center gap-2 min-w-[130px] flex-shrink-0 cursor-pointer">
        <input type="checkbox" checked={enabled} onChange={onToggle} />
        <span className="text-[12px]" style={{ color: 'var(--foreground)' }}>{label}</span>
      </label>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
