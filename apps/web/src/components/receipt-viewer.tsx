'use client';
/**
 * Phase 7 — ReceiptViewer modal.
 *
 * Opens when a user clicks "View receipt" on an action log row in the
 * Settings → Agent page. Fetches the signed receipt from
 * `GET /api/agent/actions/:id/receipt`, recomputes the HMAC server-side
 * (the endpoint returns `verified: boolean`), and renders the full
 * envelope + a green/red verification pill. "Copy as JSON" exports the
 * complete receipt payload so compliance teams can paste it into a ticket.
 *
 * The modal is intentionally read-only — receipts are an audit overlay
 * and must never be editable from this surface. PDF export lands in v1.1.
 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

type Receipt = {
  id: string;
  org_id: string;
  action_id: string;
  employee_id: string | null;
  proposer: 'defty' | 'employee' | 'user' | 'cron';
  proposer_id: string | null;
  proposer_name: string | null;
  approver_id: string | null;
  approver_name: string | null;
  decision: 'auto_executed' | 'approved' | 'rejected' | 'expired';
  decision_reason: string | null;
  action_name: string;
  action_params_json: unknown;
  result_json: unknown;
  signature_hmac: string;
  signed_at: string;
  created_at: string;
  updated_at: string;
};

type Props = {
  actionId: string;
  isOpen: boolean;
  onClose: () => void;
};

const DECISION_STYLES: Record<
  Receipt['decision'],
  { bg: string; fg: string; label: string }
> = {
  auto_executed: { bg: 'rgba(59, 130, 246, 0.15)', fg: '#3b82f6', label: 'Auto-executed' },
  approved: { bg: 'rgba(16, 185, 129, 0.15)', fg: '#10b981', label: 'Approved' },
  rejected: { bg: 'rgba(239, 68, 68, 0.15)', fg: '#ef4444', label: 'Rejected' },
  expired: { bg: 'rgba(148, 163, 184, 0.15)', fg: '#94a3b8', label: 'Expired' },
};

export function ReceiptViewer({ actionId, isOpen, onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [verified, setVerified] = useState<boolean | null>(null);
  const [showParams, setShowParams] = useState(true);
  const [showResult, setShowResult] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setReceipt(null);
    setVerified(null);
    (async () => {
      try {
        const res = await api.get(`/api/agent/actions/${actionId}/receipt`);
        if (cancelled) return;
        if (res.status === 404) {
          setError('No receipt has been generated for this action.');
          setLoading(false);
          return;
        }
        if (res.status === 403) {
          setError('You do not have access to this receipt.');
          setLoading(false);
          return;
        }
        if (!res.ok) {
          setError(`Failed to load receipt (${res.status})`);
          setLoading(false);
          return;
        }
        const body = await res.json();
        setReceipt(body.receipt as Receipt);
        setVerified(Boolean(body.verified));
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unexpected error');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, actionId]);

  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    if (isOpen) {
      window.addEventListener('keydown', handleEscape);
      return () => window.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const copyAsJson = async () => {
    if (!receipt) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify({ receipt, verified }, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  const decisionStyle = receipt
    ? DECISION_STYLES[receipt.decision] ?? DECISION_STYLES.auto_executed
    : null;

  return (
    <div
      data-testid="receipt-viewer-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-lg"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="px-5 py-4 flex items-center justify-between sticky top-0 z-10"
          style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}
        >
          <h2
            className="text-[15px] font-semibold"
            style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
          >
            Signed Audit Receipt
          </h2>
          <button
            onClick={onClose}
            className="text-[18px] leading-none"
            style={{ color: 'var(--muted)' }}
            aria-label="Close"
            data-testid="receipt-close"
          >
            ×
          </button>
        </div>

        {loading && (
          <div className="p-6 text-[13px]" style={{ color: 'var(--muted)' }}>
            Loading receipt...
          </div>
        )}

        {error && (
          <div className="p-6 text-[13px]" style={{ color: 'var(--muted)' }} data-testid="receipt-error">
            {error}
          </div>
        )}

        {receipt && decisionStyle && (
          <div className="p-5 space-y-4 text-[12px]">
            <div className="flex items-center gap-3 flex-wrap">
              <span
                className="px-2 py-1 rounded font-mono"
                style={{
                  background: 'var(--card-bg)',
                  border: '1px solid var(--border)',
                  color: 'var(--foreground)',
                }}
              >
                {receipt.action_name}
              </span>
              <span
                className="px-2 py-1 rounded font-medium"
                style={{ background: decisionStyle.bg, color: decisionStyle.fg }}
              >
                {decisionStyle.label}
              </span>
              <span
                className="px-2 py-1 rounded font-medium"
                data-testid="receipt-verified-pill"
                style={{
                  background: verified ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                  color: verified ? '#10b981' : '#ef4444',
                }}
              >
                {verified ? 'Verified' : 'Tampered'}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <MetaField label="Proposer">
                <span style={{ color: 'var(--foreground)' }}>
                  {receipt.proposer_name ?? receipt.proposer}
                  <span className="ml-1" style={{ color: 'var(--muted)' }}>({receipt.proposer})</span>
                </span>
              </MetaField>
              <MetaField label="Approver">
                <span style={{ color: 'var(--foreground)' }}>
                  {receipt.approver_name ?? (receipt.approver_id ? 'unknown user' : '—')}
                </span>
              </MetaField>
              <MetaField label="Signed at">
                <span style={{ color: 'var(--foreground)' }}>
                  {new Date(receipt.signed_at).toLocaleString()}
                </span>
              </MetaField>
              <MetaField label="Action ID">
                <span className="font-mono text-[11px]" style={{ color: 'var(--foreground)' }}>
                  {receipt.action_id.slice(0, 12)}...
                </span>
              </MetaField>
            </div>

            {receipt.decision_reason && (
              <MetaField label="Decision reason">
                <span style={{ color: 'var(--foreground)' }}>{receipt.decision_reason}</span>
              </MetaField>
            )}

            <Collapsible
              label="Params"
              open={showParams}
              onToggle={() => setShowParams((v) => !v)}
            >
              <pre
                data-testid="receipt-params"
                className="text-[11px] font-mono p-3 rounded overflow-auto max-h-64"
                style={{ background: 'var(--card-bg)', color: 'var(--foreground)' }}
              >
                {JSON.stringify(receipt.action_params_json, null, 2)}
              </pre>
            </Collapsible>

            {receipt.result_json != null && (
              <Collapsible
                label="Result"
                open={showResult}
                onToggle={() => setShowResult((v) => !v)}
              >
                <pre
                  className="text-[11px] font-mono p-3 rounded overflow-auto max-h-64"
                  style={{ background: 'var(--card-bg)', color: 'var(--foreground)' }}
                >
                  {JSON.stringify(receipt.result_json, null, 2)}
                </pre>
              </Collapsible>
            )}

            <MetaField label="Signature (HMAC-SHA256)">
              <span
                className="font-mono text-[11px] break-all"
                data-testid="receipt-signature"
                style={{ color: 'var(--foreground)' }}
              >
                {receipt.signature_hmac}
              </span>
            </MetaField>

            <div className="pt-2 flex items-center gap-2">
              <button
                onClick={copyAsJson}
                data-testid="receipt-copy-json"
                className="px-3 py-1.5 text-[11px] rounded font-medium"
                style={{
                  background: 'var(--accent)',
                  color: 'white',
                  border: 'none',
                }}
              >
                {copied ? 'Copied!' : 'Copy as JSON'}
              </button>
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-[11px] rounded"
                style={{
                  background: 'var(--surface-container)',
                  color: 'var(--foreground-secondary)',
                  border: '1px solid var(--border)',
                }}
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MetaField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        className="text-[10px] uppercase tracking-wide mb-1"
        style={{ color: 'var(--muted)' }}
      >
        {label}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Collapsible({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="text-[11px] font-medium mb-1 flex items-center gap-1"
        style={{ color: 'var(--foreground-secondary)' }}
      >
        <span>{open ? '▾' : '▸'}</span>
        {label}
      </button>
      {open && children}
    </div>
  );
}
