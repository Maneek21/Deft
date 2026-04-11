'use client';
import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/time';
import { X, Clock, Trash2 } from 'lucide-react';

type ScheduledMsg = {
  id: string;
  content: string;
  scheduled_for: string;
  status: string;
};

type Props = { onClose: () => void };

export function ScheduledPanel({ onClose }: Props) {
  const [items, setItems] = useState<ScheduledMsg[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/api/scheduled-messages').then(async res => {
      if (res.ok) setItems(await res.json());
      setLoading(false);
    });
  }, []);

  const handleCancel = async (id: string) => {
    await api.delete(`/api/scheduled-messages/${id}`);
    setItems(prev => prev.filter(i => i.id !== id));
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-[calc(100vw-2rem)] max-w-[400px] max-h-[90vh] flex flex-col rounded-xl overflow-hidden"
        style={{ background: 'var(--surface-container)', boxShadow: 'var(--glass-shadow)' }}>
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <Clock size={14} strokeWidth={1.5} style={{ color: 'var(--outline)' }} />
            <span className="text-[0.8125rem] font-semibold" style={{ color: 'var(--on-surface)' }}>Scheduled Messages</span>
          </div>
          <button onClick={onClose} className="p-2 md:p-1 min-w-[36px] min-h-[36px] flex items-center justify-center" style={{ color: 'var(--outline)' }}><X size={14} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {loading ? (
            <p className="text-center py-8 text-[0.75rem]" style={{ color: 'var(--outline)' }}>Loading...</p>
          ) : items.length === 0 ? (
            <p className="text-center py-8 text-[0.75rem]" style={{ color: 'var(--outline)' }}>No scheduled messages</p>
          ) : items.map(item => (
            <div key={item.id} className="flex items-start gap-3 py-2">
              <div className="flex-1 min-w-0">
                <p className="text-[0.8125rem] truncate" style={{ color: 'var(--on-surface)' }}>
                  {item.content.replace(/<[^>]+>/g, '').slice(0, 80)}
                </p>
                <p className="text-[0.6875rem] mt-0.5" style={{ color: 'var(--outline)', fontFamily: 'var(--font-mono)' }}>
                  {formatDateTime(item.scheduled_for)}
                </p>
              </div>
              <button onClick={() => handleCancel(item.id)} className="p-2 md:p-1 flex-shrink-0 min-w-[36px] min-h-[36px] flex items-center justify-center" style={{ color: 'var(--status-red)' }}>
                <Trash2 size={13} strokeWidth={1.5} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
