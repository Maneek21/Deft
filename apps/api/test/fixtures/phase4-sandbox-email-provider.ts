import { createHash } from 'node:crypto';

export const PHASE4_SANDBOX_EMAIL_PROVIDER = Object.freeze({
  provider_kind: 'mcp' as const,
  provider_instance_id: 'phase4-sandbox-email',
  operation_name: 'send_campaign',
  effect_class: 'network' as const,
  input_schema: Object.freeze({
    type: 'object' as const,
    additionalProperties: false,
    required: ['campaign_id', 'idempotency_key'],
    properties: Object.freeze({
      campaign_id: Object.freeze({ type: 'string' as const }),
      idempotency_key: Object.freeze({ type: 'string' as const }),
    }),
  }),
});

export type Phase4SandboxEmailInput = Readonly<{
  campaign_id: string;
  idempotency_key: string;
}>;

/**
 * Deterministic future Phase 5 test double. Merely constructing it has no
 * effect; every Phase 4 compound proof must assert callCount remains zero.
 */
export class Phase4SandboxEmailProvider {
  private readonly effects: Array<Readonly<{
    campaign_id: string;
    idempotency_key: string;
    message_id: string;
  }>> = [];

  get callCount(): number {
    return this.effects.length;
  }

  async invoke(input: Phase4SandboxEmailInput) {
    const messageId = `sandbox_${createHash('sha256')
      .update(`${input.campaign_id}\u0000${input.idempotency_key}`)
      .digest('hex')
      .slice(0, 24)}`;
    const prior = this.effects.find((effect) => effect.idempotency_key === input.idempotency_key);
    if (prior) return prior;
    const effect = Object.freeze({ ...input, message_id: messageId });
    this.effects.push(effect);
    return effect;
  }
}
