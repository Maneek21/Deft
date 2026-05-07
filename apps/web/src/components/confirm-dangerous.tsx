'use client';
/**
 * Phase 10 — ConfirmDangerous typed-confirmation modal.
 *
 * Used anywhere a destructive action needs a speed-bump beyond a plain
 * "Are you sure?" dialog. The user must type a specific `confirmWord` —
 * the employee slug, the word "AUTONOMOUS", the org name, etc. — and the
 * confirm button stays disabled until the input matches exactly.
 *
 * Matching is case-SENSITIVE. If you want a case-insensitive flow, convert
 * the word upstream before passing it in.
 *
 * Keyboard:
 *   - Escape    → close (unless in-flight)
 *   - Enter     → submit, but only when the input matches and not in-flight
 *   - Auto-focuses the input on open
 *
 * Variants:
 *   - "warning" (yellow accents) for cautionary but reversible actions
 *     (e.g. trust-level upgrade)
 *   - "danger"  (red accents) for destructive actions (employee delete,
 *     org delete)
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

export type ConfirmDangerousVariant = 'warning' | 'danger';

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  body: ReactNode;
  /** Exact string the user has to type to unlock the confirm button. */
  confirmWord: string;
  confirmLabel: string;
  cancelLabel?: string;
  variant?: ConfirmDangerousVariant;
  /** Async handler; the modal shows a spinner while it resolves. */
  onConfirm: () => Promise<void>;
  /** Optional data-testid prefix, used by audits. */
  testId?: string;
};

export function ConfirmDangerous({
  open,
  onClose,
  title,
  body,
  confirmWord,
  confirmLabel,
  cancelLabel = 'Cancel',
  variant = 'warning',
  onConfirm,
  testId = 'confirm-dangerous',
}: Props) {
  const [typed, setTyped] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      setTyped('');
      setSubmitting(false);
      setError(null);
      return;
    }
    // Auto-focus the typing input on open.
    const t = setTimeout(() => inputRef.current?.focus(), 20);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, submitting, onClose]);

  if (!open) return null;

  const matches = typed === confirmWord;

  const accent =
    variant === 'danger' ? 'var(--danger, #ef4444)' : 'var(--warning, #f59e0b)';

  const submit = async () => {
    if (!matches || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
      // Parent is expected to close on success; we also reset internal state.
      setSubmitting(false);
      setTyped('');
      onClose();
    } catch (err: any) {
      setSubmitting(false);
      setError(
        typeof err?.message === 'string' ? err.message : 'Failed to complete action',
      );
    }
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={() => {
        if (!submitting) onClose();
      }}
      data-testid={`${testId}-overlay`}
    >
      <div
        className="w-full max-w-[460px] rounded-xl p-6 flex flex-col gap-4"
        style={{
          background: 'var(--card-bg)',
          border: `1px solid ${accent}`,
          boxShadow: 'var(--glass-shadow, 0 12px 40px rgba(0,0,0,0.4))',
        }}
        onClick={(e) => e.stopPropagation()}
        data-testid={testId}
      >
        <div className="flex items-center gap-2">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full"
            style={{ background: accent }}
          />
          <h3
            className="text-[15px] font-semibold"
            style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
          >
            {title}
          </h3>
        </div>

        <div
          className="text-[13px] leading-relaxed"
          style={{ color: 'var(--foreground-secondary, var(--foreground))' }}
        >
          {body}
        </div>

        <div>
          <label
            className="text-[11px] block mb-1.5"
            style={{ color: 'var(--muted)' }}
          >
            Type{' '}
            <span
              className="font-mono font-semibold"
              style={{ color: accent }}
            >
              {confirmWord}
            </span>{' '}
            to confirm
          </label>
          <input
            ref={inputRef}
            type="text"
            value={typed}
            disabled={submitting}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches && !submitting) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={confirmWord}
            autoComplete="off"
            spellCheck={false}
            className="w-full h-9 px-3 text-[13px] rounded-md outline-none font-mono"
            style={{
              background: 'var(--surface-container-low, var(--surface))',
              color: 'var(--foreground)',
              border: `1px solid ${
                typed.length === 0
                  ? 'var(--border)'
                  : matches
                    ? accent
                    : 'var(--border)'
              }`,
            }}
            data-testid={`${testId}-input`}
          />
        </div>

        {error && (
          <div
            className="text-[12px] px-3 py-2 rounded"
            style={{ background: 'rgba(239,68,68,0.15)', color: 'var(--danger, #ef4444)' }}
            data-testid={`${testId}-error`}
          >
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 text-[0.8125rem] rounded-lg font-medium disabled:opacity-50"
            style={{
              color: 'var(--foreground-secondary, var(--foreground))',
              background: 'var(--surface-container-low, var(--surface))',
              border: '1px solid var(--border)',
            }}
            data-testid={`${testId}-cancel`}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!matches || submitting}
            className="px-4 py-2 text-[0.8125rem] rounded-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              background: accent,
              color: '#fff',
            }}
            data-testid={`${testId}-confirm`}
          >
            {submitting ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
