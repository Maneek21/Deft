'use client';
import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/lib/api';
import { formatShortDate } from '@/lib/time';
import { Bookmark, X, Hash } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { stripHtml } from '@/lib/strip-html';

type SavedMessage = {
  id: string;
  message_id: string;
  space_id: string;
  message_content: string;
  message_created_at: string;
  author_name: string;
  space_name: string;
  created_at: string;
};

export function SavedMessages({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<SavedMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    api.get('/api/bookmarks').then(async res => {
      if (res.ok) setItems(await res.json());
      setLoading(false);
    });
  }, []);

  const handleRemove = async (messageId: string) => {
    const res = await api.delete(`/api/bookmarks/${messageId}`);
    if (res.ok) {
      setItems(prev => prev.filter(i => i.message_id !== messageId));
    }
  };

  const handleJump = (item: SavedMessage) => {
    router.push(`/chat?space=${item.space_id}&message=${item.message_id}`);
    onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-[calc(100vw-2rem)] max-w-[480px] max-h-[90vh] flex flex-col rounded-xl overflow-hidden"
        style={{ background: 'var(--surface-container)', boxShadow: 'var(--glass-shadow)' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--ghost-border)' }}>
          <div className="flex items-center gap-2">
            <Bookmark size={16} strokeWidth={1.5} style={{ color: 'var(--primary)' }} />
            <h2 className="text-[0.9375rem] font-semibold" style={{ color: 'var(--on-surface)' }}>
              Saved Items
            </h2>
            {items.length > 0 && (
              <span className="text-[0.6875rem] px-1.5 py-0.5 rounded-full"
                style={{ background: 'var(--surface-container-high)', color: 'var(--outline)', fontFamily: 'var(--font-mono)' }}>
                {items.length}
              </span>
            )}
          </div>
          <button onClick={onClose} className="p-2 md:p-1 rounded-md min-w-[36px] min-h-[36px] flex items-center justify-center" style={{ color: 'var(--outline)' }}>
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-8 text-center text-[0.8125rem]" style={{ color: 'var(--outline)' }}>
              Loading...
            </div>
          ) : items.length === 0 ? (
            <div className="p-8 text-center">
              <Bookmark size={32} strokeWidth={1} style={{ color: 'var(--outline)', margin: '0 auto 12px' }} />
              <p className="text-[0.8125rem]" style={{ color: 'var(--outline)' }}>
                No saved messages yet
              </p>
              <p className="text-[0.75rem] mt-1" style={{ color: 'var(--outline)' }}>
                Hover over a message and click the bookmark icon to save it here.
              </p>
            </div>
          ) : (
            items.map(item => {
              const text = stripHtml(item.message_content).replace(/\[\[file:[^\]]+\]\]/g, '').trim();
              return (
                <div key={item.id}
                  className="px-5 py-3 flex gap-3 group cursor-pointer"
                  style={{ borderBottom: '1px solid var(--ghost-border)' }}
                  onClick={() => handleJump(item)}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[0.75rem] font-medium" style={{ color: 'var(--on-surface)' }}>
                        {item.author_name}
                      </span>
                      <span className="flex items-center gap-1 text-[0.6875rem]" style={{ color: 'var(--outline)' }}>
                        <Hash size={9} strokeWidth={2} />
                        {item.space_name}
                      </span>
                      <span className="text-[0.6875rem]"
                        style={{ color: 'var(--outline)', fontFamily: 'var(--font-mono)' }}>
                        {formatShortDate(item.message_created_at)}
                      </span>
                    </div>
                    <p className="text-[0.8125rem] leading-relaxed truncate"
                      style={{ color: 'var(--on-surface-variant)' }}>
                      {text.slice(0, 200)}{text.length > 200 ? '...' : ''}
                    </p>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleRemove(item.message_id); }}
                    className="flex-shrink-0 p-1.5 rounded-md opacity-0 group-hover:opacity-100 self-start"
                    style={{ color: 'var(--outline)' }}
                    title="Remove from saved"
                  >
                    <X size={14} strokeWidth={1.5} />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
