import { createHash } from 'node:crypto';
import {
  SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT,
  SandboxEmailSendInputSchema,
  type SandboxEmailSendInput,
} from '@deft/app-kit';

export const PHASE4_SANDBOX_EMAIL_PROVIDER = Object.freeze({
  provider_kind: 'mcp' as const,
  provider_instance_id: 'phase4-sandbox-email',
  operation_name: 'send_email',
  effect_class: 'network' as const,
  input_schema: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.input_schema,
  output_schema: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.output_schema,
});

/**
 * Deterministic future Phase 5 test double. Merely constructing it has no
 * effect; every Phase 4 compound proof must assert callCount remains zero.
 */
export class Phase4SandboxEmailProvider {
  private readonly effects: Array<Readonly<SandboxEmailSendInput & {
    message_id: string;
    status: 'accepted';
  }>> = [];

  get callCount(): number {
    return this.effects.length;
  }

  async invoke(inputValue: SandboxEmailSendInput) {
    const input = SandboxEmailSendInputSchema.parse(inputValue);
    const messageId = `sandbox_${createHash('sha256')
      .update(`${input.to}\u0000${input.subject}\u0000${input.body_text}\u0000${input.idempotency_key}`)
      .digest('hex')
      .slice(0, 24)}`;
    const prior = this.effects.find((effect) => effect.idempotency_key === input.idempotency_key);
    if (prior) {
      if (
        prior.to !== input.to
        || prior.subject !== input.subject
        || prior.body_text !== input.body_text
      ) {
        throw new Error('Sandbox email idempotency key was reused with different input');
      }
      return prior;
    }
    const effect = Object.freeze({ ...input, message_id: messageId, status: 'accepted' as const });
    this.effects.push(effect);
    return effect;
  }
}
