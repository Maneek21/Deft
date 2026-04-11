'use client';
import { useState, useEffect } from 'react';
import { api } from '@/lib/api';

type Action = { id: string; action: string; params: any; approval_status: string; created_at: string; user_id: string };

const TRUST_LEVELS = [
  { value: 'conservative', label: 'Conservative', desc: 'Every action requires your approval.' },
  { value: 'standard', label: 'Standard', desc: 'Routine actions auto-execute. Complex ones need approval.' },
  { value: 'autonomous', label: 'Autonomous', desc: 'All actions auto-execute except external writes.' },
];

export default function AgentSettingsPage() {
  const [actions, setActions] = useState<Action[]>([]);
  const [trustLevel, setTrustLevel] = useState('conservative');

  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/api/agent/actions').then(async res => {
      if (res.ok) setActions(await res.json());
    });
    api.get('/api/agent/settings').then(async res => {
      if (res.ok) {
        const data = await res.json();
        setTrustLevel(data.trust_level || 'conservative');
      }
    });
  }, []);

  const labels: Record<string,string> = { create_task:'Create task', update_task_status:'Update status', assign_task:'Assign task', post_message:'Post message' };
  const statusColors: Record<string,string> = { pending:'var(--accent)', approved:'var(--success)', rejected:'var(--danger)', expired:'var(--muted)' };

  return (
    <div className="p-6 max-w-[700px]">
      <h2 className="text-[18px] font-semibold mb-6" style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}>Agent Settings</h2>

      <div className="mb-8">
        <h3 className="text-[14px] font-semibold mb-3" style={{ color: 'var(--on-surface)', fontFamily: 'var(--font-heading)' }}>Trust Level</h3>
        <div className="grid grid-cols-3 gap-3">
          {TRUST_LEVELS.map(t => (
            <button key={t.value}
              onClick={async () => {
                setTrustLevel(t.value);
                setSaving(true);
                try {
                  await api.patch('/api/agent/settings', { trust_level: t.value });
                } catch {}
                setSaving(false);
              }}
              className="p-4 rounded-lg text-left"
              style={{
                background: trustLevel === t.value ? 'var(--bg-active)' : 'var(--surface-container)',
                border: trustLevel === t.value ? '1px solid var(--primary-container)' : '1px solid transparent',
              }}>
              <p className="text-[13px] font-medium" style={{ color: 'var(--on-surface)' }}>{t.label}</p>
              <p className="text-[11px] mt-1" style={{ color: 'var(--outline)' }}>{t.desc}</p>
            </button>
          ))}
        </div>
        {saving && <p className="text-[11px] mt-2" style={{ color: 'var(--outline)' }}>Saving...</p>}
      </div>

      <h3 className="text-[14px] font-semibold mb-3" style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}>Action Log</h3>
      {actions.length === 0 ? (
        <p className="text-[13px]" style={{ color: 'var(--muted)' }}>No agent actions yet.</p>
      ) : (
        <div className="space-y-1.5">
          {actions.map(a => (
            <div key={a.id} className="flex items-center gap-3 px-3 py-2 rounded-lg text-[12px]" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}>
              <span style={{ color: 'var(--foreground)' }}>{labels[a.action] || a.action}</span>
              <span className="flex-1 truncate" style={{ color: 'var(--muted)' }}>
                {a.params?.title || a.params?.task_identifier || a.params?.space_name || ''}
              </span>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                style={{ color: statusColors[a.approval_status] || 'var(--muted)' }}>
                {a.approval_status}
              </span>
              <span style={{ color: 'var(--muted)' }}>
                {new Date(a.created_at).toLocaleDateString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
