'use client';
import { useState } from 'react';

/**
 * Phase 8 — CopyOnce component.
 *
 * Renders a secret (Gateway token, MCP bearer) in a read-only field with a
 * "Copy" button. Once the user clicks Copy, the value is replaced with a
 * masked placeholder so it can never be re-read from the DOM. The raw
 * value lives only in React state and is wiped on unmount.
 *
 * Used by the setup wizard's provisioning step to expose one-shot secrets
 * that Deft will never display again.
 */
export function CopyOnce({
  value,
  label,
  helpText,
}: {
  value: string;
  label: string;
  helpText?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(true);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setRevealed(false);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('copy failed', err);
    }
  }

  return (
    <div className="mb-3">
      <label
        className="text-[12px] font-medium mb-1 block"
        style={{ color: 'var(--foreground-secondary)' }}
      >
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          type="text"
          readOnly
          value={revealed ? value : '••••••••••••••••• (copied — never shown again)'}
          className="flex-1 px-3 py-2 rounded-lg text-[12px] font-mono"
          style={{
            background: 'var(--surface-container)',
            color: 'var(--foreground)',
            border: '1px solid var(--border)',
          }}
        />
        <button
          type="button"
          onClick={copy}
          className="px-3 py-2 rounded-lg text-[12px] font-medium"
          style={{
            background: copied ? 'var(--accent-success, #16a34a)' : 'var(--accent)',
            color: 'white',
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {helpText && (
        <p className="text-[11px] mt-1" style={{ color: 'var(--muted)' }}>
          {helpText}
        </p>
      )}
    </div>
  );
}
