import type { MouseEvent } from 'react';
import { isSafeChatHref } from '@/lib/chat-links';

/** An empty or whitespace `thread` query value means "no thread", exactly like a missing one. */
export function threadParamId(value: string | null | undefined): string | null {
  const id = value?.trim();
  return id ? id : null;
}

/** True when a link opens a channel message in this chat surface without naming a thread. */
export function isThreadlessChannelMessageDestination(href: string, origin: string): boolean {
  if (!href.startsWith('/') || href.startsWith('//')) return false;
  const destination = new URL(href, origin);
  return destination.pathname === '/chat'
    && destination.searchParams.has('message')
    && threadParamId(destination.searchParams.get('thread')) === null;
}

/** Delegate generated markdown anchors to the app router without changing browser click shortcuts. */
export function navigateMessageLink(event: MouseEvent<HTMLElement>, navigate: (href: string) => void): void {
  if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

  const target = event.target as Element | null;
  const anchor = target?.closest?.<HTMLAnchorElement>('a[href]');
  if (!anchor || !event.currentTarget.contains(anchor) || anchor.isContentEditable || anchor.hasAttribute('download')) return;

  const href = anchor.getAttribute('href');
  const linkTarget = anchor.getAttribute('target');
  if (!href?.startsWith('/') || !isSafeChatHref(href) || (linkTarget && linkTarget.toLowerCase() !== '_self')) return;

  event.preventDefault();
  navigate(href);
}
