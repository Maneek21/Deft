'use client';

/** Inline notice for a chat read that failed, with a retry. Not an empty state. */
export function ChatLoadError({
  message,
  onRetry,
  retrying = false,
}: {
  message: string;
  onRetry: () => void;
  retrying?: boolean;
}) {
  return (
    <div
      role="alert"
      className="mx-2 my-3 flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-[13px]"
      style={{ background: 'var(--surface-container)', color: 'var(--on-surface)', border: '1px solid var(--border)' }}
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="flex-shrink-0 rounded-md px-2.5 py-1 text-[12px] font-semibold disabled:opacity-60"
        style={{ background: 'var(--primary-container)', color: '#fff' }}
      >
        {retrying ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  );
}
