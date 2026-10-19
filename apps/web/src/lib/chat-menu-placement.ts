type Rect = { top: number; bottom: number; left: number; right: number };

/** Place a measured menu inside the visible conversation, excluding its composer. */
export function placeChatMenu(anchor: Rect, chat: Rect, viewport: Rect, desiredWidth: number, contentHeight: number) {
  const margin = 8, gap = 6;
  const topEdge = Math.max(chat.top, viewport.top) + margin;
  const bottomEdge = Math.max(topEdge, Math.min(chat.bottom, viewport.bottom) - margin);
  const leftEdge = Math.max(chat.left, viewport.left) + margin;
  const rightEdge = Math.max(leftEdge, Math.min(chat.right, viewport.right) - margin);
  const width = Math.min(desiredWidth, Math.max(0, rightEdge - leftEdge));
  const below = Math.max(0, bottomEdge - Math.max(topEdge, anchor.bottom + gap));
  const above = Math.max(0, Math.min(bottomEdge, anchor.top - gap) - topEdge);
  const up = contentHeight > below && (contentHeight <= above || above > below);
  const maxHeight = up ? above : below;
  const height = Math.min(contentHeight, maxHeight);
  const rawTop = up ? anchor.top - gap - height : anchor.bottom + gap;
  return { width, left: Math.max(leftEdge, Math.min(anchor.right - width, rightEdge - width)),
    top: Math.max(topEdge, Math.min(rawTop, bottomEdge - height)), maxHeight };
}
