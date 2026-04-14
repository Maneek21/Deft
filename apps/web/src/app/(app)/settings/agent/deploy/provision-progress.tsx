'use client';

/**
 * Phase 8 — Wizard step 5: Provisioning progress.
 *
 * Shows a live status line while the deploy-provision worker builds the
 * OpenClaw container on the chosen provider. UI polls GET /status every 2s.
 */
export function ProvisionProgress({
  status,
  connectionUrl,
  connectionError,
  provider,
}: {
  status: string;
  connectionUrl: string | null;
  connectionError: string | null;
  provider: string;
}) {
  const isError = status === 'error';
  const isConnected = status === 'connected';
  return (
    <div>
      <h3
        className="text-[16px] font-semibold mb-3"
        style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
      >
        5. Provisioning
      </h3>
      <div
        className="p-4 rounded-lg"
        style={{
          background: 'var(--card-bg)',
          border: `1px solid ${isError ? '#ef4444' : isConnected ? '#10b981' : 'var(--border)'}`,
        }}
      >
        <div className="flex items-center gap-3 mb-2">
          {!isConnected && !isError && (
            <div
              className="w-4 h-4 rounded-full border-2 animate-spin"
              style={{
                borderColor: 'var(--accent)',
                borderTopColor: 'transparent',
              }}
            />
          )}
          {isConnected && (
            <div
              className="w-4 h-4 rounded-full flex items-center justify-center text-white text-[10px]"
              style={{ background: '#10b981' }}
            >
              ✓
            </div>
          )}
          {isError && (
            <div
              className="w-4 h-4 rounded-full flex items-center justify-center text-white text-[10px]"
              style={{ background: '#ef4444' }}
            >
              !
            </div>
          )}
          <p className="text-[13px]" style={{ color: 'var(--foreground)' }}>
            {provider === 'railway'
              ? isConnected
                ? 'Railway service deployed'
                : isError
                ? 'Railway provisioning failed'
                : 'Building OpenClaw container on Railway...'
              : isConnected
              ? 'BYO URL registered'
              : isError
              ? 'Provisioning failed'
              : 'Registering BYO connection...'}
          </p>
        </div>
        {connectionUrl && (
          <p className="text-[11px] font-mono" style={{ color: 'var(--muted)' }}>
            {connectionUrl}
          </p>
        )}
        {connectionError && (
          <p className="text-[11px] mt-2" style={{ color: '#ef4444' }}>
            {connectionError}
          </p>
        )}
      </div>
    </div>
  );
}
