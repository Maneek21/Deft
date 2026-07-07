'use client';

import { ReactNode } from 'react';
import { AppBottomSheet } from './overlay-primitives';

type Props = {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
};

/**
 * Bottom sheet for mobile (`< md`). Shared behavior lives in
 * `overlay-primitives` so every sheet uses the same Escape, focus, backdrop,
 * safe-area, scroll-lock, and height behavior.
 */
export function MobileActionSheet({ open, onClose, title, children }: Props) {
  return (
    <AppBottomSheet open={open} onClose={onClose} title={title} mobileOnly>
      {children}
    </AppBottomSheet>
  );
}
