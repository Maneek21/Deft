import type { AppRunState, ModuleAppRunOutcome } from './app-actions';

export type AppRunPresentation = Readonly<{
  label: string;
  detail: string;
  tone: 'neutral' | 'active' | 'success' | 'danger' | 'warning';
}>;

type OutcomeFacts = Pick<
  ModuleAppRunOutcome,
  'state' | 'environment' | 'providerCallAttempted' | 'outcomeSuccess'
>;

export function appRunPresentation(facts: OutcomeFacts): AppRunPresentation {
  const sandbox = facts.environment === 'sandbox';
  const state: AppRunState = facts.state;
  if (state === 'pending') return {
    label: sandbox ? 'Sandbox queued' : 'Execution queued',
    detail: 'The governed action is queued.',
    tone: 'active',
  };
  if (state === 'pending_approval') return {
    label: 'Awaiting approval',
    detail: 'The action has been submitted and still needs review.',
    tone: 'warning',
  };
  if (state === 'running' || state === 'waiting_external') return {
    label: sandbox ? 'Sandbox running' : 'Execution running',
    detail: facts.providerCallAttempted
      ? 'The provider call has started.'
      : 'Deft is preparing the governed provider call.',
    tone: 'active',
  };
  if (state === 'succeeded' && facts.outcomeSuccess !== false) return {
    label: sandbox ? 'Sandbox accepted' : 'Execution succeeded',
    detail: sandbox
      ? 'Accepted by the sandbox. No external message was delivered.'
      : 'The provider reported a successful execution.',
    tone: 'success',
  };
  if (state === 'unknown_outcome') return {
    label: 'Outcome unknown',
    detail: 'Deft cannot confirm the provider outcome. Review receipts before retrying.',
    tone: 'warning',
  };
  if (state === 'cancelled') return {
    label: 'Cancelled',
    detail: 'The action was cancelled.',
    tone: 'neutral',
  };
  if (state === 'expired') return {
    label: 'Expired',
    detail: 'The action expired before completion.',
    tone: 'neutral',
  };
  if (state === 'failed' || facts.outcomeSuccess === false) return {
    label: sandbox ? 'Sandbox failed' : 'Execution failed',
    detail: facts.providerCallAttempted
      ? 'The provider call failed.'
      : 'The action failed before a provider call was confirmed.',
    tone: 'danger',
  };
  return { label: 'Execution status unavailable', detail: 'Deft cannot display this execution state.', tone: 'neutral' };
}
