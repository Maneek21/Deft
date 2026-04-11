'use client';

type PlanStep = {
  id: string;
  description: string;
  tool: string;
  is_write?: boolean;
  condition?: { step_id: string; on_false: string };
  status: string;
};

type PlanApprovalProps = {
  plan: {
    id: string;
    title: string;
    description?: string;
    steps: PlanStep[];
  };
  onApprove: () => void;
  onReject: () => void;
};

function StepStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return <span style={{ color: '#22c55e' }}>✓</span>;
    case 'failed':
      return <span style={{ color: '#ef4444' }}>✗</span>;
    case 'waiting_approval':
      return <span style={{ color: '#f59e0b' }}>⏸</span>;
    default:
      return <span style={{ color: '#6b7280' }}>○</span>;
  }
}

function ToolBadge({ isWrite }: { isWrite?: boolean }) {
  if (isWrite) {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          fontSize: '11px',
          fontWeight: 500,
          padding: '1px 6px',
          borderRadius: '4px',
          backgroundColor: 'rgba(245, 158, 11, 0.15)',
          color: '#f59e0b',
          whiteSpace: 'nowrap',
        }}
      >
        write — needs approval
      </span>
    );
  }
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        fontSize: '11px',
        fontWeight: 500,
        padding: '1px 6px',
        borderRadius: '4px',
        backgroundColor: 'rgba(107, 114, 128, 0.15)',
        color: '#6b7280',
        whiteSpace: 'nowrap',
      }}
    >
      read
    </span>
  );
}

export default function PlanApproval({ plan, onApprove, onReject }: PlanApprovalProps) {
  // Build a map of step id -> step index for condition display
  const stepIndexMap = new Map<string, number>();
  plan.steps.forEach((step, i) => {
    stepIndexMap.set(step.id, i + 1);
  });

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
      {/* Header */}
      <div style={{ marginBottom: '10px' }}>
        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--foreground)' }}>
          Plan — &ldquo;{plan.title}&rdquo; ({plan.steps.length} step{plan.steps.length !== 1 ? 's' : ''})
        </span>
        {plan.description && (
          <p style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '4px', lineHeight: 1.4 }}>
            {plan.description}
          </p>
        )}
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
              <span style={{ flex: 1, color: 'var(--foreground)' }}>
                {step.description}
              </span>
              <span style={{ flexShrink: 0 }}>
                <ToolBadge isWrite={step.is_write} />
              </span>
            </div>
            {step.condition && (
              <div
                style={{
                  marginLeft: '48px',
                  fontSize: '11.5px',
                  color: 'var(--muted)',
                  lineHeight: 1.4,
                }}
              >
                ↳ Condition: if step {stepIndexMap.get(step.condition.step_id) ?? '?'} {step.condition.on_false}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          onClick={onApprove}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '6px 14px',
            fontSize: '12.5px',
            fontWeight: 600,
            borderRadius: '6px',
            border: 'none',
            cursor: 'pointer',
            backgroundColor: '#22c55e',
            color: '#fff',
            transition: 'opacity 0.15s',
          }}
          onMouseEnter={(e) => { (e.target as HTMLButtonElement).style.opacity = '0.85'; }}
          onMouseLeave={(e) => { (e.target as HTMLButtonElement).style.opacity = '1'; }}
        >
          Approve &amp; Execute
        </button>
        <button
          onClick={onReject}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '6px 14px',
            fontSize: '12.5px',
            fontWeight: 500,
            borderRadius: '6px',
            border: '1px solid var(--border)',
            cursor: 'pointer',
            backgroundColor: 'transparent',
            color: 'var(--muted)',
            transition: 'opacity 0.15s',
          }}
          onMouseEnter={(e) => { (e.target as HTMLButtonElement).style.opacity = '0.7'; }}
          onMouseLeave={(e) => { (e.target as HTMLButtonElement).style.opacity = '1'; }}
        >
          Reject
        </button>
      </div>
    </div>
  );
}
