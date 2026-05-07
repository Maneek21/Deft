'use client';

/**
 * Small "AI" pill used to mark agent users in member lists and pickers.
 * Used by CreateDmModal (Phase 4) and SpaceMembersPanel (Phase 6).
 */
export function AIBadge({ className }: { className?: string }) {
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded-full ${className ?? ''}`}
      style={{ background: 'var(--surface)', color: 'var(--muted)' }}
      aria-label="AI agent"
    >
      AI
    </span>
  );
}
