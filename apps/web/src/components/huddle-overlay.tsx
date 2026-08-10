'use client';

import { useState } from 'react';
import { Mic, MicOff, PhoneOff, ChevronUp, ChevronDown, Monitor, UserPlus } from 'lucide-react';
import { useChatContext } from '@/lib/chat-context';
import { PersonAvatar } from './person-avatar';

type HuddleMember = {
  id: string;
  name: string;
  avatar_url?: string | null;
};

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
    <>
      {/* Mobile expanded sheet — full-screen modal with backdrop. Desktop uses
          the floating panel below the bar. */}
      {expanded && (
        <>
          {/* Backdrop — mobile only, dims chat behind the sheet */}
          <div
            className="md:hidden fixed inset-0 z-[59] bg-black/50 backdrop-blur-sm animate-fade-in"
            onClick={onToggleExpanded}
            aria-hidden
          />

          {/* Mobile sheet — slides up from bottom, ~75vh tall */}
          <div
            className="md:hidden fixed left-0 right-0 bottom-0 z-[61] rounded-t-2xl flex flex-col"
            style={{
              background: 'var(--surface-container-highest, #1e1e2e)',
              maxHeight: '75dvh',
              paddingBottom: 'max(env(safe-area-inset-bottom), 8px)',
              animation: 'huddleSlideUp 200ms cubic-bezier(0.16, 1, 0.3, 1)',
              boxShadow: '0 -16px 48px rgba(0,0,0,0.5)',
            }}
            role="dialog"
            aria-modal="true"
            aria-label={`Huddle in #${spaceName}`}
          >
            <ExpandedSheetMobile
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
          </div>
        </>
      )}

      {/* Desktop expanded panel — anchored above compact bar at bottom-left */}
      {expanded && (
        <div className="hidden md:block fixed z-[60]" style={{ bottom: 16 + 56, left: 16 }}>
          <ExpandedPanelDesktop
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
        </div>
      )}

      {/* Compact bar — desktop floats bottom-left, mobile sticks above the
          composer (full-width with gutters). The mobile bar is hidden while
          the sheet is open since the sheet itself includes a header with
          duration + minimize. */}
      {!expanded && (
        <div
          className="md:hidden fixed left-0 right-0 z-[60]"
          style={{
            // Sit above the composer (typical composer height ~64px) plus the
            // safe-area inset so it doesn't overlap the home indicator.
            bottom: 'calc(env(safe-area-inset-bottom, 0px) + 72px)',
            paddingLeft: 'max(env(safe-area-inset-left, 0px), 8px)',
            paddingRight: 'max(env(safe-area-inset-right, 0px), 8px)',
          }}
        >
          <CompactBarMobile
            spaceName={spaceName}
            participants={participants}
            orgMembers={orgMembers}
            speakingMap={speakingMap}
            muted={muted}
            duration={duration}
            onToggleMute={onToggleMute}
            onToggleExpanded={onToggleExpanded}
            onLeave={onLeave}
          />
        </div>
      )}

      <div className="hidden md:block fixed z-[60]" style={{ bottom: 16, left: 16 }}>
        <CompactBarDesktop
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

      {/* Shared keyframes */}
      <style>{`
        @keyframes huddleSlideUp {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
        @keyframes fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        .animate-fade-in { animation: fade-in 150ms ease-out; }
      `}</style>
    </>
  );
}

// ═══ Mobile Compact Bar ═══
// Full-width pill above the composer. 56px tall. Tap left half to expand.
// Right side has 44x44 mic toggle + 44x44 red Leave button.

function CompactBarMobile({
  spaceName, participants, orgMembers, speakingMap, muted, duration,
  onToggleMute, onToggleExpanded, onLeave,
}: {
  spaceName: string;
  participants: { user_id: string; muted: boolean }[];
  orgMembers: HuddleMember[];
  speakingMap: Map<string, boolean>;
  muted: boolean;
  duration: number;
  onToggleMute: () => void;
  onToggleExpanded: () => void;
  onLeave: () => void;
}) {
  return (
    <div
      className="flex items-center gap-2 pl-3 pr-2 py-2 rounded-xl"
      style={{
        background: 'var(--surface-container-highest, #1e1e2e)',
        border: '1px solid var(--border-default)',
        boxShadow: '0 4px 24px rgba(0,0,0,0.35)',
      }}
    >
      {/* Tappable info area — expands the sheet */}
      <button
        type="button"
        onClick={onToggleExpanded}
        aria-label={`Open huddle in ${spaceName}`}
        className="flex items-center gap-2 flex-1 min-w-0 min-h-[44px] text-left"
      >
        {/* Pulsing green indicator */}
        <div className="relative flex-shrink-0">
          <div className="w-2.5 h-2.5 rounded-full" style={{ background: '#22c55e' }} />
          <div className="absolute inset-0 w-2.5 h-2.5 rounded-full animate-ping opacity-40" style={{ background: '#22c55e' }} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary, #e0e0e0)' }}>
            #{spaceName}
          </div>
          <div className="text-[11px] tabular-nums" style={{ color: 'var(--text-tertiary, #888)' }}>
            {formatDuration(duration)} · {participants.length} {participants.length === 1 ? 'person' : 'people'}
          </div>
        </div>

        {/* Compact participant strip */}
        <div className="flex -space-x-1.5 flex-shrink-0">
          {participants.slice(0, 3).map((p) => {
            const member = orgMembers.find(m => m.id === p.user_id);
            const speaking = speakingMap.get(p.user_id);
            return (
              <ParticipantDot
                key={p.user_id}
                name={member?.name}
                avatarUrl={member?.avatar_url}
                muted={p.muted}
                speaking={speaking}
                size={28}
              />
            );
          })}
          {participants.length > 3 && (
            <div className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-medium border-2"
              style={{ background: 'var(--surface-container-low)', color: 'var(--text-tertiary)', borderColor: 'var(--surface-container-highest, #1e1e2e)' }}>
              +{participants.length - 3}
            </div>
          )}
        </div>
      </button>

      {/* Mic toggle — 44x44 */}
      <button
        type="button"
        onClick={onToggleMute}
        aria-label={muted ? 'Unmute' : 'Mute'}
        className="flex items-center justify-center min-w-[44px] min-h-[44px] rounded-full flex-shrink-0 transition-colors"
        style={{ background: muted ? '#ef4444' : 'var(--surface-container-low)', color: muted ? 'white' : 'var(--text-primary)' }}
      >
        {muted ? <MicOff size={18} /> : <Mic size={18} />}
      </button>

      {/* Leave — 44x44, red, prominent */}
      <button
        type="button"
        onClick={onLeave}
        aria-label="Leave huddle"
        className="flex items-center justify-center min-w-[44px] min-h-[44px] rounded-full flex-shrink-0 transition-opacity hover:opacity-90"
        style={{ background: '#ef4444', color: 'white' }}
      >
        <PhoneOff size={18} />
      </button>
    </div>
  );
}

// ═══ Mobile Expanded Sheet ═══

function ExpandedSheetMobile({
  spaceName, participants, orgMembers, speakingMap, muted, duration,
  onToggleMute, onMinimize, onLeave,
}: {
  spaceName: string;
  participants: { user_id: string; user_name: string; muted: boolean }[];
  orgMembers: HuddleMember[];
  speakingMap: Map<string, boolean>;
  muted: boolean;
  duration: number;
  onToggleMute: () => void;
  onMinimize: () => void;
  onLeave: () => void;
}) {
  return (
    <>
      {/* Drag handle */}
      <div className="flex justify-center pt-2 pb-1 flex-shrink-0">
        <div className="w-10 h-1 rounded-full" style={{ background: 'var(--outline-variant)' }} />
      </div>

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="relative flex-shrink-0">
            <div className="w-2.5 h-2.5 rounded-full" style={{ background: '#22c55e' }} />
            <div className="absolute inset-0 w-2.5 h-2.5 rounded-full animate-ping opacity-40" style={{ background: '#22c55e' }} />
          </div>
          <div className="min-w-0">
            <div className="text-[15px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
              #{spaceName}
            </div>
            <div className="text-[12px] tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
              {formatDuration(duration)} · {participants.length} {participants.length === 1 ? 'person' : 'people'}
            </div>
          </div>
        </div>

        <button
          onClick={onMinimize}
          aria-label="Minimize huddle"
          className="flex items-center justify-center min-w-[44px] min-h-[44px] rounded-md flex-shrink-0"
          style={{ color: 'var(--text-tertiary)' }}
        >
          <ChevronDown size={20} />
        </button>
      </div>

      {/* Participant grid — fills available space */}
      <div className="flex-1 overflow-y-auto px-4 py-3"
        style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 16, alignContent: 'start' }}>
        {participants.map((p) => {
          const member = orgMembers.find(m => m.id === p.user_id);
          const speaking = speakingMap.get(p.user_id);
          const name = member?.name || 'User';
          return (
            <div key={p.user_id} className="flex flex-col items-center gap-2">
              <div className="relative">
                <ParticipantDot name={name} avatarUrl={member?.avatar_url} muted={p.muted} speaking={speaking} size={72} fontSize={24} />
                {p.muted && (
                  <div className="absolute bottom-0 right-0 w-6 h-6 rounded-full flex items-center justify-center border-2"
                    style={{ background: '#ef4444', borderColor: 'var(--surface-container-highest, #1e1e2e)' }}>
                    <MicOff size={12} color="white" />
                  </div>
                )}
              </div>
              <span className="text-[12px] truncate max-w-full text-center font-medium"
                style={{ color: speaking ? '#22c55e' : 'var(--text-primary)' }}>
                {name.split(' ')[0]}
              </span>
            </div>
          );
        })}
      </div>

      {/* Bottom controls bar — labeled 56x56 tiles + prominent red Leave */}
      <div className="flex items-center justify-around px-4 py-3 flex-shrink-0"
        style={{ borderTop: '1px solid var(--border-default)' }}>
        <ControlTile
          icon={muted ? <MicOff size={20} /> : <Mic size={20} />}
          label={muted ? 'Unmute' : 'Mute'}
          onClick={onToggleMute}
          active={muted}
          activeBg="#ef4444"
          activeColor="white"
        />
        <ControlTile
          icon={<Monitor size={20} />}
          label="Share"
          onClick={() => {}}
          disabled
        />
        <ControlTile
          icon={<UserPlus size={20} />}
          label="Add"
          onClick={() => {}}
          disabled
        />
        <ControlTile
          icon={<PhoneOff size={20} />}
          label="Leave"
          onClick={onLeave}
          activeBg="#ef4444"
          activeColor="white"
          alwaysActive
        />
      </div>
    </>
  );
}

function ControlTile({
  icon, label, onClick, active, alwaysActive, activeBg, activeColor, disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  alwaysActive?: boolean;
  activeBg?: string;
  activeColor?: string;
  disabled?: boolean;
}) {
  const isActive = active || alwaysActive;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="flex flex-col items-center gap-1 min-w-[64px] min-h-[64px] py-1.5 rounded-xl disabled:opacity-40 transition-colors"
      style={{
        background: isActive ? activeBg : 'transparent',
      }}
    >
      <div
        className="flex items-center justify-center w-11 h-11 rounded-full"
        style={{
          background: isActive ? 'transparent' : 'var(--surface-container-low)',
          color: isActive ? activeColor : 'var(--text-primary)',
        }}
      >
        {icon}
      </div>
      <span className="text-[10px] font-medium" style={{ color: isActive ? activeColor : 'var(--text-secondary)' }}>
        {label}
      </span>
    </button>
  );
}

// ═══ Desktop Compact Bar (unchanged behavior) ═══

function CompactBarDesktop({
  spaceName, participants, orgMembers, speakingMap, muted, duration, expanded,
  onToggleMute, onToggleExpanded,
}: {
  spaceName: string;
  participants: { user_id: string; muted: boolean }[];
  orgMembers: HuddleMember[];
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
        if ((e.target as HTMLElement).closest('button')) return;
        onToggleExpanded();
      }}
    >
      <div className="relative flex-shrink-0">
        <div className="w-2 h-2 rounded-full" style={{ background: '#22c55e' }} />
        <div className="absolute inset-0 w-2 h-2 rounded-full animate-ping opacity-30" style={{ background: '#22c55e' }} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-semibold truncate" style={{ color: 'var(--text-primary, #e0e0e0)' }}>
          #{spaceName}
        </div>
        <div className="text-[9px]" style={{ color: 'var(--text-tertiary, #888)' }}>
          {formatDuration(duration)} &middot; {participants.length} {participants.length === 1 ? 'person' : 'people'}
        </div>
      </div>

      <div className="flex -space-x-1.5">
        {participants.slice(0, 4).map((p) => {
          const member = orgMembers.find(m => m.id === p.user_id);
          const speaking = speakingMap.get(p.user_id);
          return (
            <ParticipantDot
              key={p.user_id}
              name={member?.name}
              avatarUrl={member?.avatar_url}
              muted={p.muted}
              speaking={speaking}
              size={24}
            />
          );
        })}
        {participants.length > 4 && (
          <div className="w-6 h-6 rounded-full flex items-center justify-center text-[8px] font-medium border-2"
            style={{ background: 'var(--surface-container-low)', color: 'var(--text-tertiary)', borderColor: 'var(--surface-container-highest, #1e1e2e)' }}>
            +{participants.length - 4}
          </div>
        )}
      </div>

      <button type="button" onClick={onToggleMute}
        className="p-1.5 rounded-full transition-colors flex-shrink-0"
        style={{ background: muted ? '#ef4444' : 'var(--surface-container-low)', color: muted ? 'white' : 'var(--text-primary)' }}
        aria-label={muted ? 'Unmute huddle microphone' : 'Mute huddle microphone'}
        title={muted ? 'Unmute' : 'Mute'}>
        {muted ? <MicOff size={13} /> : <Mic size={13} />}
      </button>

      <button type="button" onClick={onToggleExpanded}
        className="p-1 rounded-full flex-shrink-0"
        style={{ color: 'var(--text-tertiary)' }}
        aria-label={expanded ? 'Minimize huddle' : 'Expand huddle'}
        title={expanded ? 'Minimize' : 'Expand'}>
        {expanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
      </button>
    </div>
  );
}

// ═══ Desktop Expanded Panel (unchanged) ═══

function ExpandedPanelDesktop({
  spaceName, participants, orgMembers, speakingMap, muted, duration,
  onToggleMute, onMinimize, onLeave,
}: {
  spaceName: string;
  participants: { user_id: string; user_name: string; muted: boolean }[];
  orgMembers: HuddleMember[];
  speakingMap: Map<string, boolean>;
  muted: boolean;
  duration: number;
  onToggleMute: () => void;
  onMinimize: () => void;
  onLeave: () => void;
}) {
  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{
        background: 'var(--surface-container-highest, #1e1e2e)',
        border: '1px solid var(--border-default)',
        boxShadow: '0 16px 48px rgba(0,0,0,0.4)',
        width: 320,
        animation: 'huddleSlideUp 150ms ease-out',
      }}
    >
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
        <button type="button" onClick={onMinimize} className="p-1.5 rounded-md hover:opacity-70"
          aria-label="Minimize huddle"
          style={{ color: 'var(--text-tertiary)' }} title="Minimize">
          <ChevronDown size={16} />
        </button>
      </div>

      <div className="p-4 max-h-[240px] overflow-y-auto"
        style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))', gap: 12 }}>
        {participants.map((p) => {
          const member = orgMembers.find(m => m.id === p.user_id);
          const speaking = speakingMap.get(p.user_id);
          const name = member?.name || 'User';
          return (
            <div key={p.user_id} className="flex flex-col items-center gap-1.5">
              <div className="relative">
                <ParticipantDot name={name} avatarUrl={member?.avatar_url} muted={p.muted} speaking={speaking} size={48} fontSize={16} />
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

      <div className="flex items-center justify-center gap-3 px-4 py-3"
        style={{ borderTop: '1px solid var(--border-default)' }}>
        <button type="button" onClick={onToggleMute}
          className="p-2.5 rounded-full transition-colors"
          style={{ background: muted ? '#ef4444' : 'var(--surface-container-low)', color: muted ? 'white' : 'var(--text-primary)' }}
          aria-label={muted ? 'Unmute huddle microphone' : 'Mute huddle microphone'}
          title={muted ? 'Unmute' : 'Mute'}>
          {muted ? <MicOff size={18} /> : <Mic size={18} />}
        </button>

        <button type="button" className="p-2.5 rounded-full opacity-40 cursor-not-allowed"
          aria-label="Screen share coming soon"
          style={{ background: 'var(--surface-container-low)', color: 'var(--text-tertiary)' }}
          title="Screen share (coming soon)" disabled>
          <Monitor size={18} />
        </button>

        <button type="button" className="p-2.5 rounded-full opacity-40 cursor-not-allowed"
          aria-label="Invite to huddle coming soon"
          style={{ background: 'var(--surface-container-low)', color: 'var(--text-tertiary)' }}
          title="Invite (coming soon)" disabled>
          <UserPlus size={18} />
        </button>

        <button type="button" onClick={onLeave}
          className="p-2.5 rounded-full transition-colors hover:opacity-90"
          style={{ background: '#ef4444', color: 'white' }}
          aria-label="Leave huddle"
          title="Leave huddle">
          <PhoneOff size={18} />
        </button>
      </div>
    </div>
  );
}

// ═══ Participant Avatar with Speaking Ring ═══

function ParticipantDot({
  name, avatarUrl, muted, speaking, size = 24, fontSize = 10,
}: {
  name?: string;
  avatarUrl?: string | null;
  muted?: boolean;
  speaking?: boolean;
  size?: number;
  fontSize?: number;
}) {
  return (
    <PersonAvatar
      name={name}
      avatarUrl={avatarUrl}
      size={size}
      fontSize={fontSize}
      className="border-2 transition-shadow"
      style={{
        borderColor: 'var(--surface-container-highest, #1e1e2e)',
        boxShadow: speaking ? '0 0 0 3px #22c55e' : 'none',
        opacity: muted ? 0.6 : 1,
        transitionDuration: '200ms',
      }}
      title={`${name || 'User'}${muted ? ' (muted)' : ''}${speaking ? ' (speaking)' : ''}`}
    />
  );
}
