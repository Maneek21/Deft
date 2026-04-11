'use client';

import { useState } from 'react';
import { Mic, MicOff, PhoneOff, ChevronUp, ChevronDown, Monitor, UserPlus } from 'lucide-react';
import { useChatContext } from '@/lib/chat-context';

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

type OverlayProps = {
  huddleId: string;
  spaceId: string;
  participants: { user_id: string; user_name: string; muted: boolean }[];
  muted: boolean;
  duration: number;
  expanded: boolean;
  speakingMap: Map<string, boolean>;
  onToggleMute: () => void;
  onToggleExpanded: () => void;
  onLeave: () => void;
};

export function HuddleOverlay({
  huddleId, spaceId, participants, muted, duration, expanded, speakingMap,
  onToggleMute, onToggleExpanded, onLeave,
}: OverlayProps) {
  const { spaces, orgMembers } = useChatContext();
  const space = spaces.find(s => s.id === spaceId);
  const spaceName = space?.name || 'Huddle';

  return (
    <div className="fixed z-[60]" style={{ bottom: 16, left: 16 }}>
      {/* Expanded panel (above compact bar) */}
      {expanded && (
        <ExpandedPanel
          spaceName={spaceName}
          participants={participants}
          orgMembers={orgMembers}
          speakingMap={speakingMap}
          muted={muted}
          duration={duration}
          onToggleMute={onToggleMute}
          onMinimize={onToggleExpanded}
          onLeave={onLeave}
        />
      )}

      {/* Compact bar */}
      <CompactBar
        spaceName={spaceName}
        participants={participants}
        orgMembers={orgMembers}
        speakingMap={speakingMap}
        muted={muted}
        duration={duration}
        expanded={expanded}
        onToggleMute={onToggleMute}
        onToggleExpanded={onToggleExpanded}
      />
    </div>
  );
}

// ═══ Compact Bar ═══

function CompactBar({
  spaceName, participants, orgMembers, speakingMap, muted, duration, expanded,
  onToggleMute, onToggleExpanded,
}: {
  spaceName: string;
  participants: { user_id: string; muted: boolean }[];
  orgMembers: { id: string; name: string }[];
  speakingMap: Map<string, boolean>;
  muted: boolean;
  duration: number;
  expanded: boolean;
  onToggleMute: () => void;
  onToggleExpanded: () => void;
}) {
  return (
    <div
      className="flex items-center gap-2.5 px-3 py-2 rounded-xl cursor-pointer select-none"
      style={{
        background: 'var(--surface-container-highest, #1e1e2e)',
        border: '1px solid var(--border-default)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
        width: 280,
      }}
      onClick={(e) => {
        // Don't expand when clicking buttons
        if ((e.target as HTMLElement).closest('button')) return;
        onToggleExpanded();
      }}
    >
      {/* Green pulsing indicator */}
      <div className="relative flex-shrink-0">
        <div className="w-2 h-2 rounded-full" style={{ background: '#22c55e' }} />
        <div className="absolute inset-0 w-2 h-2 rounded-full animate-ping opacity-30" style={{ background: '#22c55e' }} />
      </div>

      {/* Room info */}
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-semibold truncate" style={{ color: 'var(--text-primary, #e0e0e0)' }}>
          #{spaceName}
        </div>
        <div className="text-[9px]" style={{ color: 'var(--text-tertiary, #888)' }}>
          {formatDuration(duration)} &middot; {participants.length} {participants.length === 1 ? 'person' : 'people'}
        </div>
      </div>

      {/* Participant avatars with speaking rings */}
      <div className="flex -space-x-1.5">
        {participants.slice(0, 4).map((p) => {
          const member = orgMembers.find(m => m.id === p.user_id);
          const speaking = speakingMap.get(p.user_id);
          return (
            <ParticipantDot key={p.user_id} name={member?.name} muted={p.muted} speaking={speaking} size={24} />
          );
        })}
        {participants.length > 4 && (
          <div className="w-6 h-6 rounded-full flex items-center justify-center text-[8px] font-medium border-2"
            style={{ background: 'var(--surface-container-low)', color: 'var(--text-tertiary)', borderColor: 'var(--surface-container-highest, #1e1e2e)' }}>
            +{participants.length - 4}
          </div>
        )}
      </div>

      {/* Mute button */}
      <button onClick={onToggleMute}
        className="p-1.5 rounded-full transition-colors flex-shrink-0"
        style={{ background: muted ? '#ef4444' : 'var(--surface-container-low)', color: muted ? 'white' : 'var(--text-primary)' }}
        title={muted ? 'Unmute' : 'Mute'}>
        {muted ? <MicOff size={13} /> : <Mic size={13} />}
      </button>

      {/* Expand/collapse */}
      <button onClick={onToggleExpanded}
        className="p-1 rounded-full flex-shrink-0"
        style={{ color: 'var(--text-tertiary)' }}
        title={expanded ? 'Minimize' : 'Expand'}>
        {expanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
      </button>
    </div>
  );
}

// ═══ Expanded Panel ═══

function ExpandedPanel({
  spaceName, participants, orgMembers, speakingMap, muted, duration,
  onToggleMute, onMinimize, onLeave,
}: {
  spaceName: string;
  participants: { user_id: string; user_name: string; muted: boolean }[];
  orgMembers: { id: string; name: string }[];
  speakingMap: Map<string, boolean>;
  muted: boolean;
  duration: number;
  onToggleMute: () => void;
  onMinimize: () => void;
  onLeave: () => void;
}) {
  return (
    <div
      className="mb-2 rounded-xl overflow-hidden"
      style={{
        background: 'var(--surface-container-highest, #1e1e2e)',
        border: '1px solid var(--border-default)',
        boxShadow: '0 16px 48px rgba(0,0,0,0.4)',
        width: 320,
        animation: 'huddleSlideUp 150ms ease-out',
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3"
        style={{ borderBottom: '1px solid var(--border-default)' }}>
        <div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <div className="w-2 h-2 rounded-full" style={{ background: '#22c55e' }} />
              <div className="absolute inset-0 w-2 h-2 rounded-full animate-ping opacity-30" style={{ background: '#22c55e' }} />
            </div>
            <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              #{spaceName}
            </span>
            <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(34,197,94,0.15)', color: '#22c55e' }}>
              Huddle
            </span>
          </div>
          <div className="text-[10px] mt-0.5 ml-4" style={{ color: 'var(--text-tertiary)' }}>
            {formatDuration(duration)} &middot; {participants.length} {participants.length === 1 ? 'person' : 'people'}
          </div>
        </div>
        <button onClick={onMinimize} className="p-1.5 rounded-md hover:opacity-70"
          style={{ color: 'var(--text-tertiary)' }} title="Minimize">
          <ChevronDown size={16} />
        </button>
      </div>

      {/* Participant grid */}
      <div className="p-4 max-h-[240px] overflow-y-auto"
        style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))', gap: 12 }}>
        {participants.map((p) => {
          const member = orgMembers.find(m => m.id === p.user_id);
          const speaking = speakingMap.get(p.user_id);
          const name = member?.name || 'User';
          return (
            <div key={p.user_id} className="flex flex-col items-center gap-1.5">
              <div className="relative">
                <ParticipantDot name={name} muted={p.muted} speaking={speaking} size={48} fontSize={16} />
                {p.muted && (
                  <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full flex items-center justify-center"
                    style={{ background: '#ef4444' }}>
                    <MicOff size={9} color="white" />
                  </div>
                )}
              </div>
              <span className="text-[10px] truncate max-w-[72px] text-center"
                style={{ color: speaking ? '#22c55e' : 'var(--text-secondary)' }}>
                {name.split(' ')[0]}
              </span>
            </div>
          );
        })}
      </div>

      {/* Controls bar */}
      <div className="flex items-center justify-center gap-3 px-4 py-3"
        style={{ borderTop: '1px solid var(--border-default)' }}>
        {/* Mic toggle */}
        <button onClick={onToggleMute}
          className="p-2.5 rounded-full transition-colors"
          style={{ background: muted ? '#ef4444' : 'var(--surface-container-low)', color: muted ? 'white' : 'var(--text-primary)' }}
          title={muted ? 'Unmute' : 'Mute'}>
          {muted ? <MicOff size={18} /> : <Mic size={18} />}
        </button>

        {/* Screen share (placeholder) */}
        <button className="p-2.5 rounded-full opacity-40 cursor-not-allowed"
          style={{ background: 'var(--surface-container-low)', color: 'var(--text-tertiary)' }}
          title="Screen share (coming soon)" disabled>
          <Monitor size={18} />
        </button>

        {/* Invite */}
        <button className="p-2.5 rounded-full opacity-40 cursor-not-allowed"
          style={{ background: 'var(--surface-container-low)', color: 'var(--text-tertiary)' }}
          title="Invite (coming soon)" disabled>
          <UserPlus size={18} />
        </button>

        {/* Leave */}
        <button onClick={onLeave}
          className="p-2.5 rounded-full transition-colors hover:opacity-90"
          style={{ background: '#ef4444', color: 'white' }}
          title="Leave huddle">
          <PhoneOff size={18} />
        </button>
      </div>

      {/* CSS animation */}
      <style>{`
        @keyframes huddleSlideUp {
          from { transform: translateY(8px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

// ═══ Participant Avatar with Speaking Ring ═══

function ParticipantDot({
  name, muted, speaking, size = 24, fontSize = 10,
}: {
  name?: string;
  muted?: boolean;
  speaking?: boolean;
  size?: number;
  fontSize?: number;
}) {
  const initial = (name || '?')[0]?.toUpperCase();
  return (
    <div
      className="rounded-full flex items-center justify-center font-semibold border-2 transition-shadow"
      style={{
        width: size,
        height: size,
        fontSize,
        background: 'var(--accent, #6366f1)',
        color: 'white',
        borderColor: 'var(--surface-container-highest, #1e1e2e)',
        boxShadow: speaking ? '0 0 0 3px #22c55e' : 'none',
        opacity: muted ? 0.6 : 1,
        transitionDuration: '200ms',
      }}
      title={`${name || 'User'}${muted ? ' (muted)' : ''}${speaking ? ' (speaking)' : ''}`}
    >
      {initial}
    </div>
  );
}
