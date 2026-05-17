'use client';

/**
 * Starter cards — first-day dashboard onboarding nudges.
 *
 * Renders three CTAs (ask Defty, invite team, create first project) above
 * the bento grid on a brand-new workspace. Each card is independently
 * dismissible via × or via clicking through the CTA; dismissals persist in
 * localStorage. When the onboarding flow has been completed
 * (onboarding_state.completed === true) the component renders nothing — even
 * if dismissals haven't been written yet.
 */

import { useEffect, useState, type ComponentType } from 'react';
import { useRouter } from 'next/navigation';
import { Bot, Users, FolderPlus, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useChatContext } from '@/lib/chat-context';
import { openDeftyDm } from '@/lib/quick-actions';

type CardId = 'defty' | 'invite' | 'project';

type CardDef = {
  id: CardId;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  title: string;
  body: string;
  cta: string;
  href: string;
};

const CARDS: readonly CardDef[] = [
  {
    id: 'defty',
    icon: Bot,
    title: 'Ask Defty to plan your day',
    body: 'Defty can read your tasks, calendar, and messages, then suggest a focused half-day plan.',
    cta: 'Open Defty',
    href: '',
  },
  {
    id: 'invite',
    icon: Users,
    title: 'Invite your team',
    body: "Generate one-time invite links from Settings → Members. Self-hosted Deft doesn't send email.",
    cta: 'Invite teammates',
    href: '/settings/members',
  },
  {
    id: 'project',
    icon: FolderPlus,
    title: 'Create your first project',
    body: 'Projects hold tasks. Tasks hold work. Pick a name, pick a vibe, start there.',
    cta: 'Start a project',
    href: '/tasks?new=project',
  },
] as const;

// IDs are coupled to localStorage keys (`deft.dashboard.starter.<id>.dismissed`).
// Renaming a card id will orphan existing users' dismissals and re-show that
// card to anyone who'd previously dismissed it. Don't rename without a
// migration story for existing alpha users.
const STORAGE_PREFIX = 'deft.dashboard.starter.';
const storageKey = (id: CardId) => `${STORAGE_PREFIX}${id}.dismissed`;

function readDismissed(id: CardId): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(storageKey(id)) === 'true';
  } catch {
    return false;
  }
}

function writeDismissed(id: CardId) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(id), 'true');
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

export function StarterCards() {
  const router = useRouter();
  const { openDmWith } = useChatContext();
  // `null` = haven't decided yet (still loading onboarding state).
  // `false` = should not render at all (onboarding completed or fetch failed).
  // `true` = render based on per-card dismissal state.
  const [shouldRender, setShouldRender] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState<Record<CardId, boolean>>({
    defty: false,
    invite: false,
    project: false,
  });

  useEffect(() => {
    let cancelled = false;
    api
      .get('/api/auth/onboarding')
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) {
          setShouldRender(false);
          return;
        }
        const state = await r.json().catch(() => null);
        if (cancelled) return;
        if (state?.completed === true) {
          setShouldRender(false);
          return;
        }
        // Fresh org → seed per-card dismissals from localStorage
        setDismissed({
          defty: readDismissed('defty'),
          invite: readDismissed('invite'),
          project: readDismissed('project'),
        });
        setShouldRender(true);
      })
      .catch(() => {
        if (!cancelled) setShouldRender(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (shouldRender !== true) return null;

  const visible = CARDS.filter((c) => !dismissed[c.id]);
  if (visible.length === 0) return null;

  const dismiss = (id: CardId) => {
    if (dismissed[id]) return;
    writeDismissed(id);
    setDismissed((prev) => ({ ...prev, [id]: true }));
  };

  const handleCta = (card: CardDef) => {
    if (dismissed[card.id]) return;
    writeDismissed(card.id);
    setDismissed((prev) => ({ ...prev, [card.id]: true }));
    if (card.id === 'defty') {
      void openDeftyDm(api, openDmWith);
      return;
    }
    router.push(card.href);
  };

  return (
    <section
      aria-label="Getting started"
      style={{ marginBottom: 18 }}
    >
      <h2
        className="eyebrow"
        style={{
          margin: '0 0 10px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          color: 'var(--text-secondary)',
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 99,
            background: 'var(--accent)',
          }}
        />
        Welcome to your new workspace — three things to try first
      </h2>
      <div
        className="grid grid-cols-1 gap-3 sm:grid-cols-3"
      >
        {visible.map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.id}
              style={{
                position: 'relative',
                minHeight: 120,
                padding: '14px 16px',
                borderRadius: 12,
                background: 'var(--surface-container, var(--bg-surface))',
                border: '1px solid var(--border-default)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <button
                type="button"
                onClick={() => dismiss(card.id)}
                aria-label={`Dismiss "${card.title}"`}
                title="Dismiss"
                style={{
                  position: 'absolute',
                  top: 6,
                  right: 6,
                  display: 'grid',
                  placeItems: 'center',
                  width: 24,
                  height: 24,
                  borderRadius: 6,
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--text-tertiary)',
                }}
                className="fc-btn"
              >
                <X size={12} strokeWidth={2} />
              </button>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  style={{
                    display: 'grid',
                    placeItems: 'center',
                    width: 28,
                    height: 28,
                    borderRadius: 7,
                    background:
                      'var(--accent-muted, color-mix(in srgb, var(--accent) 14%, transparent))',
                    color: 'var(--accent)',
                    flexShrink: 0,
                  }}
                >
                  <Icon size={14} strokeWidth={1.8} />
                </span>
                <h3
                  style={{
                    margin: 0,
                    fontSize: 13,
                    fontWeight: 600,
                    color: 'var(--on-surface, var(--text-primary))',
                    letterSpacing: '-0.005em',
                    paddingRight: 24,
                  }}
                >
                  {card.title}
                </h3>
              </div>
              <p
                style={{
                  margin: 0,
                  fontSize: 12,
                  lineHeight: 1.45,
                  color: 'var(--text-secondary)',
                  flex: 1,
                }}
              >
                {card.body}
              </p>
              <div>
                <button
                  type="button"
                  onClick={() => handleCta(card)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '6px 10px',
                    borderRadius: 7,
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: '0.01em',
                    color: 'var(--accent)',
                    background:
                      'var(--accent-muted, color-mix(in srgb, var(--accent) 10%, transparent))',
                    border: '1px solid transparent',
                    cursor: 'pointer',
                  }}
                  className="fc-btn"
                >
                  {card.cta} →
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
