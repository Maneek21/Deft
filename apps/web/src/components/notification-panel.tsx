'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/time';
import { Bell, Check, MessageSquare, AtSign, CheckSquare, AlertCircle, Clock, Headphones } from 'lucide-react';

type Notification = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  is_read: boolean;
  link: string | null;
  created_at: string;
};

// relativeTime imported as formatRelative from @/lib/time

function notificationIcon(type: string) {
  switch (type) {
    case 'mention': return AtSign;
    case 'message': return MessageSquare;
    case 'task': return CheckSquare;
    case 'task_assigned': return CheckSquare;
    case 'task_updated': return CheckSquare;
    case 'reminder': return Clock;
    case 'huddle_started': return Headphones;
    default: return AlertCircle;
  }
}

type Props = {
  onClose: () => void;
  onCountSync?: (count: number) => void;
};

export function NotificationPanel({ onClose, onCountSync }: Props) {
  const router = useRouter();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await api.get('/api/notifications');
        if (res.ok) {
          const data = await res.json();
          const notifs = data.notifications || data || [];
          setNotifications(notifs);
          // Sync accurate unread count back to the header badge
          if (onCountSync) {
            const unreadCount = notifs.filter((n: Notification) => !n.is_read).length;
            onCountSync(unreadCount);
          }
        }
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  const handleMarkRead = async (id: string) => {
    await api.patch(`/api/notifications/${id}/read`);
    setNotifications((prev) => {
      const updated = prev.map((n) => (n.id === id ? { ...n, is_read: true } : n));
      if (onCountSync) {
        onCountSync(updated.filter((n) => !n.is_read).length);
      }
      return updated;
    });
  };

  const handleMarkAllRead = async () => {
    await api.post('/api/notifications/read-all');
    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
    if (onCountSync) onCountSync(0);
  };

  const handleClick = (n: Notification) => {
    if (!n.is_read) handleMarkRead(n.id);
    if (n.link) {
      router.push(n.link);
    }
    onClose();
  };

  return (
    <div
      ref={ref}
      className="fixed bottom-0 left-0 right-0 z-[9999] max-h-[70vh] flex flex-col overflow-hidden rounded-t-2xl md:rounded-xl md:absolute md:bottom-auto md:left-auto md:right-0 md:top-full md:mt-2 md:w-[340px] md:max-h-[480px]"
      style={{
        background: 'var(--surface-container-highest)',
        boxShadow: 'var(--glass-shadow)',
        backdropFilter: 'blur(12px)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {/* Header */}
      <div
        className="px-4 py-3 flex items-center justify-between flex-shrink-0"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <span
          className="text-[13px] font-semibold"
          style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
        >
          Notifications
        </span>
        <button
          onClick={handleMarkAllRead}
          className="text-[11px] font-medium px-2 py-2 md:py-1 rounded-md min-h-[36px] flex items-center"
          style={{ color: 'var(--accent)', fontFamily: 'var(--font-body)' }}
        >
          Mark all read
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="flex gap-1.5">
              <div className="skeleton w-1.5 h-1.5 rounded-full" />
              <div className="skeleton w-1.5 h-1.5 rounded-full" style={{ animationDelay: '0.2s' }} />
              <div className="skeleton w-1.5 h-1.5 rounded-full" style={{ animationDelay: '0.4s' }} />
            </div>
          </div>
        ) : notifications.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center py-12 gap-2"
            style={{ color: 'var(--muted)' }}
          >
            <Bell size={24} strokeWidth={1.5} />
            <span className="text-[13px]" style={{ fontFamily: 'var(--font-body)' }}>
              No notifications
            </span>
          </div>
        ) : (
          notifications.map((n) => {
            const Icon = notificationIcon(n.type);
            return (
              <button
                key={n.id}
                onClick={() => handleClick(n)}
                className="w-full text-left px-4 py-3 flex gap-3 transition-colors"
                style={{
                  background: n.is_read ? 'transparent' : 'var(--hover-tint)',
                  borderBottom: '1px solid var(--border)',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.background = 'var(--hover-tint)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.background = n.is_read
                    ? 'transparent'
                    : 'var(--hover-tint)';
                }}
              >
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
                  style={{ background: 'var(--surface)', color: 'var(--muted)' }}
                >
                  <Icon size={14} strokeWidth={1.5} />
                </div>
                <div className="flex-1 min-w-0">
                  <p
                    className="text-[13px] leading-snug"
                    style={{
                      color: 'var(--foreground)',
                      fontFamily: 'var(--font-body)',
                      fontWeight: n.is_read ? 400 : 500,
                    }}
                  >
                    {n.title}
                  </p>
                  {n.body && (
                    <p
                      className="text-[12px] mt-0.5 truncate"
                      style={{ color: 'var(--muted)' }}
                    >
                      {n.body}
                    </p>
                  )}
                  <p className="text-[11px] mt-1" style={{ color: 'var(--muted)' }}>
                    {formatRelative(n.created_at)}
                  </p>
                </div>
                {!n.is_read && (
                  <div
                    className="w-2 h-2 rounded-full flex-shrink-0 mt-1.5"
                    style={{ background: 'var(--accent)' }}
                  />
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
