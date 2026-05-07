'use client';

import { useState, useRef, useEffect, ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { Search, Bell, Menu, Moon } from 'lucide-react';
import { NotificationPanel } from './notification-panel';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { useAuth } from '@/lib/auth-context';

const OPEN_COMMAND_PALETTE_EVENT = 'deft:open-command-palette';

export function AppHeader({
  onMenuClick,
  pageContext,
}: {
  onMenuClick?: () => void;
  pageContext?: ReactNode;
}) {
  const pathname = usePathname();
  const { user } = useAuth();
  const isDnd = user?.status_text === 'Do Not Disturb';
  const [notifOpen, setNotifOpen] = useState(false);
  const [unreadNotifCount, setUnreadNotifCount] = useState(0);
  const bellRef = useRef<HTMLButtonElement>(null);

  let placeholder = 'Search workspace... ⌘K';
  if (pathname.startsWith('/chat')) placeholder = 'Search messages... ⌘K';
  if (pathname.startsWith('/tasks')) placeholder = 'Search tasks... ⌘K';

  // Fetch unread notification count on mount
  useEffect(() => {
    api.get('/api/notifications').then(async res => {
      if (res.ok) {
        const data = await res.json();
        setUnreadNotifCount(data.unread_count ?? 0);
      }
    });
  }, []);

  // Listen for real-time notifications
  useEffect(() => {
    const token = localStorage.getItem('deft-access-token');
    if (!token) return;
    const socket = getSocket(token);
    const handler = () => {
      setUnreadNotifCount(prev => prev + 1);
    };
    socket.on('notification:new', handler);
    return () => { socket.off('notification:new', handler); };
  }, []);

  const handleSearchClick = () => {
    document.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT));
  };

  const handleNotifOpen = () => {
    setNotifOpen(!notifOpen);
  };

  const handleCountSync = (count: number) => {
    setUnreadNotifCount(count);
  };

  return (
    <div className="h-12 flex items-center gap-3 px-4 flex-shrink-0" style={{ background: 'transparent' }}>
      {/* Mobile menu button */}
      {onMenuClick && (
        <button
          onClick={onMenuClick}
          className="md:hidden flex items-center justify-center min-w-[44px] min-h-[44px] -ml-1 rounded-lg"
          style={{ color: 'var(--on-surface-variant)' }}
        >
          <Menu size={18} strokeWidth={1.5} />
        </button>
      )}
      {/* Page context slot */}
      <div className="flex-1 min-w-0 flex items-center gap-2">
        {pageContext}
      </div>

      {/* Search — full bar on desktop, icon-only on mobile */}
      <button
        onClick={handleSearchClick}
        className="hidden md:flex items-center gap-2 px-3 h-8 rounded-lg cursor-pointer"
        style={{ background: 'var(--surface-container-low)', minWidth: '200px' }}
      >
        <Search size={14} strokeWidth={1.5} style={{ color: 'var(--outline)' }} />
        <span className="text-[0.75rem] flex-1 text-left" style={{ color: 'var(--outline)' }}>{placeholder}</span>
      </button>
      <button
        onClick={handleSearchClick}
        className="md:hidden flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg cursor-pointer"
        style={{ color: 'var(--outline)' }}
      >
        <Search size={18} strokeWidth={1.5} />
      </button>

      {/* DND indicator */}
      {isDnd && (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium"
          style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b' }}
          title="Do Not Disturb is on">
          <Moon size={12} />
          <span className="hidden md:inline">DND</span>
        </div>
      )}

      {/* Notification bell */}
      <div className="relative">
        <button
          ref={bellRef}
          onClick={handleNotifOpen}
          aria-label="Notifications"
          title="Notifications"
          className="flex items-center justify-center min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0 md:p-1.5 p-3 rounded-md relative"
          style={{ color: 'var(--outline)' }}
        >
          <Bell size={16} strokeWidth={1.5} />
          {unreadNotifCount > 0 && (
            <div
              className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] rounded-full flex items-center justify-center text-[9px] font-bold text-white px-0.5"
              style={{ background: 'var(--status-red)' }}
            >
              {unreadNotifCount > 99 ? '99+' : unreadNotifCount}
            </div>
          )}
        </button>
        {notifOpen && <NotificationPanel onClose={() => setNotifOpen(false)} onCountSync={handleCountSync} />}
      </div>
    </div>
  );
}
