'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { useChatContext } from '@/lib/chat-context';
import { formatRelative } from '@/lib/time';
import { Loader2, Scale, Link as LinkIcon, CheckSquare, FileText, BookOpen } from 'lucide-react';

const TYPE_CONFIG: Record<string, { label: string; color: string; icon: React.ComponentType<any> }> = {
  decision: { label: 'Decisions', color: '#D4A853', icon: Scale },
  resource: { label: 'Resources', color: '#5B8FA8', icon: LinkIcon },
  action_item: { label: 'Actions', color: '#C97B6B', icon: CheckSquare },
  note: { label: 'Notes', color: '#7C9885', icon: FileText },
};

type KnowledgeEntry = {
  id: string;
  type: string;
  title: string;
  content: string | null;
  url: string | null;
  space_id: string;
  space_name?: string;
  created_by_name?: string;
  created_at: string;
};

export default function KnowledgePage() {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('all');
  const { spaces } = useChatContext();

  useEffect(() => {
    setLoading(true);
    // Fetch knowledge from all spaces
    const fetchAll = async () => {
      const allEntries: KnowledgeEntry[] = [];
      for (const space of spaces) {
        try {
          const url = filter === 'all'
            ? `/api/spaces/${space.id}/knowledge`
            : `/api/spaces/${space.id}/knowledge?type=${filter}`;
          const res = await api.get(url);
          if (res.ok) {
            const data = await res.json();
            const items = (Array.isArray(data) ? data : data.entries || []).map((e: any) => ({
              ...e,
              space_name: space.name,
            }));
            allEntries.push(...items);
          }
        } catch {}
      }
      allEntries.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setEntries(allEntries);
      setLoading(false);
    };
    if (spaces.length > 0) fetchAll();
    else setLoading(false);
  }, [spaces, filter]);

  const filters = [
    { value: 'all', label: 'All' },
    { value: 'decision', label: 'Decisions' },
    { value: 'resource', label: 'Resources' },
    { value: 'action_item', label: 'Actions' },
    { value: 'note', label: 'Notes' },
  ];

  return (
    <div className="flex flex-col h-full p-4 md:p-6 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 flex-shrink-0">
        <div className="flex items-center gap-2">
          <BookOpen size={20} style={{ color: 'var(--accent)' }} />
          <h1 className="text-[18px] font-semibold" style={{ color: 'var(--text-primary)' }}>Knowledge</h1>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 mb-4 flex-shrink-0 overflow-x-auto">
        {filters.map((f) => (
          <button key={f.value} onClick={() => setFilter(f.value)}
            className="px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors flex-shrink-0"
            style={{
              background: filter === f.value ? 'var(--accent)' : 'var(--surface-container-low)',
              color: filter === f.value ? 'white' : 'var(--text-secondary)',
            }}>
            {f.label}
          </button>
        ))}
      </div>

      {/* Entries */}
      <div className="flex-1 overflow-y-auto space-y-2">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} />
          </div>
        ) : entries.length === 0 ? (
          <div className="text-center py-12">
            <BookOpen size={24} style={{ color: 'var(--text-tertiary)', margin: '0 auto 8px' }} />
            <p className="text-[13px]" style={{ color: 'var(--text-tertiary)' }}>No knowledge entries yet</p>
            <p className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
              Capture decisions, resources, and action items from chat
            </p>
          </div>
        ) : (
          entries.map((entry) => {
            const config = TYPE_CONFIG[entry.type] || TYPE_CONFIG.note!;
            const Icon = config.icon;
            return (
              <div key={entry.id}
                className="p-3 rounded-lg"
                style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{ background: `${config.color}20` }}>
                    <Icon size={14} style={{ color: config.color }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                        {entry.title}
                      </span>
                      <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0"
                        style={{ background: `${config.color}20`, color: config.color }}>
                        {config.label.replace(/s$/, '')}
                      </span>
                    </div>
                    {entry.content && (
                      <p className="text-[12px] line-clamp-2 mb-1" style={{ color: 'var(--text-secondary)' }}>
                        {entry.content.replace(/<[^>]+>/g, '')}
                      </p>
                    )}
                    {entry.url && (
                      <a href={entry.url} target="_blank" rel="noopener noreferrer"
                        className="text-[11px] hover:underline" style={{ color: 'var(--accent)' }}>
                        {entry.url}
                      </a>
                    )}
                    <div className="flex items-center gap-2 mt-1.5 text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                      <span>#{entry.space_name}</span>
                      <span>&middot;</span>
                      <span>{formatRelative(entry.created_at)}</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
