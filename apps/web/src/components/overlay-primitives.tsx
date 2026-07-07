'use client';

import {
  ReactNode,
  RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';

function useMounted() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

function getFocusable(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true');
}

export function useBodyScrollLock(open: boolean) {
  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);
}

export function useOverlayDismiss({
  open,
  onClose,
  refs,
  closeOnOutside = true,
  closeOnEscape = true,
}: {
  open: boolean;
  onClose: () => void;
  refs: RefObject<HTMLElement | null>[];
  closeOnOutside?: boolean;
  closeOnEscape?: boolean;
}) {
  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!closeOnOutside) return;
      const target = event.target as Node;
      if (refs.some((ref) => ref.current?.contains(target))) return;
      onClose();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (closeOnEscape && event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeOnEscape, closeOnOutside, onClose, open, refs]);
}

function useReturnFocus(open: boolean, anchorRef?: RefObject<HTMLElement | null>) {
  const lastOpen = useRef(false);

  useEffect(() => {
    if (open) {
      lastOpen.current = true;
      return;
    }
    if (!lastOpen.current) return;
    lastOpen.current = false;
    requestAnimationFrame(() => anchorRef?.current?.focus?.());
  }, [anchorRef, open]);
}

function handleFocusTrap(event: ReactKeyboardEvent, panel: HTMLElement | null) {
  if (event.key !== 'Tab') return;
  const focusable = getFocusable(panel);
  if (focusable.length === 0) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;

  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

export function AppBackdrop({
  onClose,
  className = '',
  subtle = false,
}: {
  onClose?: () => void;
  className?: string;
  subtle?: boolean;
}) {
  return (
    <div
      aria-hidden
      className={`fixed inset-0 ${className}`}
      onClick={onClose}
      style={{
        background: subtle ? 'rgba(0,0,0,0.28)' : 'rgba(0,0,0,0.52)',
        backdropFilter: 'blur(5px)',
      }}
    />
  );
}

export function AppDialog({
  open = true,
  onClose,
  title,
  description,
  children,
  footer,
  width = 420,
  danger = false,
  initialFocusRef,
}: {
  open?: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  danger?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
}) {
  const mounted = useMounted();
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useBodyScrollLock(open);
  useOverlayDismiss({ open, onClose, refs: [panelRef], closeOnOutside: false });

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      if (initialFocusRef?.current) {
        initialFocusRef.current.focus();
        return;
      }
      getFocusable(panelRef.current)[0]?.focus();
    });
  }, [initialFocusRef, open]);

  if (!mounted || !open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center px-4 py-6">
      <AppBackdrop onClose={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descriptionId : undefined}
        className="relative flex max-h-[min(90vh,760px)] w-full flex-col overflow-hidden rounded-2xl outline-none"
        style={{
          maxWidth: width,
          background: 'var(--surface-container)',
          border: '1px solid var(--outline-variant)',
          boxShadow: 'var(--glass-shadow)',
        }}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => handleFocusTrap(event, panelRef.current)}
      >
        {(title || description) && (
          <div className="flex-shrink-0 px-5 pt-5">
            {title && (
              <h2 id={titleId} className="text-[0.9375rem] font-semibold" style={{ color: danger ? 'var(--danger)' : 'var(--on-surface)' }}>
                {title}
              </h2>
            )}
            {description && (
              <p id={descriptionId} className="mt-2 text-[0.8125rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>
                {description}
              </p>
            )}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex-shrink-0 px-5 pb-5 pt-1">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function AppBottomSheet({
  open,
  onClose,
  title,
  children,
  footer,
  mobileOnly = false,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  mobileOnly?: boolean;
}) {
  const mounted = useMounted();
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useBodyScrollLock(open);
  useOverlayDismiss({ open, onClose, refs: [panelRef], closeOnOutside: false });

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => getFocusable(panelRef.current)[0]?.focus());
  }, [open]);

  if (!mounted || !open) return null;

  return createPortal(
    <div className={`fixed inset-0 z-[90] flex items-end ${mobileOnly ? 'md:hidden' : ''}`}>
      <AppBackdrop onClose={onClose} subtle />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        className="relative max-h-[82vh] w-full overflow-hidden rounded-t-2xl outline-none"
        style={{
          background: 'var(--surface-container)',
          borderTop: '1px solid var(--outline-variant)',
          boxShadow: '0 -18px 44px rgba(0,0,0,0.38)',
          paddingBottom: 'max(env(safe-area-inset-bottom), 12px)',
        }}
        onKeyDown={(event) => handleFocusTrap(event, panelRef.current)}
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full" style={{ background: 'var(--outline-variant)' }} />
        {title && (
          <div id={titleId} className="px-4 pb-2 pt-3 text-[0.8125rem] font-semibold" style={{ color: 'var(--on-surface-variant)' }}>
            {title}
          </div>
        )}
        <div className="max-h-[60vh] overflow-y-auto px-2 pb-2">{children}</div>
        {footer && <div className="px-4 pb-2 pt-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

function getAnchoredPosition(anchor: HTMLElement, width: number, side: 'top' | 'bottom', align: 'start' | 'end') {
  const rect = anchor.getBoundingClientRect();
  const margin = 10;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const maxHeight = Math.max(180, viewportHeight - margin * 2);
  const left = align === 'end' ? rect.right - width : rect.left;
  const clampedLeft = Math.min(Math.max(margin, left), viewportWidth - width - margin);
  const spaceBelow = viewportHeight - rect.bottom - margin;
  const spaceAbove = rect.top - margin;
  const resolvedSide = side === 'bottom' && spaceBelow < 220 && spaceAbove > spaceBelow ? 'top' : side;
  const top = resolvedSide === 'top' ? Math.max(margin, rect.top - 8) : Math.min(viewportHeight - margin, rect.bottom + 8);

  return {
    left: clampedLeft,
    top,
    transform: resolvedSide === 'top' ? 'translateY(-100%)' : undefined,
    maxHeight: Math.min(maxHeight, resolvedSide === 'top' ? spaceAbove - 8 : spaceBelow - 8),
  };
}

export function AnchoredOverlay({
  open,
  onClose,
  anchorRef,
  children,
  width = 220,
  side = 'bottom',
  align = 'end',
  role = 'dialog',
  ariaLabel,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  width?: number;
  side?: 'top' | 'bottom';
  align?: 'start' | 'end';
  role?: string;
  ariaLabel?: string;
}) {
  const mounted = useMounted();
  const panelRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties | null>(null);

  const updatePosition = useCallback(() => {
    if (!anchorRef.current) return;
    const next = getAnchoredPosition(anchorRef.current, width, side, align);
    setStyle({
      position: 'fixed',
      width,
      left: next.left,
      top: next.top,
      transform: next.transform,
      maxHeight: next.maxHeight,
    });
  }, [align, anchorRef, side, width]);

  useReturnFocus(open, anchorRef);
  useOverlayDismiss({ open, onClose, refs: [panelRef, anchorRef], closeOnOutside: true });

  useEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition]);

  if (!mounted || !open || !style) return null;

  return createPortal(
    <div
      ref={panelRef}
      role={role}
      aria-label={ariaLabel}
      className="deft-menu-surface z-[95] overflow-y-auto py-1.5 outline-none"
      style={{
        ...style,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

export type AppMenuItem = {
  label: string;
  onSelect: () => void | Promise<void>;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
};

export function AppMenu({
  open,
  onClose,
  anchorRef,
  items,
  header,
  width = 220,
  ariaLabel = 'Menu',
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  items: AppMenuItem[];
  header?: ReactNode;
  width?: number;
  ariaLabel?: string;
}) {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => itemRefs.current.find(Boolean)?.focus());
  }, [open]);

  const content = useMemo(() => (
    <div role={isMobile ? 'menu' : undefined} aria-label={isMobile ? ariaLabel : undefined}>
      {header && (
        <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--outline-variant)' }}>
          {header}
        </div>
      )}
      {items.map((item, index) => (
        <button
          key={item.label}
          ref={(node) => { itemRefs.current[index] = node; }}
          role="menuitem"
          disabled={item.disabled}
          onClick={async () => {
            if (item.disabled) return;
            await item.onSelect();
            onClose();
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              itemRefs.current[(index + 1) % items.length]?.focus();
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              itemRefs.current[(index - 1 + items.length) % items.length]?.focus();
            }
          }}
          className="deft-menu-item mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2.5 px-3 py-2 text-left text-[0.8125rem] outline-none disabled:cursor-not-allowed disabled:opacity-45"
          style={item.danger ? { color: 'var(--danger)' } : undefined}
        >
          {item.icon && <span className="flex-shrink-0">{item.icon}</span>}
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
        </button>
      ))}
    </div>
  ), [ariaLabel, header, isMobile, items, onClose]);

  if (isMobile) {
    return (
      <AppBottomSheet open={open} onClose={onClose} title={ariaLabel}>
        {content}
      </AppBottomSheet>
    );
  }

  return (
    <AnchoredOverlay open={open} onClose={onClose} anchorRef={anchorRef} width={width} role="menu" ariaLabel={ariaLabel}>
      {content}
    </AnchoredOverlay>
  );
}
