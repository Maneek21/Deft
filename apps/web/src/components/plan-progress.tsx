'use client';

type PlanStep = {
  id: string;
  description: string;
  tool: string;
  status: string; // pending, running, completed, failed, skipped, waiting_approval
  result?: any;
  error?: string;
};

type PlanProgressProps = {
  plan: {
    id: string;
    title: string;
    steps: PlanStep[];
    status: string; // executing, paused, completed, failed
  };
  onApproveStep?: (stepId: string) => void;
  onPause?: () => void;
  onResume?: () => void;
  onAbort?: () => void;
  resumeCountdown?: number; // seconds remaining for auto-resume
};

function StepStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'running':
      return (
        <span
          style={{
            color: '#3b82f6',
            display: 'inline-flex',
            animation: 'plan-pulse 1.5s ease-in-out infinite',
          }}
        >
          ⟳
        </span>
      );
    case 'completed':
      return <span style={{ color: '#22c55e' }}>✓</span>;
    case 'failed':
      return <span style={{ color: '#ef4444' }}>✗</span>;
    case 'skipped':
      return <span style={{ color: '#6b7280' }}>↷</span>;
    case 'waiting_approval':
      return <span style={{ color: '#f59e0b' }}>⏸</span>;
    default:
      return <span style={{ color: '#6b7280' }}>○</span>;
  }
}

function summarizeResult(result: any): string {
  if (!result) return '';
  if (typeof result === 'string') return result.length > 100 ? result.slice(0, 100) + '...' : result;
  if (result.summary) return String(result.summary);
  if (result.message) return String(result.message);
  return '';
}

export default function PlanProgress({
  plan,
  onApproveStep,
  onPause,
  onResume,
  onAbort,
  resumeCountdown,
}: PlanProgressProps) {
  const completedCount = plan.steps.filter((s) => s.status === 'completed').length;
  const totalCount = plan.steps.length;

  return (
    <div
      style={{
        background: 'var(--surface-container)',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        padding: '14px 16px',
        maxWidth: '520px',
        width: '100%',
      }}
    >
      {/* Pulse animation for running icon */}
      <style>{`
        @keyframes plan-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>

      {/* Header */}
      <div style={{ marginBottom: '10px' }}>
        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--foreground)' }}>
          {plan.title}
        </span>
      </div>

      {/* Step list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px' }}>
        {plan.steps.map((step, index) => (
          <div key={step.id}>
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '8px',
                fontSize: '12.5px',
                lineHeight: 1.5,
              }}
            >
              <span style={{ flexShrink: 0, width: '20px', textAlign: 'right', color: 'var(--muted)', fontSize: '12px' }}>
                {index + 1}.
              </span>
              <span style={{ flexShrink: 0, lineHeight: 1.5 }}>
                <StepStatusIcon status={step.status} />
              </span>
              <span
                style={{
                  flex: 1,
                  color: step.status === 'skipped' ? 'var(--muted)' : 'var(--foreground)',
                  textDecoration: step.status === 'skipped' ? 'line-through' : undefined,
                }}
              >
                {step.description}
              </span>
            </div>

            {/* Result summary for completed steps */}
            {step.status === 'completed' && step.result && (
              <div
                style={{
                  marginLeft: '48px',
                  fontSize: '11.5px',
                  color: '#22c55e',
                  lineHeight: 1.4,
                  marginTop: '2px',
                }}
              >
                {summarizeResult(step.result)}
              </div>
            )}

            {/* Error message for failed steps */}
            {step.status === 'failed' && step.error && (
              <div
                style={{
                  marginLeft: '48px',
                  fontSize: '11.5px',
                  color: '#ef4444',
                  lineHeight: 1.4,
                  marginTop: '2px',
                }}
              >
                {step.error}
              </div>
            )}

            {/* Approve/Reject for waiting_approval steps */}
            {step.status === 'waiting_approval' && onApproveStep && (
              <div style={{ marginLeft: '48px', marginTop: '4px', display: 'flex', gap: '6px' }}>
                <button
                  onClick={() => onApproveStep(step.id)}
                  style={{
                    padding: '3px 10px',
                    fontSize: '11.5px',
                    fontWeight: 600,
                    borderRadius: '5px',
                    border: 'none',
                    cursor: 'pointer',
                    backgroundColor: '#22c55e',
                    color: '#fff',
                  }}
                >
                  Approve
                </button>
                <button
                  onClick={() => onAbort?.()}
                  style={{
                    padding: '3px 10px',
                    fontSize: '11.5px',
                    fontWeight: 500,
                    borderRadius: '5px',
                    border: '1px solid var(--border)',
                    cursor: 'pointer',
                    backgroundColor: 'transparent',
                    color: 'var(--muted)',
                  }}
                >
                  Reject
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Auto-resume countdown */}
      {resumeCountdown != null && resumeCountdown > 0 && plan.status === 'paused' && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            fontSize: '12px',
            color: '#f59e0b',
            marginBottom: '10px',
          }}
        >
          <span>Resuming in {resumeCountdown}s...</span>
          {onPause && (
            <button
              onClick={onPause}
              style={{
                padding: '2px 8px',
                fontSize: '11px',
                fontWeight: 500,
                borderRadius: '5px',
                border: '1px solid var(--border)',
                cursor: 'pointer',
                backgroundColor: 'transparent',
                color: 'var(--muted)',
              }}
            >
              Pause
            </button>
          )}
        </div>
      )}

      {/* Status footer */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: '12px',
          paddingTop: '8px',
          borderTop: '1px solid var(--border)',
        }}
      >
        {plan.status === 'executing' && (
          <>
            <span style={{ color: '#3b82f6', fontWeight: 500 }}>Running...</span>
            {onAbort && (
              <button
                onClick={onAbort}
                style={{
                  padding: '3px 10px',
                  fontSize: '11.5px',
                  fontWeight: 500,
                  borderRadius: '5px',
                  border: '1px solid var(--border)',
                  cursor: 'pointer',
                  backgroundColor: 'transparent',
                  color: '#ef4444',
                }}
              >
                Abort
              </button>
            )}
          </>
        )}

        {plan.status === 'paused' && !(resumeCountdown != null && resumeCountdown > 0) && (
          <>
            <span style={{ color: '#f59e0b', fontWeight: 500 }}>Paused</span>
            {onResume && (
              <button
                onClick={onResume}
                style={{
                  padding: '3px 10px',
                  fontSize: '11.5px',
                  fontWeight: 600,
                  borderRadius: '5px',
                  border: 'none',
                  cursor: 'pointer',
                  backgroundColor: '#3b82f6',
                  color: '#fff',
                }}
              >
                Resume
              </button>
            )}
          </>
        )}

        {plan.status === 'completed' && (
          <span style={{ color: '#22c55e', fontWeight: 500 }}>
            Plan complete — {completedCount}/{totalCount} steps succeeded
          </span>
        )}

        {plan.status === 'failed' && (
          <span style={{ color: '#ef4444', fontWeight: 500 }}>
            Plan failed — {completedCount}/{totalCount} steps succeeded
          </span>
        )}
      </div>
    </div>
  );
}
