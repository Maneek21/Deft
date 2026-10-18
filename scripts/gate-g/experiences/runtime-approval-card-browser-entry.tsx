import { AgentActionCard, type AgentAction } from '../../../apps/web/src/components/agent-action-card';
import { createRoot } from 'react-dom/client';

const action: AgentAction = {
  id: 'approval-one', action: 'app_run_invoke', source: 'app_run',
  approval_status: 'pending',
  params: {
    run_id: 'run-one', capability_label: 'create_label',
    provider_label: 'opaque-registration',
    safe_preview: {
      title: 'Create shipping label',
      summary: 'One reviewed external write',
      fields: { app_installation_id: 'install-one', action_key: 'create_label',
        runtime_binding_id: 'binding-one', provider_kind: 'app_runtime' },
      resource_refs: [],
    },
  },
};

createRoot(document.getElementById('root')!).render(
  <AgentActionCard action={action} onApprove={async () => ({ status: 'approved' })}
    onReject={async () => ({ status: 'rejected' })} />,
);
