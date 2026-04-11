'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { formatRelative, formatDateTime } from '@/lib/time';
import { Clock, Loader2, Trash2, X } from 'lucide-react';

type Reminder = {
  id: string;
  content: string;
  remind_at: string;
  source_message_id: string | null;
  status: string;
  created_at: string;
};

export default function RemindersPage() {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/api/reminders').then(async (res) => {
      if (res.ok) setReminders(await res.json());
    }).finally(() => setLoading(false));
  }, []);

  const handleDelete = async (id: string) => {
    const res = await api.delete(`/api/reminders/${id}`);
    if (res.ok) setReminders(prev => prev.filter(r => r.id !== id));
  };

  const upcoming = reminders.filter(r => new Date(r.remind_at) > new Date());
  const past = reminders.filter(r => new Date(r.remind_at) <= new Date());

  return (
    <div className="flex flex-col h-full p-4 md:p-6 overflow-hidden">
      <div className="flex items-center gap-2 mb-4 flex-shrink-0">
        <Clock size={20} style={{ color: 'var(--accent)' }} />
        <h1 className="text-[18px] font-semibold" style={{ color: 'var(--text-primary)' }}>Reminders</h1>
      </div>

      <div className="flex-1 overflow-y-auto space-y-6">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} />
          </div>
        ) : reminders.length === 0 ? (
          <div className="text-center py-12">
            <Clock size={24} style={{ color: 'var(--text-tertiary)', margin: '0 auto 8px' }} />
            <p className="text-[13px]" style={{ color: 'var(--text-tertiary)' }}>No reminders</p>
            <p className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
              Set reminders from the message action menu in chat
            </p>
          </div>
        ) : (
          <>
            {upcoming.length > 0 && (
              <div>
                <h2 className="text-[12px] font-semibold uppercase tracking-wider mb-2"
                  style={{ color: 'var(--text-tertiary)' }}>Upcoming</h2>
                <div className="space-y-2">
                  {upcoming.map((r) => (
                    <ReminderCard key={r.id} reminder={r} onDelete={handleDelete} />
                  ))}
                </div>
              </div>
            )}
            {past.length > 0 && (
              <div>
                <h2 className="text-[12px] font-semibold uppercase tracking-wider mb-2"
                  style={{ color: 'var(--text-tertiary)' }}>Past</h2>
                <div className="space-y-2 opacity-60">
                  {past.map((r) => (
                    <ReminderCard key={r.id} reminder={r} onDelete={handleDelete} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ReminderCard({ reminder, onDelete }: { reminder: Reminder; onDelete: (id: string) => void }) {
  const isPast = new Date(reminder.remind_at) <= new Date();
  return (
    <div className="p-3 rounded-lg flex items-start gap-3"
      style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
      <Clock size={14} className="mt-0.5 flex-shrink-0"
        style={{ color: isPast ? 'var(--text-tertiary)' : 'var(--accent)' }} />
      <div className="flex-1 min-w-0">
        <p className="text-[13px]" style={{ color: 'var(--text-primary)' }}>
          {reminder.content}
        </p>
        <p className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
          {isPast ? `Was due ${formatRelative(reminder.remind_at)}` : formatDateTime(reminder.remind_at)}
        </p>
      </div>
      <button onClick={() => onDelete(reminder.id)}
        className="p-1 rounded hover:opacity-70 flex-shrink-0"
        style={{ color: 'var(--text-tertiary)' }} title="Delete">
        <Trash2 size={13} />
      </button>
    </div>
  );
}
