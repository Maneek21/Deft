'use client';

import { useState, useEffect, useRef } from 'react';
import { api } from '@/lib/api';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { useChatContext } from '@/lib/chat-context';
import { formatRelative } from '@/lib/time';
import { X, MessageSquare, Clock, MapPin, Pencil } from 'lucide-react';

type ProfileData = {
  id: string;
  name: string;
  email: string;
  avatar_url: string | null;
  title: string | null;
  profile_summary: string | null;
  expertise_tags: string[] | null;
  timezone: string | null;
  status_emoji: string | null;
  status_text: string | null;
  last_seen_at: string | null;
  role: string;
};

const AVATAR_COLORS = ['#D4A853', '#7C9885', '#8B7EC8', '#C97B6B', '#5B8FA8', '#A0845C'];

function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]!;
}

function getLocalTime(timezone: string | null): string {
  try {
    return new Date().toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: timezone || 'UTC',
    });
  } catch { return ''; }
}

export function UserProfileCard({
  userId, anchorRect, onClose,
}: {
  userId: string;
  anchorRect: { top: number; left: number; bottom: number };
  onClose: () => void;
}) {
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const { presence, openDmWith } = useChatContext();
  const { user } = useAuth();
  const cardRef = useRef<HTMLDivElement>(null);

  const status = presence.get(userId) || 'offline';
  const isSelf = user?.id === userId;

  useEffect(() => {
    api.get(`/api/members/${userId}`).then(async (res) => {
      if (res.ok) setProfile(await res.json());
    }).finally(() => setLoading(false));
  }, [userId]);

  // Close on click outside + Escape
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('mousedown', handleClick); document.removeEventListener('keydown', handleKey); };
  }, [onClose]);

  // Position: try to show below anchor, flip above if no space
  const top = anchorRect.bottom + 8;
  const left = Math.min(anchorRect.left, window.innerWidth - 300);

  const handleMessage = async () => {
    await openDmWith(userId);
    onClose();
  };

  return (
    <div ref={cardRef}
      className="fixed z-[80] w-[280px] rounded-xl overflow-hidden"
      style={{
        top: Math.min(top, window.innerHeight - 320),
        left: Math.max(8, left),
        background: 'var(--card-bg, var(--surface-container-low))',
        border: '1px solid var(--border-default)',
        boxShadow: '0 12px 40px rgba(0,0,0,0.2)',
      }}
    >
      {loading ? (
        <div className="p-6 text-center text-[12px]" style={{ color: 'var(--text-tertiary)' }}>Loading...</div>
      ) : profile ? (
        <>
          {/* Header */}
          <div className="p-4 pb-3 flex items-start gap-3">
            {/* Avatar */}
            <div className="relative flex-shrink-0">
              {profile.avatar_url ? (
                <img src={profile.avatar_url} alt="" className="w-12 h-12 rounded-full object-cover" />
              ) : (
                <div className="w-12 h-12 rounded-full flex items-center justify-center text-[18px] font-semibold text-white"
                  style={{ background: getAvatarColor(profile.name) }}>
                  {profile.name[0]?.toUpperCase()}
                </div>
              )}
              {/* Presence dot */}
              <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2"
                style={{
                  borderColor: 'var(--card-bg, var(--surface-container-low))',
                  background: status === 'online' ? '#22c55e' : status === 'idle' ? '#f59e0b' : '#6b7280',
                }} />
            </div>

            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                {profile.name}
              </div>
              {profile.title && (
                <div className="text-[11px] truncate" style={{ color: 'var(--text-secondary)' }}>{profile.title}</div>
              )}
              <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                {profile.role}
              </div>
            </div>

            <button onClick={onClose} className="p-1 rounded hover:opacity-70 flex-shrink-0"
              style={{ color: 'var(--text-tertiary)' }}>
              <X size={14} />
            </button>
          </div>

          {/* Status */}
          {profile.status_emoji && (
            <div className="px-4 pb-2">
              <div className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                <span>{profile.status_emoji}</span>
                <span>{profile.status_text || ''}</span>
              </div>
            </div>
          )}

          {/* Details */}
          <div className="px-4 pb-3 space-y-1.5"
            style={{ borderTop: '1px solid var(--border-default)', paddingTop: 12 }}>
            {profile.timezone && (
              <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                <MapPin size={12} style={{ color: 'var(--text-tertiary)' }} />
                <span>{profile.timezone} &middot; {getLocalTime(profile.timezone)}</span>
              </div>
            )}
            <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
              <Clock size={12} style={{ color: 'var(--text-tertiary)' }} />
              <span>
                {status === 'online' ? 'Active now' :
                  status === 'idle' ? 'Idle' :
                    profile.last_seen_at ? `Last seen ${formatRelative(profile.last_seen_at)}` : 'Offline'}
              </span>
            </div>
            {profile.profile_summary && (
              <p className="text-[11px] leading-relaxed pt-1" style={{ color: 'var(--text-secondary)' }}>
                {profile.profile_summary}
              </p>
            )}
            {profile.expertise_tags && profile.expertise_tags.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-1">
                {profile.expertise_tags.slice(0, 4).map((tag) => (
                  <span
                    key={tag}
                    className="px-1.5 py-0.5 rounded text-[10px]"
                    style={{ background: 'var(--surface-container)', color: 'var(--text-secondary)' }}
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Message button */}
          <div className="px-4 pb-4">
            {isSelf ? (
              <Link
                href="/settings/profile"
                onClick={onClose}
                className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-[12px] font-medium transition-colors hover:opacity-90"
                style={{ background: 'var(--accent)', color: 'white' }}
              >
                <Pencil size={14} />
                Edit profile
              </Link>
            ) : (
              <button onClick={handleMessage}
                className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-[12px] font-medium transition-colors hover:opacity-90"
                style={{ background: 'var(--accent)', color: 'white' }}>
                <MessageSquare size={14} />
                Message
              </button>
            )}
          </div>
        </>
      ) : (
        <div className="p-6 text-center text-[12px]" style={{ color: 'var(--text-tertiary)' }}>User not found</div>
      )}
    </div>
  );
}
