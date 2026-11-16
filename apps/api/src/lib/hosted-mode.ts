/**
 * Hosted mode: this install is one customer's cell on the hosted Deft service.
 * It is on only when DEFT_HOSTED is exactly "true". Hosted-only rules fail
 * closed: with hosted mode on, a missing hosted setting refuses the request;
 * it never falls back to the self-hosted behaviour.
 */
export function isHostedMode(): boolean {
  return process.env.DEFT_HOSTED === 'true';
}
