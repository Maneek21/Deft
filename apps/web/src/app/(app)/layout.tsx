'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';

import { ChatContext } from '@/lib/chat-context';
import { Sidebar } from '@/components/sidebar';
import { CommandPalette } from '@/components/command-palette';
import { KeyboardShortcuts } from '@/components/keyboard-shortcuts';
import { AppHeader } from '@/components/app-header';
import { AppHeaderProvider, useAppHeaderContext } from '@/components/app-header-context';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { useHuddle } from '@/hooks/use-huddle';
import { useAudioLevels } from '@/hooks/use-audio-levels';
import { HuddleOverlay } from '@/components/huddle-overlay';
import { HuddleRingToast } from '@/components/huddle-ring-toast';
import { HUDDLES_ENABLED } from '@/lib/feature-flags';
import { Logo } from '@/components/brand/logo';

type Space = {
  id: string;
  name: string;
  type: string;
  description: string | null;
  topic: string | null;
  is_default: boolean;
  is_muted?: boolean;
};

function AppHeaderHost({ onMenuClick }: { onMenuClick?: () => void }) {
  const { pageContext } = useAppHeaderContext();
  return <AppHeader onMenuClick={onMenuClick} pageContext={pageContext} />;
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const [presence, setPresence] = useState<Map<string, 'online' | 'idle' | 'offline'>>(new Map());
  const [threadMessage, setThreadMessage] = useState<{
    id: string;
    content: string;
    user_id: string;
    user_name: string;
    user_avatar: string | null;
    is_deleted: boolean;
    edited_at: string | null;
    created_at: string;
    reactions?: { emoji: string; count: number; users: string[] }[];
    file_ids?: string[];
  } | null>(null);
  const [unreadCounts, setUnreadCounts] = useState<Map<string, number>>(new Map());
  const [mentionCounts, setMentionCounts] = useState<Map<string, number>>(new Map());
  const [orgMembers, setOrgMembers] = useState<{ id: string; name: string; email: string; avatar_url: string | null; status_emoji?: string | null; status_text?: string | null }[]>([]);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const pendingChord = useRef<string | null>(null);
  const chordTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const unreadMutationVersions = useRef<Map<string, number>>(new Map());
  const pendingReadRequests = useRef<Map<string, number>>(new Map());
  const spacesLoadGeneration = useRef(0);
  const huddleState = useHuddle();
  const huddleStreams = huddleState.getStreams();
  const speakingMap = useAudioLevels(huddleStreams.localStream, user?.id || null, huddleStreams.peers);

  useEffect(() => {
    if (!loading && !user) {
      router.push('/login');
    }
  }, [user, loading, router]);

  // Redirect users with incomplete onboarding to /welcome. Owners who
  // bootstrap a workspace go through /setup; everyone else (invited members)
  // flows through /welcome. Skip if we're already there to avoid loops.
  useEffect(() => {
    if (!user) return;
    const role = (user as { role?: string }).role;
    if (role === 'owner') return; // owners use /setup, not /welcome
    if (pathname === '/welcome' || pathname === '/setup') return;
    api.get('/api/auth/onboarding').then(async (r) => {
      if (!r.ok) return;
      const state = await r.json();
      if (state && state.completed === false) {
        router.replace('/welcome');
      }
    }).catch(() => {});
  }, [user, pathname, router]);

  // Auto-detect and save timezone if not set or still default 'UTC'
  useEffect(() => {
    if (!user) return;
    const tz = (user as { timezone?: string | null }).timezone;
    if (!tz || tz === 'UTC') {
      const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (detected && detected !== 'UTC') {
        api.patch('/api/auth/me', { timezone: detected }).catch(() => {});
        // Also update the time utility immediately
        import('@/lib/time').then(({ setUserTimezone }) => setUserTimezone(detected));
      }
    }
  }, [user]);

  const loadSpaces = useCallback(async () => {
    if (!user) return;
    const loadGeneration = ++spacesLoadGeneration.current;
    const unreadVersionsAtStart = new Map(unreadMutationVersions.current);
    const pendingReadsAtStart = new Map(pendingReadRequests.current);
    const res = await api.get('/api/spaces');
    if (!res.ok || loadGeneration !== spacesLoadGeneration.current) return;
    const loadedSpaces: Space[] = await res.json();
    if (loadGeneration !== spacesLoadGeneration.current) return;

    const loadedSpaceIds = new Set(loadedSpaces.map((space) => space.id));
    setSpaces(loadedSpaces);
    setActiveSpaceId((prev) => {
      if (prev && loadedSpaceIds.has(prev)) return prev;
      const defaultSpace = loadedSpaces.find((space) => space.is_default);
      return defaultSpace?.id || loadedSpaces[0]?.id || null;
    });
    setUnreadCounts((previous) => new Map(
      [...previous].filter(([spaceId]) => loadedSpaceIds.has(spaceId)),
    ));
    setMentionCounts((previous) => new Map(
      [...previous].filter(([spaceId]) => loadedSpaceIds.has(spaceId)),
    ));

    // Fetch initial unread counts from DB
    const unreadRes = await api.get('/api/spaces/unread');
    if (unreadRes.ok && loadGeneration === spacesLoadGeneration.current) {
      const counts: { space_id: string; unread: number }[] = await unreadRes.json();
      if (loadGeneration !== spacesLoadGeneration.current) return;
      const serverCounts = new Map(counts.map((count) => [count.space_id, count.unread]));
      setUnreadCounts((previous) => {
        const next = new Map<string, number>();
        for (const space of loadedSpaces) {
          const versionAtStart = unreadVersionsAtStart.get(space.id) ?? 0;
          const currentVersion = unreadMutationVersions.current.get(space.id) ?? 0;
          if (versionAtStart !== currentVersion || pendingReadsAtStart.has(space.id)) {
            const currentUnread = previous.get(space.id) ?? 0;
            if (currentUnread > 0) next.set(space.id, currentUnread);
            continue;
          }

          const unread = serverCounts.get(space.id) ?? 0;
          if (unread > 0) next.set(space.id, unread);
          else next.delete(space.id);
        }
        return next;
      });
    }
  }, [user]);

  // Load org members
  useEffect(() => {
    if (!user) return;
    async function loadMembers() {
      const res = await api.get('/api/members');
      if (res.ok) setOrgMembers(await res.json());
    }
    loadMembers();
  }, [user]);

  useEffect(() => {
    loadSpaces();
  }, [loadSpaces]);

  const markSpaceRead = useCallback(
    async (spaceId: string) => {
      const mutationVersion = (unreadMutationVersions.current.get(spaceId) ?? 0) + 1;
      unreadMutationVersions.current.set(spaceId, mutationVersion);
      pendingReadRequests.current.set(spaceId, mutationVersion);
      setUnreadCounts((prev) => {
        const next = new Map(prev);
        next.delete(spaceId);
        return next;
      });
      setMentionCounts((prev) => {
        const next = new Map(prev);
        next.delete(spaceId);
        return next;
      });
      let shouldReload = false;
      try {
        const response = await api.post(`/api/spaces/${spaceId}/read`);
        shouldReload = !response.ok;
      } catch {
        shouldReload = true;
      } finally {
        if (pendingReadRequests.current.get(spaceId) === mutationVersion) {
          pendingReadRequests.current.delete(spaceId);
        }
        if (shouldReload) void loadSpaces();
      }
    },
    [loadSpaces]
  );

  const refreshSpaces = useCallback(() => {
    loadSpaces();
  }, [loadSpaces]);

  // Socket: presence, notifications, unread
  useEffect(() => {
    const token = localStorage.getItem('deft-access-token');
    if (!token) return;
    const socket = getSocket(token);

    // Initial presence snapshot from server
    const handlePresenceInit = (list: { user_id: string; status: 'online' | 'idle' }[]) => {
      setPresence((prev) => {
        const next = new Map(prev);
        for (const entry of list) {
          next.set(entry.user_id, entry.status);
        }
        return next;
      });
    };

    // Live presence updates
    const handlePresence = (data: { user_id: string; status: 'online' | 'idle' | 'offline' }) => {
      setPresence((prev) => {
        const next = new Map(prev);
        if (data.status === 'offline') {
          next.delete(data.user_id);
        } else {
          next.set(data.user_id, data.status);
        }
        return next;
      });
    };

    const handleNewMessage = (data: { space_id?: string; user_id?: string; parent_id?: string | null; has_mention?: boolean }) => {
      if (!data.space_id) return;
      if (data.user_id === user?.id) return;
      if (data.parent_id) return; // thread replies don't count as unread for the space

      setActiveSpaceId((currentActive) => {
        if (data.space_id !== currentActive || !pathname.startsWith('/chat')) {
          unreadMutationVersions.current.set(
            data.space_id!,
            (unreadMutationVersions.current.get(data.space_id!) ?? 0) + 1,
          );
          setUnreadCounts((prev) => {
            const next = new Map(prev);
            next.set(data.space_id!, (prev.get(data.space_id!) || 0) + 1);
            return next;
          });
          if (data.has_mention) {
            setMentionCounts((prev) => {
              const next = new Map(prev);
              next.set(data.space_id!, (prev.get(data.space_id!) || 0) + 1);
              return next;
            });
          }
        }
        return currentActive;
      });
    };

    socket.on('presence:init', handlePresenceInit);
    socket.on('presence:update', handlePresence);
    socket.on('notification:new', () => {});
    socket.on('message:new', handleNewMessage);

    // Update org members when someone changes their status
    socket.on('user:status_changed', (data: { user_id: string; status_emoji: string | null; status_text: string | null }) => {
      setOrgMembers(prev => prev.map(m =>
        m.id === data.user_id ? { ...m, status_emoji: data.status_emoji, status_text: data.status_text } : m
      ));
    });

    // Idle detection: 5 minutes of no mouse/keyboard → idle
    let idleTimer: ReturnType<typeof setTimeout>;
    let isIdle = false;

    const resetIdleTimer = () => {
      if (isIdle) {
        isIdle = false;
        socket.emit('presence:active');
      }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        isIdle = true;
        socket.emit('presence:idle');
      }, 5 * 60 * 1000);
    };

    window.addEventListener('mousemove', resetIdleTimer);
    window.addEventListener('keydown', resetIdleTimer);
    window.addEventListener('click', resetIdleTimer);
    resetIdleTimer();

    return () => {
      socket.off('presence:init', handlePresenceInit);
      socket.off('presence:update', handlePresence);
      socket.off('notification:new');
      socket.off('message:new', handleNewMessage);
      socket.off('user:status_changed');
      clearTimeout(idleTimer);
      window.removeEventListener('mousemove', resetIdleTimer);
      window.removeEventListener('keydown', resetIdleTimer);
      window.removeEventListener('click', resetIdleTimer);
    };
  }, [user?.id, pathname]);

  // Global keyboard shortcuts: ? for help, G then X for navigation, Shift+Esc mark all read
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      // Don't trigger in inputs
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        router.push('/settings');
        return;
      }

      if (e.key === 'Escape' && e.shiftKey) {
        e.preventDefault();
        // Mark all notifications as read
        void api.post('/api/notifications/read-all').catch(() => {});
        // Use the same optimistic mutation/version tracking as a single-space
        // read so an older unread refresh cannot repopulate cleared badges.
        void Promise.allSettled(spaces.map((space) => markSpaceRead(space.id)));
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'M' || e.key === 'm')) {
        e.preventDefault();
        if (activeSpaceId && pathname.startsWith('/chat')) {
          markSpaceRead(activeSpaceId);
        }
        return;
      }

      if (e.key === '?') {
        setShowShortcuts(true);
        return;
      }

      // Chord handling
      if (pendingChord.current) {
        const chord = pendingChord.current;
        pendingChord.current = null;
        clearTimeout(chordTimer.current);

        if (chord === 'g') {
          const secondKey = e.key.toLowerCase();
          if (['d', 'c', 't', 'a', 's', 'n', 'l', 'k', 'r'].includes(secondKey)) {
            e.preventDefault();
            e.stopImmediatePropagation();
            switch (secondKey) {
              case 'd': router.push('/dashboard'); break;
              case 'c': router.push('/chat'); break;
              case 't': router.push('/tasks'); break;
              case 'a': router.push('/inbox?tab=approvals'); break;
              case 's': router.push('/settings'); break;
              case 'n': router.push('/notes'); break;
              case 'l': router.push('/calendar'); break;
              case 'k': router.push('/knowledge'); break;
              case 'r': router.push('/reminders'); break;
            }
          }
        }
        return;
      }

      if (e.key === 'g') {
        pendingChord.current = 'g';
        chordTimer.current = setTimeout(() => { pendingChord.current = null; }, 1500);
        return;
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [router, activeSpaceId, pathname, spaces, markSpaceRead]);

  // Tracks the space id we just clicked. The URL update from router.replace
  // commits one render after our setState, so during that gap chat/page's
  // URL→state sync would call back into the state setter with the STALE
  // urlSpaceId, causing the sidebar highlight to flash old→new→old→new. We
  // gate syncActiveSpaceIdFromUrl on this ref to ignore intermediate URL
  // states until the URL catches up to our intended target.
  const pendingSpaceIdRef = useRef<string | null>(null);

  const handleSelectSpace = useCallback(
    (id: string, options?: { navigate?: boolean }) => {
      pendingSpaceIdRef.current = id;
      setActiveSpaceId(id);
      setThreadMessage(null);
      if (options?.navigate === false) return;
      if (pathname.startsWith('/chat')) {
        // Preserve existing query params (e.g. ?thread=) but update ?space=
        const params = new URLSearchParams(window.location.search);
        params.set('space', id);
        router.replace(`/chat?${params.toString()}`);
      } else {
        router.push(`/chat?space=${id}`);
      }
    },
    [pathname, router],
  );

  const handleSidebarSelectSpace = useCallback(
    (id: string) => {
      handleSelectSpace(id, { navigate: false });
    },
    [handleSelectSpace],
  );

  const syncActiveSpaceIdFromUrl = useCallback((urlId: string) => {
    if (pendingSpaceIdRef.current !== null) {
      // URL has caught up to our pending click — clear the gate, the URL is
      // already the source of truth from here on.
      if (pendingSpaceIdRef.current === urlId) {
        pendingSpaceIdRef.current = null;
      }
      // Either way, don't override the just-set state with an in-flight
      // intermediate URL value.
      return;
    }
    setActiveSpaceId(urlId);
  }, []);

  const openDmWith = useCallback(
    async (memberId: string) => {
      const member = orgMembers.find((m) => m.id === memberId);
      if (!member || !user) return;
      // POST /api/spaces with type dm — backend deduplicates
      const res = await api.post('/api/spaces', {
        name: `${user.name}, ${member.name}`,
        type: 'dm',
        user_ids: [memberId],
      });
      if (res.ok) {
        const space = await res.json();
        // Refresh spaces to include the new/existing DM
        await loadSpaces();
        handleSelectSpace(space.id);
      }
    },
    [orgMembers, user, loadSpaces, handleSelectSpace],
  );

  if (loading) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ background: 'var(--surface-lowest)' }}
      >
        <div className="flex items-center gap-4">
          <Logo variant="icon" className="h-9 w-auto" priority />
          <div className="flex gap-1.5">
            <div className="skeleton w-1.5 h-1.5 rounded-full" />
            <div className="skeleton w-1.5 h-1.5 rounded-full" style={{ animationDelay: '0.2s' }} />
            <div className="skeleton w-1.5 h-1.5 rounded-full" style={{ animationDelay: '0.4s' }} />
          </div>
        </div>
      </div>
    );
  }

  if (!user) return null;

  return (
    <ChatContext.Provider
      value={{
        spaces,
        activeSpaceId,
        setActiveSpaceId: handleSelectSpace,
        syncActiveSpaceIdFromUrl,
        presence,
        threadMessage,
        setThreadMessage,
        unreadCounts,
        mentionCounts,
        markSpaceRead,
        refreshSpaces,
        orgMembers,
        openDmWith,
        startHuddle: huddleState.startHuddle,
        joinHuddleBySpace: huddleState.joinHuddleBySpace,
        huddleSpaceId: huddleState.active ? huddleState.spaceId : null,
        activeHuddles: huddleState.activeHuddles,
      }}
    >
      <AppHeaderProvider>
        <div className="flex h-dvh" style={{ background: 'var(--background)' }}>
          <Sidebar
            spaces={spaces}
            activeSpaceId={activeSpaceId}
            onSelectSpace={handleSidebarSelectSpace}
            presence={presence}
            mobileOpen={mobileMenuOpen}
            setMobileOpen={setMobileMenuOpen}
          />
          <main className="flex-1 overflow-hidden flex flex-col">
            <AppHeaderHost onMenuClick={() => setMobileMenuOpen(true)} />
            <div className="flex-1 overflow-hidden">{children}</div>
          </main>
          <CommandPalette />
          <KeyboardShortcuts open={showShortcuts} onClose={() => setShowShortcuts(false)} />
          {HUDDLES_ENABLED && huddleState.active && huddleState.huddleId && huddleState.spaceId && (
            <HuddleOverlay
              huddleId={huddleState.huddleId}
              spaceId={huddleState.spaceId}
              participants={huddleState.participants}
              muted={huddleState.muted}
              duration={huddleState.duration}
              expanded={huddleState.expanded}
              speakingMap={speakingMap}
              onToggleMute={huddleState.toggleMute}
              onToggleExpanded={huddleState.toggleExpanded}
              onLeave={huddleState.leaveHuddle}
            />
          )}
          {HUDDLES_ENABLED && huddleState.pendingRings.length > 0 && (
            <HuddleRingToast
              rings={huddleState.pendingRings}
              onJoin={huddleState.joinHuddleBySpace}
              onDismiss={huddleState.dismissRing}
            />
          )}
        </div>
      </AppHeaderProvider>
    </ChatContext.Provider>
  );
}
