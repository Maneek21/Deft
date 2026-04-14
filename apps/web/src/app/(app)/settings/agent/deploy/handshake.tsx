'use client';

/**
 * Phase 8 — Wizard step 6: Handshake test.
 *
 * Hits POST /api/agents/deploy/:id/handshake which in turn calls the
 * Gateway's /v1/models endpoint to verify OpenClaw recognizes the employee.
 */
export function Handshake({
  status,
  error,
  models,
  onRetry,
}: {
  status: 'pending' | 'running' | 'success' | 'failed';
  error: string | null;
  models: string[];
  onRetry: () => void;
}) {
  return (
    <div>
      <h3
        className="text-[16px] font-semibold mb-3"
        style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
      >
        6. Handshake test
      </h3>
      <p className="text-[12px] mb-4" style={{ color: 'var(--muted)' }}>
        Deft pings your Gateway's <code>/v1/models</code> endpoint to verify
        OpenClaw responds with your employee slug in its model list.
      </p>
      <div
        className="p-4 rounded-lg"
        style={{
          background: 'var(--card-bg)',
          border: `1px solid ${
            status === 'success' ? '#10b981' : status === 'failed' ? '#ef4444' : 'var(--border)'
          }`,
        }}
      >
        {status === 'running' && (
          <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
            Running handshake...
          </p>
        )}
        {status === 'success' && (
          <div>
            <p className="text-[13px]" style={{ color: '#10b981' }}>
              Handshake succeeded
            </p>
            {models.length > 0 && (
              <p className="text-[11px] mt-1 font-mono" style={{ color: 'var(--muted)' }}>
                Models: {models.join(', ')}
              </p>
            )}
          </div>
        )}
        {status === 'failed' && (
          <div>
            <p className="text-[13px]" style={{ color: '#ef4444' }}>
              Handshake failed: {error ?? 'unknown error'}
            </p>
            <button
              type="button"
              onClick={onRetry}
              className="mt-2 px-3 py-1 rounded text-[12px]"
              style={{ background: 'var(--accent)', color: 'white' }}
            >
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
